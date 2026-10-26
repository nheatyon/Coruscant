import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawingArea, nextAreaGeneration, shortestGroundDistanceKm, stableNearSideHit, validAreaCircle } from '../../shared/area-proposal.js';
import { EARTH_RADIUS_KM, latLonToVector } from '../../shared/globe.js';

const near = (actual: number | null, expected: number, epsilon = 1e-8) => assert.ok(actual !== null && Math.abs(actual - expected) < epsilon, `${actual} differs from ${expected}`);
test('drawing measures shortest ground distance across the date line and at a pole without a longitude jump', () => {
  near(shortestGroundDistanceKm(latLonToVector(0, 179.9), latLonToVector(0, -179.9)), EARTH_RADIUS_KM * .2 * Math.PI / 180);
  const seam = drawingArea(latLonToVector(0, 179.9), latLonToVector(0, -179.9));
  assert.equal(seam.circle?.longitude, 179.9); assert.ok(seam.circle!.radiusKm < 23);
  const pole = drawingArea(latLonToVector(90, 123), latLonToVector(89, -70));
  assert.equal(pole.circle?.latitude, 90); assert.equal(pole.circle?.longitude, 0);
  near(pole.circle!.radiusKm, EARTH_RADIUS_KM * Math.PI / 180);
  near(shortestGroundDistanceKm(latLonToVector(0, 0), latLonToVector(0, 180)), Math.PI * EARTH_RADIUS_KM);
});
test('drawing rejects measured fine/large and incomplete strokes rather than silently clamping; numeric range stays independent', () => {
  const center = latLonToVector(0, 0);
  for (const radius of [.1, .99, 500.1, 1000]) {
    const measured = drawingArea(center, latLonToVector(0, radius / EARTH_RADIUS_KM * 180 / Math.PI));
    assert.equal(measured.circle, null); near(measured.measuredRadiusKm, radius);
    assert.match(measured.message, /Use numeric coordinates\/radius for finer or larger areas/);
  }
  for (const radius of [1.01, 25, 499.99]) {
    const measured = drawingArea(center, latLonToVector(0, radius / EARTH_RADIUS_KM * 180 / Math.PI));
    near(measured.circle!.radiusKm, radius);
  }
  assert.equal(drawingArea(center, center).circle, null);
  assert.match(drawingArea(center, center).message, /Drag to set a radius/);
  assert.equal(drawingArea({ x: NaN, y: 0, z: 0 }, center).circle, null);
  for (const radiusKm of [.001, 25, 1000, Number.MAX_VALUE]) assert.equal(validAreaCircle({ latitude: 0, longitude: 0, radiusKm }), true);
  for (const value of [{ latitude: 91, longitude: 0, radiusKm: 25 }, { latitude: 0, longitude: -181, radiusKm: 25 }, { latitude: 0, longitude: 0, radiusKm: .0009 }, { latitude: 0, longitude: 0, radiusKm: Infinity }]) assert.equal(validAreaCircle(value), false);
});
test('near-side input rejects the grazing rim and far side independently of zoom and unnormalized ray length', () => {
  const point = { x: 1, y: 0, z: 0 };
  assert.equal(stableNearSideHit(point, { x: -1, y: 0, z: 0 }), true);
  assert.equal(stableNearSideHit(point, { x: 1, y: 0, z: 0 }), false);
  assert.equal(stableNearSideHit(point, { x: -.019, y: Math.sqrt(1 - .019 ** 2), z: 0 }), false);
  assert.equal(stableNearSideHit(point, { x: -.021, y: Math.sqrt(1 - .021 ** 2), z: 0 }), true);
  assert.equal(stableNearSideHit({ x: 7, y: 0, z: 0 }, { x: -4, y: 0, z: 0 }), true);
  assert.equal(stableNearSideHit(point, { x: 0, y: 0, z: 0 }), false);
});
test('redraw generation advances without changing an applied choice or wrapping an exhausted sequence', () => {
  assert.equal(nextAreaGeneration(), 1); assert.equal(nextAreaGeneration(7, 4, null), 8);
  assert.equal(nextAreaGeneration(NaN, Infinity, -1, 2.5, undefined, 1), 2);
  assert.throws(() => nextAreaGeneration(Number.MAX_SAFE_INTEGER), /exhausted/);
});
