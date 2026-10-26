import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLinkNavigation, fitView, geometry, inversePoint, panBy, zoomAt } from '../../shared/image-view.js';
const image = { width: 1600, height: 1000 }, stage = { width: 800, height: 600 };
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);

test('fit centers the full oriented image with letterboxing and inverse rejects non-image space', () => {
  const view = fitView(); assert.deepEqual(geometry(view, image, stage), { scale: .5, tx: 0, ty: 50 });
  assert.equal(inversePoint(view, { x: 400, y: 20 }, image, stage), null);
  assert.equal(inversePoint(view, { x: -1, y: 300 }, image, stage), null);
  assert.deepEqual(inversePoint(view, { x: 400, y: 300 }, image, stage), { x: .5, y: .5 });
  assert.deepEqual(inversePoint(view, { x: 0, y: 50 }, image, stage), { x: 0, y: 0 });
});
test('pointer zoom preserves the exact image location beneath the pointer and clamps relative zoom', () => {
  const pointer = { x: 620, y: 175 }, before = inversePoint(fitView(), pointer, image, stage)!;
  const zoomed = zoomAt(fitView(), 1.25, pointer, image, stage), after = inversePoint(zoomed, pointer, image, stage)!;
  near(after.x, before.x); near(after.y, before.y); assert.equal(zoomed.zoom, 1.25); assert.equal(zoomed.fitted, false);
  assert.equal(zoomAt(zoomed, 1e9, pointer, image, stage).zoom, 20);
  assert.equal(zoomAt(zoomed, 1e-9, pointer, image, stage).zoom, .1);
});
test('pan, resize and overlay inversion preserve normalized coordinates at full precision', () => {
  const normalized = { x: .4234567890123, y: .5789012345678 }, panned = panBy(zoomAt(fitView(), 2, { x: 400, y: 300 }, image, stage), 40, -40, image, stage);
  const resizedStage = { width: 1000, height: 750 }, g = geometry(panned, image, resizedStage);
  const pointer = { x: normalized.x * image.width * g.scale + g.tx, y: normalized.y * image.height * g.scale + g.ty };
  const recovered = inversePoint(panned, pointer, image, resizedStage)!;
  near(recovered.x, normalized.x); near(recovered.y, normalized.y);
  assert.equal(panned.fitted, false); near(panned.centerX, .475); near(panned.centerY, .54);
  assert.equal(geometry(fitView(), image, resizedStage).scale, .625);
});
test('linking is viewing convenience only for equal positive dimensions', () => {
  assert.equal(canLinkNavigation(image, { ...image }), true);
  assert.equal(canLinkNavigation(image, { width: 1600, height: 999 }), false);
  assert.equal(canLinkNavigation({ width: 0, height: 0 }, { width: 0, height: 0 }), false);
  assert.equal(inversePoint(fitView(), { x: 0, y: 0 }, { width: 0, height: 0 }, stage), null);
});
