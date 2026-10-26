import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { apiFixture } from './support.js';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import { captureBrowseSnapshot, captureCatalog, ingestSources } from '../../server/orbital/repository.js';
import { calculateBrowse, createBrowseService } from '../../server/orbital/browse.js';
import { createPropagator } from '../../server/orbital/propagation.js';
import { emptyDiscoveryValues } from '../../shared/discovery.js';
import type { OrbitalBrowseInput, OrbitalBrowsePage } from '../../shared/orbital-contracts.js';

// Original isolated numerical input, not downloaded GP data or an actual satellite identity claim.
function row(id: number, changes: Record<string, unknown> = {}) { return { NORAD_CAT_ID: id, OBJECT_NAME: `Original browse-test object ${id}`, OBJECT_ID: '', EPOCH: '2026-10-21T11:00:00.123456', MEAN_MOTION: 14.5, ECCENTRICITY: .002, INCLINATION: 67, RA_OF_ASC_NODE: 32, ARG_OF_PERICENTER: 55, MEAN_ANOMALY: 80, BSTAR: .00003, MEAN_MOTION_DOT: .000001, MEAN_MOTION_DDOT: 0, ...changes }; }
function seed(db: Parameters<typeof ingestSources>[0], values: unknown[], at: string) {
  return ingestSources(db, (['sar', 'resource'] as const).map(group => { const source = parseSourceBytes(group, Buffer.from(JSON.stringify(group === 'sar' ? values : [])), at); return { source, rawFilename: `${source.responseHash}.json` }; }), at);
}
function inputFor(db: Parameters<typeof ingestSources>[0], at: string, changes: Partial<OrbitalBrowseInput> = {}): OrbitalBrowseInput { const capture = captureCatalog(db)!; return { snapshotVersion: capture.snapshotVersion, factVersion: capture.factVersion, representedAt: at, generation: 1, criteria: emptyDiscoveryValues(), visibility: 'MATCHES', ...changes }; }

