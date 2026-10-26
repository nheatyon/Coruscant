import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGeometry, GEOMETRY_RECIPE, GEOMETRY_RECIPE_VERSION } from '../../demo/geometry.js';
import { circleContains, circleGeometry, EARTH_RADIUS_KM, evaluateTrack, geographicUV, latLonToVector, pointerToNdc, sampleTrackPath, slerpDirections, validateTrack, vectorToLatLon, type Vec3 } from '../../shared/globe.js';

const d0 = '2026-10-22T12:00:00.123Z', epoch = Date.parse(d0);
const geometry = makeGeometry(d0);
const near = (actual: number, expected: number, tolerance = 1e-11) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const norm = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test('one geographic frame maps cardinals, seam and poles and inverts unscaled/raised geographic vectors', () => {
  for (const [lat, lon, expected] of [[0, 0, { x: 1, y: 0, z: 0 }], [0, 90, { x: 0, y: 0, z: -1 }], [0, -90, { x: 0, y: 0, z: 1 }], [90, 0, { x: 0, y: 1, z: 0 }], [-90, 0, { x: 0, y: -1, z: 0 }]] as const) assert.ok(distance(latLonToVector(lat, lon), expected) < 1e-14);
  for (const [latitude, longitude] of [[52.6, -9.7], [18, 35], [-38.2, 179.9], [0, 0], [66, -179.9]]) {
    const vector = latLonToVector(latitude!, longitude!, 1.003), read = vectorToLatLon(vector)!;
    near(read.latitude, latitude!); near(read.longitude, longitude!); near(read.radius, 1.003);
  }
  assert.ok(distance(latLonToVector(0, -180), latLonToVector(0, 180)) < 1e-14);
  assert.equal(vectorToLatLon({ x: 0, y: 2, z: 0 })!.longitude, 0);
  assert.equal(vectorToLatLon({ x: 0, y: 0, z: 0 }), null); assert.equal(vectorToLatLon({ x: NaN, y: 1, z: 0 }), null);
  assert.throws(() => latLonToVector(91, 0)); assert.throws(() => latLonToVector(0, Infinity));
});
test('texture UV and pixel convention uses the same axes with explicit duplicated seam coordinates', () => {
  assert.deepEqual(geographicUV(90, 0), { u: .5, v: 1, imageX: .5, imageY: 0 });
  assert.deepEqual(geographicUV(-90, 0), { u: .5, v: 0, imageX: .5, imageY: 1 });
  assert.equal(geographicUV(0, -180).u, 0); assert.equal(geographicUV(0, 180).u, 1);
  assert.equal(geographicUV(0, 90).imageX, .75); assert.equal(geographicUV(0, -90).imageX, .25);
});
test('canvas-relative picking includes rail extension and geographic invariants survive presentation rotation/inversion', () => {
  assert.deepEqual(pointerToNdc(480, 400, { left: -320, top: 0, width: 1600, height: 800 }), { x: 0, y: 0 });
  assert.equal(pointerToNdc(100, 100, { left: 0, top: 0, width: 0, height: 800 }), null);
  assert.equal(pointerToNdc(-1, 400, { left: 0, top: 0, width: 800, height: 800 }), null);
  const original = latLonToVector(52.6, -9.7), angle = 1.2;
  const rotate = (v: Vec3, a: number) => ({ x: v.x * Math.cos(a) + v.z * Math.sin(a), y: v.y, z: -v.x * Math.sin(a) + v.z * Math.cos(a) });
  const restored = vectorToLatLon(rotate(rotate(original, angle), -angle))!;
  near(restored.latitude, 52.6); near(restored.longitude, -9.7);
});
test('spherical circle remains stable at minimum size, seam and poles; large cap never wraps or inverts', () => {
  for (const [lat, lon, radius] of [[0, 179.99, 25], [90, 123, 25], [-90, -50, 25], [0, 0, .001]]) {
    const circle = circleGeometry(lat!, lon!, radius!); assert.equal(circle.ring.length, 181); assert.deepEqual(circle.ring[0], circle.ring.at(-1));
    assert.ok(circleContains(circle.normal, circle.theta, circle.normal));
    for (const vertex of circle.ring) { near(norm(vertex), 1.003); assert.ok(circleContains(circle.normal, circle.theta, vertex)); }
    assert.equal(circle.radiusKm, radius); assert.ok(circle.areaKm2 > 0);
  }
  const tiny = circleGeometry(0, 0, .001); near(tiny.areaKm2, Math.PI * .001 ** 2, 1e-17); near(tiny.diameterKm, .002);
  assert.equal(circleContains(tiny.normal, tiny.theta, latLonToVector(0, .001)), false);
  const large = circleGeometry(0, 0, EARTH_RADIUS_KM * Math.PI * .75); assert.ok(large.areaKm2 > 2 * Math.PI * EARTH_RADIUS_KM ** 2); assert.equal(large.global, false); near(large.diameterKm, Math.PI * EARTH_RADIUS_KM);
  for (const radius of [Math.PI * EARTH_RADIUS_KM, 1e9, Number.MAX_VALUE]) { const global = circleGeometry(0, 0, radius); assert.equal(global.global, true); assert.equal(global.radiusKm, radius); assert.deepEqual(global.ring, []); near(global.areaKm2, 4 * Math.PI * EARTH_RADIUS_KM ** 2, 1e-6); assert.ok(circleContains(global.normal, global.theta, latLonToVector(0, 180))); }
  for (const invalid of [0, .0009, NaN, Infinity]) assert.throws(() => circleGeometry(0, 0, invalid));
});
test('fresh exact recipe has only three declared objects and8641 ordered300-second knots over held D0±15days', () => {
  assert.equal(geometry.recipeVersion, GEOMETRY_RECIPE_VERSION); assert.equal(geometry.epoch, d0); assert.equal(geometry.earthRadius, 1);
  assert.deepEqual(geometry.tracks.map(track => track.itemId), ['demo-sar-03', 'demo-sar-08', 'demo-sar-country']);
  assert.equal(Date.parse(geometry.spanStart), epoch - 15 * 86400 * 1000); assert.equal(Date.parse(geometry.spanEnd), epoch + 15 * 86400 * 1000);
  geometry.tracks.forEach((track, index) => {
    assert.equal(track.knots.length, 8641); assert.equal(track.cadenceSeconds, 300); assert.equal(validateTrack(track).valid, true);
    assert.equal(track.knots[0]!.at, geometry.spanStart); assert.equal(track.knots.at(-1)!.at, geometry.spanEnd);
    assert.equal(track.periodSeconds, [5400, 6600, 7500][index]); assert.equal(track.displayRadius, [1.12, 1.16, 1.1][index]);
    assert.equal(track.noradId, null); assert.equal(track.altitudeKm, null); assert.equal(track.propagator, null);
    for (let n = 0; n < track.knots.length; n++) { assert.equal(Date.parse(track.knots[n]!.at), epoch - 15 * 86400 * 1000 + n * 300000); near(norm(track.knots[n]!.direction), 1); }
    const centre = evaluateTrack(track, d0)!; near(norm(centre), track.displayRadius);
    assert.ok(distance(centre, evaluateTrack(track, epoch + track.periodSeconds * 1000)!) < 1e-12, 'one cycle is measured in seconds, not epoch milliseconds');
  });
  assert.deepEqual(GEOMETRY_RECIPE.objects.map(row => [row.tiltDeg, row.azimuthDeg, row.phaseDeg]), [[55, -25, 20], [75, 45, 140], [35, 120, 260]]);
  assert.equal(makeGeometry(d0).tracks[0]!.knots[4320]!.at, d0);
});
test('exact keyframes are direct, bracket interpolation is unit/linear-radius and crosses179 to−179 without zero', () => {
  const track = structuredClone(geometry.tracks[0]!); const middle = 4320;
  for (const n of [0, middle, track.knots.length - 1]) { const knot = track.knots[n]!, point = evaluateTrack(track, knot.at)!; assert.deepEqual(point, { x: knot.direction.x * knot.radius, y: knot.direction.y * knot.radius, z: knot.direction.z * knot.radius }); }
  track.knots[middle] = { at: d0, radius: 1.1, direction: latLonToVector(0, 179) };
  track.knots[middle + 1] = { at: new Date(epoch + 300000).toISOString(), radius: 1.3, direction: latLonToVector(0, -179) };
  assert.equal(validateTrack(track).valid, true); const half = evaluateTrack(track, epoch + 150000)!; near(norm(half), 1.2); near(Math.abs(vectorToLatLon(half)!.longitude), 180); near(vectorToLatLon(half)!.latitude, 0);
  assert.equal(evaluateTrack(track, Date.parse(track.spanStart) - 1), null); assert.equal(evaluateTrack(track, Date.parse(track.spanEnd) + 1), null);
  assert.equal(slerpDirections({ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, .5), null);
  near(norm(slerpDirections({ x: 1, y: 0, z: 0 }, { x: 1, y: 1e-8, z: 0 }, .5)!), 1);
});
test('missing, duplicate, corrupt or antipodal knots make whole object unavailable without repair/extrapolation', () => {
  const variants = [
    (track: typeof geometry.tracks[number]) => { track.knots.splice(20, 1); },
    (track: typeof geometry.tracks[number]) => { track.knots[20]!.at = track.knots[19]!.at; },
    (track: typeof geometry.tracks[number]) => { track.knots[20]!.radius = 1; },
    (track: typeof geometry.tracks[number]) => { track.knots[20]!.direction = { x: 0, y: 0, z: 0 }; },
    (track: typeof geometry.tracks[number]) => { track.knots[20]!.direction.x = NaN; },
    (track: typeof geometry.tracks[number]) => { const prior = track.knots[19]!.direction; track.knots[20]!.direction = { x: -prior.x, y: -prior.y, z: -prior.z }; },
    (track: typeof geometry.tracks[number]) => { track.itemId = 'demo-eo-unknown'; },
    (track: typeof geometry.tracks[number]) => { track.spanEnd = new Date(epoch + 16 * 86400 * 1000).toISOString(); },
  ];
  for (const change of variants) { const track = structuredClone(geometry.tracks[0]!); change(track); assert.equal(validateTrack(track).valid, false); assert.ok(validateTrack(track).reason); assert.equal(evaluateTrack(track, d0), null); assert.equal(sampleTrackPath(track, d0), null); }
});
test('one-cycle paths include exact clipped ends, never close partial spans and sample at mostP/72', () => {
  const track = geometry.tracks[2]!, full = sampleTrackPath(track, d0)!;
  assert.equal(full.closed, true); assert.ok(full.points.length >= 73); assert.equal(Date.parse(full.start), epoch - track.periodSeconds * 500); assert.equal(Date.parse(full.end), epoch + track.periodSeconds * 500); assert.ok(distance(full.points[0]!, full.points.at(-1)!) < 1e-12);
  for (const time of [track.spanStart, track.spanEnd]) { const clipped = sampleTrackPath(track, time)!; assert.equal(clipped.closed, false); assert.ok(Date.parse(clipped.start) >= Date.parse(track.spanStart)); assert.ok(Date.parse(clipped.end) <= Date.parse(track.spanEnd)); assert.ok((Date.parse(clipped.end) - Date.parse(clipped.start)) / (clipped.points.length - 1) <= track.periodSeconds * 1000 / 72); assert.ok(distance(clipped.points[0]!, evaluateTrack(track, clipped.start)!) < 1e-12); assert.ok(distance(clipped.points.at(-1)!, evaluateTrack(track, clipped.end)!) < 1e-12); }
});
