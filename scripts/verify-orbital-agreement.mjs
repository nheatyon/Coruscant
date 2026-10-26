import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Explicit paths only. This reads freshly acquired, private source bytes, never fetches or seeds.
const here = dirname(fileURLToPath(import.meta.url)), project = resolve(here, '..');
const [ledgerPath, python, emittedRoot = join(project, 'dist/node')] = process.argv.slice(2);
assert.ok(ledgerPath && python, 'Usage: node scripts/verify-orbital-agreement.mjs /absolute/new-ledger.json /absolute/venv/bin/python [emittedRoot]');
const { parseSourceBytes, assembleCatalog } = await import(pathToFileURL(join(emittedRoot, 'server/orbital/catalog.js')));
const { createPropagator, observerAt, lookAngles } = await import(pathToFileURL(join(emittedRoot, 'server/orbital/propagation.js')));
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')), sourceRoot = dirname(resolve(ledgerPath)), hashes = {}, groups = [];
for (const key of ['sar', 'resource']) {
  const entry = ledger.groups[key], bytes = readFileSync(join(sourceRoot, entry.rawFile));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, entry.sha256); assert.equal(entry.httpStatus, 200); hashes[key] = hash;
  const source = parseSourceBytes(key, bytes, entry.retrievedAt);
  groups.push({ source, rows: source.rows.map(row => ({ row, confirmation: 'CONFIRMED', lastSeenAt: source.retrievedAt })) });
}
const assembled = assembleCatalog(groups), records = [];
for (const item of assembled.items) {
  const omm = assembled.elements.get(item.id); if (!omm) continue;
  const epoch = Date.parse(omm.EPOCH);
  records.push({ id: item.id, omm, instants: [-90, 0, 90].map(minutes => new Date(epoch + minutes * 60000).toISOString()) });
}
assert.ok(records.length > 2, 'Verify the actual source population, not a two-example kernel.');
const observers = [[0, 0], [52.6, -9.7], [-90, 180], [89.9999, -179.9999], [-33.9, 151.2]];
const reference = spawnSync(python, [join(here, 'orbital-reference.py')], {
  input: JSON.stringify({ records, observers }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000,
});
assert.equal(reference.status, 0, reference.stderr);
const oracle = JSON.parse(reference.stdout); assert.equal(oracle.sgp4Version, '2.27');
const maxima = { positionKm: 0, velocityKmPerSecond: 0, ecfKm: 0, elevationDeg: 0, geodeticLatitudeDeg: 0, heightKm: 0 };
const byId = new Map(records.map(record => [record.id, createPropagator(record.omm)]));
const vector = value => [value.x, value.y, value.z];
const distance = (a, b) => Math.hypot(...a.map((value, index) => value - b[index]));
const started = performance.now(); let compared = 0;
for (const expected of oracle.results) {
  const result = byId.get(expected.id).at(expected.at);
  assert.equal(expected.error, 0, `Reference propagation error ${expected.id}`);
  assert.equal(result.ok, true, `${expected.id}: ${result.reason}`);
  maxima.positionKm = Math.max(maxima.positionKm, distance(vector(result.teme.positionKm), expected.position));
  maxima.velocityKmPerSecond = Math.max(maxima.velocityKmPerSecond, distance(vector(result.teme.velocityKmPerSecond), expected.velocity));
  maxima.ecfKm = Math.max(maxima.ecfKm, distance(vector(result.ecfKm), expected.ecf));
  maxima.geodeticLatitudeDeg = Math.max(maxima.geodeticLatitudeDeg, Math.abs(result.geodetic.latitude - expected.geodetic[0]));
  maxima.heightKm = Math.max(maxima.heightKm, Math.abs(result.geodetic.heightKm - expected.geodetic[2]));
  for (let i = 0; i < observers.length; i++) {
    const angle = lookAngles(result.ecfKm, observerAt(...observers[i])); assert.ok(angle);
    maxima.elevationDeg = Math.max(maxima.elevationDeg, Math.abs(angle.elevationDeg - expected.elevations[i]));
  }
  compared++;
}
assert.ok(maxima.positionKm <= 1e-3, JSON.stringify(maxima));
assert.ok(maxima.velocityKmPerSecond <= 1e-6, JSON.stringify(maxima));
assert.ok(maxima.elevationDeg <= 1e-4, JSON.stringify(maxima));
assert.ok(maxima.ecfKm <= 1e-3 && maxima.heightKm <= 1e-3 && maxima.geodeticLatitudeDeg <= 1e-4, JSON.stringify(maxima));
console.log(JSON.stringify({ outcome: 'PASS', sourceHashes: hashes,
  sources: groups.map(({ source }) => ({ group: source.group, rawRows: source.rowCount, identified: source.rows.length,
    rejected: source.rejected, invalidOrbits: source.invalidOrbits, validation: source.validation })),
  uniqueIdentities: assembled.items.length, validOrbits: records.length, comparedInstants: compared,
  observerComparisons: compared * observers.length, python: { version: oracle.sgp4Version, accelerated: oracle.accelerated },
  regimes: { minMeanMotionRevPerDay: Math.min(...records.map(r => r.omm.MEAN_MOTION)),
    maxMeanMotionRevPerDay: Math.max(...records.map(r => r.omm.MEAN_MOTION)), maxEccentricity: Math.max(...records.map(r => r.omm.ECCENTRICITY)) },
  maxima, javascriptComparisonMs: Math.round(performance.now() - started),
  limits: 'Implementation agreement, not observational accuracy; shared SGP4 ancestry. Freshness is checked separately before UI prediction.' }, null, 2));
