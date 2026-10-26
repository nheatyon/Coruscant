import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../dist/node/server/config.js';
import { openDatabase } from '../dist/node/server/db/database.js';
import { migrate } from '../dist/node/server/db/migrate.js';
import { initialize } from '../dist/node/server/db/initialize.js';
import { areaSignature, createEmptyBrief } from '../dist/node/shared/validation.js';
import { ORBITAL_SOURCE_URLS, ORBITAL_LIMITS } from '../dist/node/shared/orbital-policy.js';

// Explicit fresh acquisition only. Never copy the recording DB, cookies, contact data,
// keys, workflow records, old fixtures or upstream source. No provider request is made.
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = process.argv[2];
assert.ok(ledgerPath && isAbsolute(ledgerPath), 'Supply the absolute fresh-acquisition ledger path.');
const sourceRoot = dirname(ledgerPath), ledgerBytes = readFileSync(ledgerPath);
assert.ok(ledgerBytes.length <= 64 * 1024, 'Acquisition ledger exceeds the reviewed metadata bound.');
const ledger = JSON.parse(ledgerBytes.toString('utf8'));
assert.equal(ledger.schema, 1); assert.ok(ledger.groups);
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}` : JSON.stringify(value);
const frozen = row => ({ id: row.id, reference: row.reference, organizationId: row.organizationId, status: row.status,
  requestVersion: row.requestVersion, briefRevision: row.briefRevision, submittedAt: row.submittedAt,
  brief: row.brief, evidence: row.evidence, history: row.history, revisions: row.revisions });
const recordDigest = row => hash(canonical(frozen(row)));
const temporary = mkdtempSync(join(tmpdir(), 'coruscant-actual-orbit-persistence-'));
const dataRoot = join(temporary, 'isolated-data'), orbital = join(dataRoot, 'orbital'), otherCwd = join(temporary, 'another-cwd');
let child = null;
async function stop() {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exiting = once(child, 'exit'); let timer;
  child.kill('SIGTERM');
  try { await Promise.race([exiting, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Isolated server did not stop gracefully.')); }, 5000); })]); }
  catch (error) { await exiting; throw error; }
  finally { clearTimeout(timer); }
}
try {
  mkdirSync(orbital, { recursive: true, mode: 0o700 }); mkdirSync(otherCwd, { mode: 0o700 });
  const hashes = {};
  for (const group of ['sar', 'resource']) {
    const entry = ledger.groups[group]; assert.ok(entry); assert.equal(entry.url, ORBITAL_SOURCE_URLS[group]);
    assert.equal(entry.status, 'success'); assert.equal(entry.httpStatus, 200); assert.match(entry.rawFile, /^[a-f0-9]{64}\.json$/);
    assert.equal(entry.rawFile, `${entry.sha256}.json`);
    const source = join(sourceRoot, entry.rawFile); assert.ok(statSync(source).size <= ORBITAL_LIMITS.sourceBytes);
    const bytes = readFileSync(source); assert.equal(hash(bytes), entry.sha256, `${group}: source byte hash changed.`);
    hashes[group] = entry.sha256; const copy = join(orbital, entry.rawFile);
    if (existsSync(copy)) assert.equal(hash(readFileSync(copy)), entry.sha256); else writeFileSync(copy, bytes, { mode: 0o600, flag: 'wx' });
  }
  writeFileSync(join(orbital, 'initial-acquisition.json'), ledgerBytes, { mode: 0o600, flag: 'wx' });
  const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((yes, no) => socket.close(error => error ? no(error) : yes()));
  const config = createConfig({ dataRoot, port }), db = openDatabase(config);
  let d0; try { migrate(db); d0 = initialize(db, config); } finally { db.close(); }
  const origin = config.origin;
  // Keep secrets/proxy credentials out of the isolated child's environment.
  const env = { PATH: process.env.PATH ?? '', TZ: 'UTC', CORUSCANT_MODE: 'test', CORUSCANT_TEST_DATA_ROOT: dataRoot, CORUSCANT_PORT: String(port), PORT: String(port) };
  async function start() {
    child = spawn(process.execPath, [join(project, 'dist/node/server/index.js')], { cwd: otherCwd, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
    child.stderr.on('data', () => {}); // No provider bytes, cookies or generated contact are printed.
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(spawnFailed, false, 'Isolated compiled server could not start.');
      assert.equal(child.exitCode, null, 'Isolated compiled server exited before readiness.');
      try {
        const response = await fetch(`${origin}/api/public/catalog`, { signal: AbortSignal.timeout(300) });
        if (response.ok) { const value = await response.json(); assert.equal(value.demo.d0, d0); return child.pid; }
      } catch { /* Startup only; no source refresh or external retry. */ }
      await pause(30);
    }
    throw new Error('Isolated compiled server was not ready.');
  }
  class Peer {
    cookie = ''; context = null;
    async request(method, path, payload, expected = 200) {
      assert.ok(path.startsWith('/api/') && !path.startsWith('//'));
      const headers = { origin, ...(this.cookie ? { cookie: this.cookie } : {}) };
      if (method === 'POST') { headers['content-type'] = 'application/json'; if (this.context?.csrfToken) headers['x-coruscant-csrf'] = this.context.csrfToken; }
      const body = method === 'POST' ? JSON.stringify(path === '/api/demo/bootstrap' ? {} : { contextGeneration: this.context?.contextGeneration, contextToken: this.context?.contextToken, ...payload }) : undefined;
      const response = await fetch(origin + path, { method, headers, body, signal: AbortSignal.timeout(10000) });
      const value = await response.json(); assert.equal(response.status, expected, `${method} ${path} failed (${value.code ?? 'unconfirmed'}).`);
      const cookie = response.headers.get('set-cookie'); if (cookie) this.cookie = cookie.split(';')[0]; return value;
    }
    async enter(staff = false) {
      this.context = await this.request('POST', '/api/demo/bootstrap', {});
      this.context = await this.request('POST', staff ? '/api/demo/staff/enter' : '/api/demo/customer/enter', staff ? {} : { personaId: 'a-owner' });
      if (!staff) this.context = await this.request('POST', '/api/context/workspace', { organizationId: 'org-a' });
    }
    async reopen() { this.context = await this.request('GET', '/api/context'); }
    async record(id, staff = false) { return this.request('GET', staff ? `/api/staff/requests/${id}` : `/api/customer/org-a/requests/${id}`); }
    async submit(brief) {
      const command = { target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
      const review = await this.request('POST', '/api/command-reviews/submitRequest', command);
      const receipt = await this.request('POST', '/api/commands/submitRequest', { ...command, commandId: randomUUID(), reviewToken: review.reviewToken }, 201);
      return this.record(receipt.requestId);
    }
  }
  const firstPid = await start(), owner = new Peer(), staff = new Peer(); await owner.enter(); await staff.enter(true);
  const samples = await owner.request('GET', '/api/public/catalog'), catalog = await owner.request('GET', '/api/public/real-catalog');
  assert.equal(catalog.availability, 'READY'); assert.ok(catalog.counts.unique > 2, 'Verify the actual full adopted population.');
  for (const group of ['sar', 'resource']) { const source = catalog.sources.find(source => source.key === group); assert.equal(source.responseHash, hashes[group]); assert.equal(source.retrievedAt, ledger.groups[group].retrievedAt); }
  let selected = catalog.items.find(row => row.item.id === 'norad:62261')?.item;
  if (!selected) {
    const sourceRows = ['sar', 'resource'].flatMap(group => JSON.parse(readFileSync(join(orbital, ledger.groups[group].rawFile), 'utf8')));
    const present = sourceRows.some(row => String(row.NORAD_CAT_ID) === '62261');
    if (present) selected = (await owner.request('GET', `/api/public/real-catalog/norad%3A62261?snapshotVersion=${catalog.snapshotVersion}`)).item;
  }
  selected ??= catalog.items[0]?.item; assert.ok(selected, 'No actual source identity is available for evidence persistence.');
  const demo = samples.items.find(item => item.id === 'demo-sar-03'); assert.ok(demo);
  const area = { latitude: 52.6, longitude: -9.7, radiusKm: 25, method: 'coordinates', generation: 1 };
  const base = () => ({ ...createEmptyBrief(), family: 'EO', sensor: 'OPEN', outputs: ['Imagery'], latitude: '52.6', longitude: '-9.7', radiusKm: '25', areaChoice: { ...area }, areaConfirmation: areaSignature(area),
    baselineDate: samples.demo.baselineDate, recentDate: samples.demo.recentDate, acknowledged: true,
    contact: { name: 'Generated isolated verification contact', email: 'persistence-check@coruscant.example', organization: 'Generated verification team' } });
  const legacy = await owner.submit({ ...base(), purpose: 'Isolated legacy demonstration evidence persistence verification.', selectedEvidence: [{ itemId: demo.id, evidenceVersion: demo.evidenceVersion }] });
  const real = await owner.submit({ ...base(), purpose: 'Isolated persistence verification using freshly acquired public catalog evidence.', selectedEvidence: [{ itemId: selected.id, evidenceVersion: selected.evidenceVersion }],
    catalogContext: { sourceKind: 'PUBLIC_REAL', snapshotVersion: catalog.snapshotVersion, factVersion: catalog.factVersion } });
  assert.equal(legacy.brief.catalogContext, undefined); assert.equal(legacy.evidence[0].verified, true); assert.equal(legacy.evidence[0].sourceKind, undefined);
  const evidence = real.evidence[0]; assert.equal(evidence.verified, true); assert.equal(evidence.sourceKind, 'PUBLIC_REAL');
  assert.equal(evidence.itemId, selected.id); assert.equal(evidence.evidenceVersion, selected.evidenceVersion); assert.equal(evidence.snapshotVersion, catalog.snapshotVersion); assert.equal(evidence.factVersion, catalog.factVersion);
  assert.equal(hash(canonical(evidence.matchingFacts)), hash(canonical(selected))); assert.equal(evidence.orbit.sourceEpoch, selected.orbit.sourceEpoch);
  const legacyDigest = recordDigest(legacy), realDigest = recordDigest(real);
  assert.equal(recordDigest(await staff.record(legacy.id, true)), legacyDigest); assert.equal(recordDigest(await staff.record(real.id, true)), realDigest);
  await stop(); const secondPid = await start(); assert.notEqual(secondPid, firstPid, 'A new OS server process must be used.'); await owner.reopen(); await staff.reopen();
  assert.equal(recordDigest(await owner.record(legacy.id)), legacyDigest); assert.equal(recordDigest(await staff.record(legacy.id, true)), legacyDigest);
  assert.equal(recordDigest(await owner.record(real.id)), realDigest); assert.equal(recordDigest(await staff.record(real.id, true)), realDigest);
  const afterCatalog = await owner.request('GET', '/api/public/real-catalog'); assert.equal(afterCatalog.snapshotVersion, catalog.snapshotVersion);
  for (const group of ['sar', 'resource']) assert.equal(afterCatalog.sources.find(source => source.key === group).retrievedAt, ledger.groups[group].retrievedAt);
  await stop();
  function metadata() {
    const readonly = new DatabaseSync(config.databasePath, { readOnly: true });
    try {
      const counts = {};
      for (const table of ['service_requests', 'brief_revisions', 'action_receipts', 'request_events', 'quotes', 'quote_decisions', 'schedules', 'deliveries', 'observations']) counts[table] = readonly.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
      assert.equal(counts.service_requests, 2); assert.equal(counts.brief_revisions, 2); assert.equal(counts.action_receipts, 2); assert.equal(counts.request_events, 2);
      for (const table of ['quotes', 'quote_decisions', 'schedules', 'deliveries', 'observations']) assert.equal(counts[table], 0, 'No business approval, scheduling, delivery or observation is seeded.');
      return { counts, sourceState: readonly.prepare('SELECT * FROM orbital_source_state ORDER BY source_key').all(), sourceVersions: readonly.prepare('SELECT version,response_hash,retrieved_at FROM orbital_source_versions ORDER BY version').all() };
    } finally { readonly.close(); }
  }
  const beforeExport = hash(canonical(metadata())), exporter = join(project, 'scripts/export-orbital-verification-ledger.mjs');
  const exported = spawnSync(process.execPath, [exporter, dataRoot], { cwd: otherCwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(exported.status, 0, 'Read-only verification-ledger export failed.');
  const exportPath = join(orbital, 'verification-ledger.json'), exportedBytes = readFileSync(exportPath), exportedLedger = JSON.parse(exportedBytes.toString('utf8'));
  assert.equal(statSync(exportPath).mode & 0o777, 0o600); assert.equal(exportedLedger.schema, 1);
  for (const group of ['sar', 'resource']) for (const field of ['url', 'sha256', 'rawFile', 'attemptedAt', 'nextAllowedAt', 'retrievedAt', 'httpStatus', 'status']) assert.equal(exportedLedger.groups[group][field], ledger.groups[group][field], `Exported ${group} ${field} changed.`);
  assert.equal(hash(canonical(metadata())), beforeExport, 'Export must not mutate source ages or workflow records.');
  const corruptPath = join(orbital, ledger.groups.sar.rawFile), original = readFileSync(corruptPath), corrupted = Buffer.from(original); corrupted[0] ^= 1;
  writeFileSync(corruptPath, corrupted, { mode: 0o600 });
  try {
    const refused = spawnSync(process.execPath, [exporter, dataRoot], { cwd: otherCwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(refused.status, 1, 'Changed source bytes must fail the exporter hash check.');
    assert.ok(refused.stderr.includes('cached bytes changed'), 'Refusal must be caused by the changed source hash.');
    assert.equal(hash(readFileSync(exportPath)), hash(exportedBytes), 'A failed export must leave the prior ledger untouched.');
    assert.equal(hash(canonical(metadata())), beforeExport);
  } finally { writeFileSync(corruptPath, original, { mode: 0o600 }); }
  console.log(JSON.stringify({ outcome: 'PASS', sourceHashes: hashes, uniqueIdentities: catalog.counts.unique,
    selected: { id: evidence.itemId, evidenceVersion: evidence.evidenceVersion, snapshotVersion: evidence.snapshotVersion, factVersion: evidence.factVersion, sourceEpoch: evidence.orbit.sourceEpoch, orbitalHash: evidence.orbit.orbitalHash, capabilityFacts: evidence.capabilityFacts.length },
    records: { legacyDemo: 1, actualRealEvidence: 1, stages: 'Submitted only', customerStaffFrozenReads: true, legacyUnchanged: true },
    restart: 'Actual graceful OS-process restart, same isolated DB and own sessions; alternate working directory',
    verificationLedger: 'Exact hashes/original times,0600,read-only DB; corrupted-byte export refused without replacing prior ledger',
    providerRequests: 0, boundary: 'Only fresh public source bytes copied. No recording DB/cookies/records, raw-source output, workflow approvals, provider tasking or actual collection. Own temporary root removed.' }, null, 2));
} finally { try { await stop(); } finally { rmSync(temporary, { recursive: true, force: true }); } }
