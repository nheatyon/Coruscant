import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createConfig } from '../dist/node/server/config.js';
import { openDatabase } from '../dist/node/server/db/database.js';
import { migrate } from '../dist/node/server/db/migrate.js';
import { initialize } from '../dist/node/server/db/initialize.js';
import { buildApp } from '../dist/node/server/app.js';
import { emptyDiscoveryValues } from '../dist/node/shared/discovery.js';

// Reuse only this build's explicit fresh acquisition. No provider calls or recording-DB reads.
const ledgerPath = process.argv[2];
assert.ok(ledgerPath, 'Supply the absolute fresh acquisition ledger path.');
const ledgerBytes = readFileSync(ledgerPath), ledger = JSON.parse(ledgerBytes), acquisitionRoot = dirname(ledgerPath);
const temporary = mkdtempSync(join(tmpdir(), 'coruscant-s8-performance-')), orbital = join(temporary, 'orbital');
mkdirSync(orbital, { mode: 0o700 });
for (const entry of Object.values(ledger.groups)) {
  assert.match(entry.rawFile, /^[a-f0-9]{64}\.json$/);
  const bytes = readFileSync(join(acquisitionRoot, entry.rawFile));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  writeFileSync(join(orbital, entry.rawFile), bytes, { mode: 0o600 });
}
writeFileSync(join(orbital, 'initial-acquisition.json'), ledgerBytes, { mode: 0o600 });
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise((yes, no) => socket.close(error => error ? no(error) : yes()));
const config = createConfig({ dataRoot: temporary, port }), db = openDatabase(config);
migrate(db); initialize(db, config); db.close();
let app;
try {
  const startup = performance.now(); app = await buildApp({ dataRoot: temporary, port });
  const adoptMs = performance.now() - startup; await app.listen({ host: '127.0.0.1', port });
  const origin = config.origin, get = async path => { const response = await fetch(origin + path); assert.equal(response.status, 200); return response.json(); };
  const catalog = await get('/api/public/real-catalog'); assert.equal(catalog.availability, 'READY');
  const initial = await fetch(origin + '/api/demo/bootstrap', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(initial.status, 200); const context = await initial.json(), cookie = initial.headers.get('set-cookie').split(';')[0];
  const input = { snapshotVersion: catalog.snapshotVersion, factVersion: catalog.factVersion, representedAt: catalog.serverNow,
    generation: 1, criteria: emptyDiscoveryValues(), selectedId: 'norad:62261', shortlistedIds: ['norad:66315'], visibility: 'MATCHES',
    contextGeneration: context.contextGeneration, contextToken: context.contextToken };
  const post = async value => {
    const response = await fetch(origin + '/api/orbital-browse', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', 'x-coruscant-csrf': context.csrfToken }, body: JSON.stringify(value) });
    assert.equal(response.status, 200, await response.clone().text()); const bytes = Buffer.byteLength(await response.clone().text());
    assert.ok(bytes <= 256 * 1024); return { value: await response.json(), bytes };
  };
  let finished = false; const started = performance.now(), ordinary = [];
  const firstPromise = post(input).finally(() => { finished = true; });
  while (!finished) {
    await pause(1); const begin = performance.now(); await get('/api/public/catalog'); ordinary.push(performance.now() - begin);
  }
  const first = await firstPromise, firstPageMs = performance.now() - started;
  let page = first.value, pages = 1, bytes = first.bytes, objects = [...page.objects];
  while (page.nextCursor) { const next = await post({ ...input, cursor: page.nextCursor }); page = next.value; pages++; bytes += next.bytes; objects.push(...page.objects); }
  const browseTotalMs = performance.now() - started;
  assert.equal(new Set(objects.map(value => value.id)).size, objects.length);
  const sar = { ...emptyDiscoveryValues(), family: 'EO', sensor: 'SAR', maxResolutionM: 10 };
  const query = value => '/api/public/real-catalog?' + new URLSearchParams({ criteria: JSON.stringify(value) });
  const relaxed = await get(query(sar)), strict = await get(query({ ...sar, documentedOnly: true }));
  const documentedSar = await get(query({ ...sar, maxResolutionM: null, documentedOnly: true }));
  console.log(JSON.stringify({ outcome: 'PASS', sourceSnapshot: catalog.snapshotVersion, sources: catalog.sources,
    counts: catalog.counts, matching: { sarMax10StrictOff: relaxed.counts.matching, sarMax10StrictOn: strict.counts.matching,
      sarWithoutResolutionStrictOn: documentedSar.counts.matching },
    browse: { representedAt: input.representedAt, state: first.value.state, counts: first.value.counts, pages,
      returnedObjects: objects.length, totalResponseBytes: bytes, firstPageMs: Math.round(firstPageMs), totalMs: Math.round(browseTotalMs) },
    adoptionMs: Math.round(adoptMs), concurrentOrdinaryRequests: ordinary.length,
    ordinaryMaxMs: Math.round(Math.max(0, ...ordinary)), ordinaryMedianMs: Math.round([...ordinary].sort((a, b) => a - b)[Math.floor(ordinary.length / 2)] ?? 0),
    boundary: 'Actual fresh source bytes, isolated temporary application/DB, no provider calls or workflow records. Latency is an observed local sample, not a guaranteed service level.' }, null, 2));
} finally { if (app) await app.close(); rmSync(temporary, { recursive: true, force: true }); }
