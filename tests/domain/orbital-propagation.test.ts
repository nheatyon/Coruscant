import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalInstant, createPropagator, ecfToGeodetic, lookAngles, observerAt } from '../../server/orbital/propagation.js';
import type { NormalizedOMM } from '../../shared/orbital-contracts.js';

// Newly authored numerical unit input, not a provider record or real spacecraft claim.
const unitOrbit: NormalizedOMM = {
  OBJECT_NAME: 'Original numerical unit orbit', OBJECT_ID: '', EPOCH: '2026-10-24T12:00:00.123Z', NORAD_CAT_ID: '123456789',
  CENTER_NAME: 'EARTH', REF_FRAME: 'TEME', TIME_SYSTEM: 'UTC', MEAN_ELEMENT_THEORY: 'SGP4',
  MEAN_MOTION: 15, ECCENTRICITY: .001, INCLINATION: 63, RA_OF_ASC_NODE: 41, ARG_OF_PERICENTER: 22, MEAN_ANOMALY: 17,
  EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 1, REV_AT_EPOCH: 1, BSTAR: 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
};
test('WGS84 observer/geodetic round trips preserve true latitude, longitude, poles and zero-origin', () => {
  for (const [latitude, longitude] of [[0, 0], [52.6, -9.7], [-36, 179.9], [89.99, -179.9], [90, 0], [-90, 0]]) {
    const observer = observerAt(latitude!, longitude!), result = ecfToGeodetic(observer.ecfKm)!;
    assert.ok(Math.abs(result.latitude - latitude!) < 1e-10);
    assert.ok(Math.abs(result.longitude - longitude!) < 1e-10);
    assert.ok(Math.abs(result.heightKm) < 1e-8);
    assert.ok(Math.abs(Math.hypot(observer.up.x, observer.up.y, observer.up.z) - 1) < 1e-14);
  }
  const place = observerAt(45, 0), geocentric = Math.atan2(place.ecfKm.z, Math.hypot(place.ecfKm.x, place.ecfKm.y)) * 180 / Math.PI;
  assert.ok(Math.abs(geocentric - 45) > .1, 'geocentric direction must not replace geodetic latitude');
});
test('local-up elevation and range use physical ECF, including overhead, horizon and degenerate refusal', () => {
  const observer = observerAt(0, 0);
  assert.deepEqual(lookAngles({ x: observer.ecfKm.x + 500, y: 0, z: 0 }, observer), { elevationDeg: 90, slantRangeKm: 500 });
  assert.deepEqual(lookAngles({ x: observer.ecfKm.x, y: 500, z: 0 }, observer), { elevationDeg: 0, slantRangeKm: 500 });
  assert.equal(lookAngles(observer.ecfKm, observer), null);
  assert.throws(() => observerAt(91, 0));
});
test('pure propagation keeps full identity, UTC millisecond input and physical/display units distinct', () => {
  const propagator = createPropagator(unitOrbit), value = propagator.at(unitOrbit.EPOCH);
  assert.equal(value.ok, true);
  if (!value.ok) return;
  assert.equal(value.catalogNumber, '123456789'); assert.equal(value.at, unitOrbit.EPOCH);
  assert.ok(Math.hypot(value.teme.positionKm.x, value.teme.positionKm.y, value.teme.positionKm.z) > 6378);
  assert.ok(Math.hypot(value.teme.velocityKmPerSecond.x, value.teme.velocityKmPerSecond.y, value.teme.velocityKmPerSecond.z) > 1);
  assert.ok(Math.abs(Math.hypot(value.display.x, value.display.y, value.display.z) - (1 + value.geodetic.heightKm / 6378.137)) < 1e-12);
  assert.ok(Math.hypot(value.ecfKm.x, value.ecfKm.y, value.ecfKm.z) > 6378, 'physical ECF must never become the unit display vector');
  assert.equal(propagator.at('2026-10-24T12:00:00Z').ok, false);
  assert.equal(canonicalInstant('2026-10-24T12:00:00.123+00:00'), null);
  assert.equal(canonicalInstant('2026-10-24T12:00:60.000Z'), null);
  assert.throws(() => createPropagator({ ...unitOrbit, MEAN_ELEMENT_THEORY: 'OTHER' } as unknown as NormalizedOMM));
});
test('separate propagator records remain deterministic across interleaved instants without a shared mutable cache', () => {
  const a = createPropagator(unitOrbit), b = createPropagator(unitOrbit), at = '2026-10-24T13:00:00.123Z';
  const expected = b.at(at); a.at('2026-10-23T12:00:00.123Z'); a.at('2026-10-25T12:00:00.123Z');
  assert.deepEqual(a.at(at), expected); assert.deepEqual(b.at(at), expected);
});