test('real browse has independent200-point/50-path bounds, full-population priority, bounded versioned pages and no synthetic substitution', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, Array.from({ length: 260 }, (_, i) => row(100001 + i)), at);
    const input = inputFor(db, at, { selectedId: 'norad:100260', shortlistedIds: ['norad:100250'] }), records = [];
    let response = await f.owner.post('/api/orbital-browse', { ...input }), first: OrbitalBrowsePage | undefined;
    assert.equal(response.statusCode, 200, response.body);
    while (true) {
      const value = response.json<OrbitalBrowsePage>(); first ??= value; assert.ok(Buffer.byteLength(response.body) <= 256 * 1024); assert.ok(value.objects.length <= 50);
      assert.equal(value.representedAt, at); assert.equal(value.snapshotVersion, input.snapshotVersion); assert.deepEqual(value.counts, first.counts); records.push(...value.objects);
      if (!value.nextCursor) break;
      response = await f.owner.post('/api/orbital-browse', { ...input, cursor: value.nextCursor }); assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(records.length, 260); assert.equal(new Set(records.map(value => value.id)).size, 260);
    assert.equal(records[0]!.id, input.selectedId); assert.equal(records[1]!.id, input.shortlistedIds![0]);
    assert.equal(records[0]!.sourceEpoch, '2026-10-21T11:00:00.123456Z'); assert.equal(records[0]!.epoch, '2026-10-21T11:00:00.123Z');
    assert.equal(first!.counts.positions, 200); assert.equal(first!.counts.paths, 50); assert.equal(first!.counts.displayLimited, 60); assert.equal(first!.counts.matching, 260);
    assert.equal(records[50]!.positionAvailability, 'AVAILABLE'); assert.equal(records[50]!.pathAvailability, 'DISPLAY_LIMITED'); assert.equal(records[200]!.positionAvailability, 'DISPLAY_LIMITED');
    const path = records[0]!.path!.flat(); assert.equal(path.length, 361); assert.equal(Date.parse(path[0]!.at), Date.parse(at) - 90 * 60 * 1000); assert.equal(Date.parse(path.at(-1)!.at), Date.parse(at) + 90 * 60 * 1000);
    for (let i = 1; i < path.length; i++) assert.equal(Date.parse(path[i]!.at) - Date.parse(path[i - 1]!.at), 30_000);
    assert.ok(records.every(value => !value.id.startsWith('demo-')));
    assert.equal((await f.owner.get('/api/public/geometry')).json().tracks.length, 3);
    assert.equal(db.prepare('SELECT count(*) n FROM service_requests').get()!.n, 0); assert.equal(db.prepare('SELECT count(*) n FROM action_receipts').get()!.n, 0);
  } finally { await f.close(); }
});
test('missing/stale/future orbit evidence stays inspectable but cannot consume eligible slots or become an available track', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, [row(100001, { EPOCH: '2026-10-19T11:00:00.000' }), row(100002, { EPOCH: '2026-10-22T11:00:00.000' }), row(100003, { MEAN_MOTION: -1 }), row(100004)], at);
    const response = await f.owner.post('/api/orbital-browse', { ...inputFor(db, at) }); assert.equal(response.statusCode, 200, response.body);
    const value = response.json<OrbitalBrowsePage>(); assert.equal(value.counts.positions, 1); assert.equal(value.counts.paths, 1); assert.equal(value.counts.unavailable, 3);
    assert.equal(value.objects[3]!.id, 'norad:100004'); assert.equal(value.objects[3]!.positionAvailability, 'AVAILABLE');
    assert.match(value.objects[0]!.reason!, /stale/); assert.match(value.objects[1]!.reason!, /Future/);
    const outside = await f.owner.post('/api/orbital-browse', { ...inputFor(db, '2026-11-01T12:00:00.000Z') }); assert.equal(outside.statusCode, 200); assert.equal(outside.json().counts.positions, 0);
  } finally { await f.close(); }
});
test('browse paths include exact clipped epoch-span endpoints without evaluating outside either48-hour boundary', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, [row(150001)], at);
    const initial = inputFor(db, at), snapshot = captureBrowseSnapshot(db, initial), epoch = Date.parse(snapshot.candidates[0]!.item.orbit.epoch!);
    const span = 48 * 60 * 60 * 1000, halfPath = 90 * 60 * 1000;
    for (const side of [-1, 1]) {
      // Off-grid milliseconds require the exact supported endpoint, rather than
      // silently dropping it when the final interval is shorter than30seconds.
      const represented = epoch + side * (span - 15 * 60 * 1000 + 7456), input = { ...initial, representedAt: new Date(represented).toISOString() }, calls: number[] = [];
      const value = await calculateBrowse(snapshot, input, at, { propagator: omm => {
        const actual = createPropagator(omm);
        return { ...actual, at(utc) { calls.push(Date.parse(utc)); return actual.at(utc); } };
      } });
      const object = value.objects[0]!, start = Math.max(represented - halfPath, epoch - span), end = Math.min(represented + halfPath, epoch + span);
      assert.equal(object.positionAvailability, 'AVAILABLE'); assert.equal(object.pathAvailability, 'AVAILABLE'); assert.equal(value.state, 'COMPLETE');
      assert.deepEqual(object.pathWindow, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), stepSeconds: 30, clippedStart: side < 0, clippedEnd: side > 0 });
      assert.equal(object.path!.length, 1); const vertices = object.path![0]!;
      assert.equal(Date.parse(vertices[0]!.at), start); assert.equal(Date.parse(vertices.at(-1)!.at), end); assert.ok(vertices.length <= 361);
      for (let index = 1; index < vertices.length; index++) {
        const step = Date.parse(vertices[index]!.at) - Date.parse(vertices[index - 1]!.at);
        assert.ok(step > 0 && step <= 30_000); if (index < vertices.length - 1) assert.equal(step, 30_000);
      }
      assert.ok(Date.parse(vertices.at(-1)!.at) - Date.parse(vertices.at(-2)!.at) < 30_000);
      assert.ok(calls.length > 2); assert.ok(calls.every(time => time >= epoch - span && time <= epoch + span));
      assert.match(object.pathReason!, /clipped to the supported element span/);
    }
  } finally { await f.close(); }
});
test('invalid interior path samples create separate segments without hiding the valid represented point or bridging the gap', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, [row(160001)], at);
    const input = inputFor(db, at), snapshot = captureBrowseSnapshot(db, input), represented = Date.parse(at);
    const failedTimes = [represented + 5 * 60 * 1000, represented + 5 * 60 * 1000 + 30_000], failures: number[] = [];
    const value = await calculateBrowse(snapshot, input, at, { propagator: omm => {
      const actual = createPropagator(omm);
      return { ...actual, at(utc) {
        const time = Date.parse(utc);
        if (failedTimes.includes(time)) { failures.push(time); return { ok: false, at: utc, reason: 'Original isolated invalid-sample injection.' }; }
        return actual.at(utc);
      } };
    } });
    const object = value.objects[0]!; assert.deepEqual(failures, failedTimes);
    assert.equal(object.positionAvailability, 'AVAILABLE'); assert.ok(object.position); assert.equal(object.pathAvailability, 'AVAILABLE');
    assert.equal(value.state, 'COMPLETE'); assert.deepEqual(value.counts, { matching: 1, positions: 1, paths: 1, displayLimited: 0, pathsLimited: 0, unavailable: 0, processed: 1, remaining: 0 });
    const segments = object.path!; assert.equal(segments.length, 2); assert.equal(segments.flat().length, 359);
    assert.equal(Date.parse(segments[0]![0]!.at), represented - 90 * 60 * 1000); assert.equal(Date.parse(segments[1]!.at(-1)!.at), represented + 90 * 60 * 1000);
    assert.equal(Date.parse(segments[0]!.at(-1)!.at), failedTimes[0]! - 30_000); assert.equal(Date.parse(segments[1]![0]!.at), failedTimes[1]! + 30_000);
    for (const segment of segments) for (let index = 1; index < segment.length; index++) assert.equal(Date.parse(segment[index]!.at) - Date.parse(segment[index - 1]!.at), 30_000);
    assert.ok(segments.flat().every(vertex => !failedTimes.includes(Date.parse(vertex.at))));
    assert.equal(Date.parse(segments[1]![0]!.at) - Date.parse(segments[0]!.at(-1)!.at), 90_000);
    assert.match(object.pathReason!, /Unavailable propagation intervals are shown as gaps/);
  } finally { await f.close(); }
});
test('browse transport/context, cursor owner and source/version guards reject stale or foreign pages without exposing rows', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, Array.from({ length: 60 }, (_, i) => row(200001 + i)), at); const input = inputFor(db, at);
    const anonymous = await f.app.inject({ method: 'POST', url: '/api/orbital-browse', headers: { host: f.config.allowedHost, origin: f.config.origin, 'content-type': 'application/json' }, payload: input }); assert.equal(anonymous.statusCode, 401);
    const wrong = await f.app.inject({ method: 'POST', url: '/api/orbital-browse', headers: { ...f.owner.headers(), 'x-coruscant-csrf': 'wrong' }, payload: { ...input, contextGeneration: f.owner.context!.contextGeneration, contextToken: f.owner.context!.contextToken } }); assert.equal(wrong.statusCode, 403);
    const first = await f.owner.post('/api/orbital-browse', { ...input }); assert.equal(first.statusCode, 200, first.body); const cursor = first.json().nextCursor; assert.ok(cursor);
    const foreign = await f.staff.post('/api/orbital-browse', { ...input, cursor }); assert.equal(foreign.statusCode, 409); assert.ok(!foreign.body.includes('Original browse-test object'));
    assert.equal((await f.owner.post('/api/orbital-browse', { ...input, cursor, generation: 2 })).statusCode, 409);
    seed(db, [row(300001)], at); assert.equal((await f.owner.post('/api/orbital-browse', { ...input, cursor })).statusCode, 409);
  } finally { await f.close(); }
});
test('time-budget exhaustion accounts every identity as incomplete and yields without a write transaction', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, Array.from({ length: 65 }, (_, i) => row(400001 + i)), at); const input = inputFor(db, at), snapshot = captureBrowseSnapshot(db, input);
    let elapsed = 0, yields = 0; const value = await calculateBrowse(snapshot, input, at, { now: () => elapsed, yieldControl: async () => { assert.equal(db.isTransaction, false); yields++; elapsed += 6000; await yieldLoop(); } });
    assert.equal(value.state, 'INCOMPLETE'); assert.ok(yields >= 2); assert.equal(value.objects.length, 65); assert.ok(value.counts.remaining > 0); assert.equal(value.counts.processed + value.counts.remaining, 65);
    assert.ok(value.objects.some(object => object.positionAvailability === 'INCOMPLETE' || object.pathAvailability === 'INCOMPLETE'));
    assert.ok(!value.message!.includes('No opportunity'));
  } finally { await f.close(); }
});
test('new generations cancel prior browse work and final authority is rechecked before a response or page is released', async () => {
  const f = await apiFixture(); try {
    const db = f.app.coruscant.db, at = f.clock().toISOString(); seed(db, Array.from({ length: 100 }, (_, i) => row(500001 + i)), at); const input = inputFor(db, at), service = createBrowseService(db, f.clock), signal = new AbortController().signal;
    const first = service.run(input, 'isolated-test-owner', signal, () => {});
    const second = service.run({ ...input, generation: 2 }, 'isolated-test-owner', signal, () => {});
    const result = await Promise.allSettled([first, second]); assert.equal(result[0]!.status, 'rejected'); assert.equal(result[1]!.status, 'fulfilled');
    let guards = 0;
    await assert.rejects(service.run({ ...input, generation: 3 }, 'other-isolated-owner', signal, () => { guards++; if (guards > 1) throw new Error('Context revoked after computation'); }), /Context revoked/);
    assert.equal(guards, 2); service.close();
  } finally { await f.close(); }
});
