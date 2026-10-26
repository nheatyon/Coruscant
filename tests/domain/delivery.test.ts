import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeliveryNote } from '../../shared/delivery.js';

test('delivery validates the previewed customer-visible note without rewriting text or trusting readiness', () => {
  const note = '  The reviewed illustrative pair and finding are supplied.\nNo actual acquisition is claimed.  ';
  assert.deepEqual(validateDeliveryNote({ note, ready: true, waived: true, dateAlignment: 'ALIGNED', actorId: 'customer' }).value, { note });
  assert.equal(validateDeliveryNote({ note: 'x'.repeat(4000) }).value?.note.length, 4000);
});
test('delivery requires nonblank text within the approved 4000-character limit', () => {
  for (const value of [null, [], 'delivered', {}, { note: 1 }, { note: null }, { note: '' }, { note: ' \n\t ' }, { note: 'x'.repeat(4001) }]) assert.ok(validateDeliveryNote(value).fieldErrors.note);
});
