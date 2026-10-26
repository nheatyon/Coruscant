import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

// Verify committed, public-safe sources. Never copy the recording database or local credentials.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'coruscant-clean-checkout-'));
const checkout = join(temporary, 'checkout'), dataRoot = join(temporary, 'isolated-data'), otherCwd = join(temporary, 'another-cwd');
for (const path of [checkout, otherCwd]) mkdirSync(path);
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const requestedRevision = process.env.CORUSCANT_VERIFY_REVISION ?? 'HEAD';
const revision = git('rev-parse', '--verify', requestedRevision);
const committed = git('cat-file', '-t', revision) === 'commit';
const archive = spawnSync('git', ['archive', '--format=tar', revision], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
assert.equal(archive.status, 0, archive.error?.message ?? archive.stderr.toString());
const extracted = spawnSync('tar', ['-xf', '-', '-C', checkout], { input: archive.stdout });
assert.equal(extracted.status, 0);
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise((yes, no) => socket.close(error => error ? no(error) : yes()));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, CORUSCANT_MODE: 'test', CORUSCANT_TEST_DATA_ROOT: dataRoot, CORUSCANT_PORT: String(port), PORT: String(port), npm_config_audit: 'false', npm_config_fund: 'false' };
function npm(...args) {
  const result = spawnSync('npm', args, { cwd: checkout, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, `npm ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  console.log(`PASS npm ${args.join(' ')}`);
}
let child;
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit'); process.kill(-child.pid, 'SIGTERM');
  let timer;
  try { await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => { process.kill(-child.pid, 'SIGKILL'); reject(new Error('Isolated server did not stop cleanly.')); }, 5000); })]); }
  finally { clearTimeout(timer); }
}
async function start(cwd, documentedStart = false) {
  let error = '';
  child = spawn(documentedStart ? 'npm' : process.execPath, documentedStart ? ['start'] : [join(checkout, 'dist/node/server/index.js')], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); child.stderr.on('data', value => { error += value; });
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, error);
    try { if ((await fetch(`${origin}/api/public/catalog`, { signal: AbortSignal.timeout(300) })).ok) { if (documentedStart) console.log('PASS npm start'); return; } } catch {}
    await pause(30);
  }
  throw new Error(`Isolated server was not ready: ${error}`);
}
try {
  console.log(`${committed ? 'Committed clean-checkout baseline' : 'Uncommitted public-safe source snapshot'} ${revision}; isolated root, fresh locked npm ci, no recording data.`);
  npm('ci'); npm('run', 'verify:runtime'); npm('run', 'build:server'); npm('run', 'assets:fetch'); npm('run', 'db:migrate'); npm('run', 'demo:init');
  const entry = join(checkout, 'dist/node/server/index.js'), hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const serverHash = hash(entry);
  for (const name of ['001-core.sql', '002-material.sql', '003-workflow.sql', '004-results.sql', '005-delivery-observations.sql', '006-orbital-catalog.sql', '007-planning.sql', '008-proposed-plans.sql']) assert.ok(existsSync(join(checkout, 'dist/node/server/db/migrations', name)));
  npm('run', 'build:client'); assert.equal(hash(entry), serverHash, 'client build preserves compiled server');
  assert.ok(existsSync(join(checkout, 'dist/client/earth/world.200407.3x5400x2700.jpg')));
  for (const name of ['planning-process.test.js', 'proposed-plan-process.test.js']) {
    const planningRestart = spawnSync(process.execPath, ['--test', join(checkout, 'dist/node/tests/api', name)], {
      cwd: checkout, env, encoding: 'utf8', timeout: 45_000,
    });
    assert.equal(planningRestart.status, 0, `${planningRestart.stdout}\n${planningRestart.stderr}`);
  }
  console.log('PASS exact-checkout sourced Single Planning and actual selected-plan/private-manifest → separate same-reference submission; graceful OS restarts preserve source, originating brief, signing key, receipts and customer/staff lineage.');
  await start(checkout, true);
  // Use the same freshly authored test client over real HTTP, not Fastify injection.
  const { ApiClient, preparedResult, approveAndPublishImages, publishFinding, grant } = await import(pathToFileURL(join(checkout, 'dist/node/tests/api/support.js')));
  const { createEmptyBrief, areaSignature } = await import(pathToFileURL(join(checkout, 'dist/node/shared/validation.js')));
  const { createEmptyQuoteDraft } = await import(pathToFileURL(join(checkout, 'dist/node/shared/workflow.js')));
  const adapter = { async inject({ method, url, headers = {}, payload }) {
    const response = await fetch(`${origin}${url}`, { method, headers: { ...headers, host: `127.0.0.1:${port}`, origin }, ...(method === 'GET' ? {} : { body: JSON.stringify(payload ?? {}) }), signal: AbortSignal.timeout(10_000) });
    const body = await response.text(); return { statusCode: response.status, body, headers: Object.fromEntries(response.headers), json: () => JSON.parse(body) };
  } };
  const owner = new ApiClient(adapter), staff = new ApiClient(adapter), fixture = { owner, staff };
  await owner.enter(); await staff.enter('staff-admin');
  const catalog = (await owner.get('/api/public/catalog')).json();
  assert.equal((await owner.get('/api/customer/org-a/requests')).json().total, 0);
  const day = (offset, time) => { const date = new Date(catalog.demo.d0); date.setUTCDate(date.getUTCDate() + offset); return `${date.toISOString().slice(0, 10)}T${time}`; };
  const area = { latitude: 52.6, longitude: -9.7, radiusKm: 25, method: 'coordinates', generation: 1 };
  const brief = { ...createEmptyBrief(), purpose: 'Clean-checkout synthetic estuary comparison — no actual collection.', sensor: 'SAR', latitude: '52.6', longitude: '-9.7', radiusKm: '25', areaChoice: area, areaConfirmation: areaSignature(area), baselineDate: catalog.demo.baselineDate, recentDate: catalog.demo.recentDate, maxResolution: '10', timingToDiscuss: false, windowStart: day(1, '08:00'), windowEnd: day(4, '18:00'), contact: { name: 'Demonstration clean-checkout contact', email: 'verification@coruscant.example', organization: 'Demonstration research' }, acknowledged: true };
  const submission = { target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
  const reviewed = await owner.post('/api/command-reviews/submitRequest', submission); assert.equal(reviewed.statusCode, 200, reviewed.body);
  const submitted = await owner.post('/api/commands/submitRequest', { ...submission, commandId: randomUUID(), reviewToken: reviewed.json().reviewToken }); assert.equal(submitted.statusCode, 201, submitted.body);
  const id = submitted.json().requestId;
  await staff.action('startReview', id);
  const draft = await staff.action('saveQuoteDraft', id, { quote: { ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '2400.00', scope: 'Synthetic comparison of the exact accepted area and reference dates; no operator booking or real acquisition.', licence: 'Original synthetic demonstration material for local inspection.', validUntil: day(1, '18:00') } });
  const targetQuote = { quoteId: draft.quoteId }, expectedQuote = { quoteContentVersion: draft.quoteContentVersion };
  await staff.action('publishQuote', id, { replacesQuoteId: null }, targetQuote, expectedQuote);
  await owner.action('acceptQuote', id, {}, targetQuote, expectedQuote);
  await staff.action('recordInitialSchedule', id, { acceptedQuoteId: draft.quoteId, schedule: { provider: 'Demonstration planning team', start: day(2, '10:00'), end: day(2, '12:00'), timezone: 'UTC', trackedItemIds: [], notes: 'Recorded plan only.' } });
  await preparedResult(fixture, id); await approveAndPublishImages(fixture, id); await publishFinding(fixture, id); await grant(fixture, id);
  const material = (await staff.state(id)).result;
  await staff.action('recordDelivery', id, { note: 'Explicitly recorded synthetic demonstration delivery after full readable aligned-date review.' }, { resultId: material.id }, { accessVersion: material.access.version, findingContentVersion: material.finding.currentVersion.contentVersion });
  const resultPath = `/api/customer/org-a/results/${material.id}`, result = (await owner.get(resultPath)).json(), image = result.images[0];
  await owner.action('createObservation', id, { observation: { x: .42, y: .58, text: 'Original clean-checkout observation on this exact synthetic image.' } }, { resultId: material.id, assetId: image.assetId }, { imageContentVersion: image.contentVersion });
  const before = (await owner.get(resultPath)).json(); assert.equal(before.observations.length, 1); assert.equal(before.delivery.requestId, id);
  const stableRecord = value => {
    const record = structuredClone(value); delete record.serverNow; delete record.contextGeneration;
    // Read-time byte hints are checked separately; immutable review/access/record facts must match.
    if (record.result?.images) {
      delete record.result.readiness;
      for (const item of record.result.images) if (item.publishedVersion) delete item.publishedVersion.availability;
      for (const citation of record.result.finding?.publishedVersion?.citations ?? []) delete citation.availability;
    }
    return record;
  };
  const customerLineage = stableRecord(await owner.state(id)), staffLineage = stableRecord(await staff.state(id));
  const bytes = await owner.get(image.previewUrl); assert.equal(bytes.statusCode, 200);
  await stop(); child = undefined;
  npm('run', 'db:migrate'); npm('run', 'demo:init'); npm('run', 'build:client'); assert.equal(hash(entry), serverHash);
  await start(otherCwd);
  assert.equal((await owner.get('/api/public/catalog')).json().demo.d0, catalog.demo.d0);
  const after = (await owner.get(resultPath)).json();
  assert.equal(after.id, before.id); assert.deepEqual(after.observations, before.observations); assert.deepEqual(after.delivery, before.delivery); assert.deepEqual(after.images.map(value => [value.assetId, value.contentVersion]), before.images.map(value => [value.assetId, value.contentVersion]));
  assert.equal((await owner.state(id)).status, 'Delivered'); assert.equal((await owner.get(image.previewUrl)).statusCode, 200);
  assert.deepEqual(stableRecord(await owner.state(id)), customerLineage);
  assert.deepEqual(stableRecord(await staff.state(id)), staffLineage);
  const { chromium } = await import(pathToFileURL(join(checkout, 'node_modules/playwright/index.mjs')));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(); let externalAttempts = 0;
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : (externalAttempts++, route.abort()));
    await context.addCookies([{ name: owner.cookie.split('=')[0], value: owner.cookie.slice(owner.cookie.indexOf('=') + 1), url: origin, httpOnly: true, sameSite: 'Strict' }]);
    const page = await context.newPage(); await page.goto(`${origin}/workspaces/org-a/results/${material.id}`);
    await page.getByRole('tab', { name: 'Staff finding', exact: true }).waitFor();
    await page.locator('.image-viewport img').first().waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.image-viewport img')].some(value => value.naturalWidth === 1600));
    assert.equal(externalAttempts, 0); await context.close();
  } finally { await browser.close(); }
  console.log('PASS copied SQL/runtime assets; alternate-cwd real server; explicit quote→accept→schedule→review/publication→separate access→delivery→exact-image point; second initialization, rebuild and OS-process restart preserve lineage; browser works with external requests blocked (zero attempted).');
  console.log(`PASS V17 ${committed ? 'committed baseline' : 'uncommitted source snapshot'} ${revision}`);
} finally {
  await stop(); rmSync(temporary, { recursive: true, force: true });
}
