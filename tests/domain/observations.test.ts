import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateObservation } from '../../shared/observations.js';
import { fitView, forwardPoint, inversePoint, isPointClick, panBy, zoomAt } from '../../shared/image-view.js';

test('observation content keeps full image precision and exact authored text, omitting injected authority', () => {
  const value = validateObservation({ x: 0.123456789123, y: 0.987654321987, text: '  Dark area beside the river.\nIllustrative only.  ', authorId: 'another-author', organizationId: 'org-b', contentVersion: 9 }).value!;
  assert.deepEqual(value, { x: 0.123456789123, y: 0.987654321987, text: '  Dark area beside the river.\nIllustrative only.  ' });
  assert.deepEqual(validateObservation({ x: 0, y: 1, text: 'Image boundary.' }).value, { x: 0, y: 1, text: 'Image boundary.' });
});
test('observation coordinates reject absent, nonnumeric, nonfinite or outside-image values', () => {
  for (const invalid of [undefined, null, '', '0.5', NaN, Infinity, -Infinity, -0.00001, 1.00001]) {
    assert.ok(validateObservation({ x: invalid, y: 0.5, text: 'Actual note.' }).fieldErrors.x);
    assert.ok(validateObservation({ x: 0.5, y: invalid, text: 'Actual note.' }).fieldErrors.y);
  }
  for (const invalid of [null, [], 'point']) assert.equal(validateObservation(invalid).value, undefined);
});
test('observation requires actual nonblank note with the approved 2000-character bound', () => {
  for (const text of [undefined, null, 7, '', ' \t\n ']) assert.ok(validateObservation({ x: 0.5, y: 0.5, text }).fieldErrors.text);
  assert.equal(validateObservation({ x: 0.5, y: 0.5, text: 'x'.repeat(2000) }).value?.text.length, 2000);
  assert.ok(validateObservation({ x: 0.5, y: 0.5, text: 'x'.repeat(2001) }).fieldErrors.text);
});
test('saved image point follows pan, pointer zoom and resize without rounding its normalized identity', () => {
  const image = { width: 1600, height: 1000 }, stage = { width: 800, height: 600 }, resized = { width: 1200, height: 900 };
  const point = { x: 0.43, y: 0.537654321987 };
  const fit = forwardPoint(fitView(), point, image, stage)!;
  assert.equal(fit.x, 344); assert.ok(Math.abs(fit.y - 318.8271609935) < 1e-10);
  const zoomed = zoomAt(fitView(), 1.25, fit, image, stage);
  const anchored = forwardPoint(zoomed, point, image, stage)!;
  assert.ok(Math.abs(anchored.x - fit.x) < 1e-10); assert.ok(Math.abs(anchored.y - fit.y) < 1e-10);
  const panned = panBy(zoomed, 40, -20, image, stage);
  const moved = forwardPoint(panned, point, image, stage)!;
  assert.ok(Math.abs(moved.x - fit.x - 40) < 1e-10); assert.ok(Math.abs(moved.y - fit.y + 20) < 1e-10);
  for (const size of [stage, resized]) {
    const rendered = forwardPoint(panned, point, image, size)!;
    const recovered = inversePoint(panned, rendered, image, size)!;
    assert.ok(Math.abs(recovered.x - point.x) < 1e-12); assert.ok(Math.abs(recovered.y - point.y) < 1e-12);
  }
  assert.equal(forwardPoint(fitView(), { x: 1.1, y: 0.5 }, image, stage), null);
  assert.equal(forwardPoint(fitView(), point, image, { width: 0, height: 600 }), null);
});
test('point click threshold excludes six pixels and a drag that returns to its origin', () => {
  assert.equal(isPointClick({ x: 10, y: 10 }, { x: 13, y: 14 }), true);
  assert.equal(isPointClick({ x: 10, y: 10 }, { x: 16, y: 10 }), false);
  assert.equal(isPointClick({ x: 10, y: 10 }, { x: 10, y: 10 }, 20), false);
  assert.equal(isPointClick({ x: NaN, y: 10 }, { x: 10, y: 10 }), false);
});
