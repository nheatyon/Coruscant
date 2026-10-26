import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaSignature, circleReadouts, createEmptyBrief, validateBrief } from '../../shared/validation.js';
import { normalizeReference } from '../../shared/reference.js';
import { validBrief } from '../helpers/brief.js';

test('a reviewed synthetic brief keeps reference dates separate from requested UTC windows', () => {
  const { value, fieldErrors } = validateBrief(validBrief());
  assert.deepEqual(fieldErrors, {});
  assert.equal(value?.baselineDate, '2026-10-07');
  assert.equal(value?.recentDate, '2026-10-14');
  assert.equal(value?.requestedWindow?.startUtc, '2026-10-23T08:00:00.000Z');
  assert.equal(value?.maxResolutionM, 10);
});
test('untouched defaults cannot pass; deliberate zero-origin choice plus separate confirmation can', () => {
  const empty = createEmptyBrief();
  assert.equal(empty.baselineDate, ''); assert.equal(empty.recentDate, '');
  assert.ok(validateBrief(empty).fieldErrors.areaChoice);
  const b = validBrief({ latitude: '0', longitude: '0', radiusKm: '25' });
  assert.ok(validateBrief(b).value);
  b.areaConfirmation = null;
  assert.ok(validateBrief(b).fieldErrors.areaConfirmation);
  b.areaConfirmation = areaSignature(b.areaChoice!);
  b.latitude = '';
  assert.ok(validateBrief(b).fieldErrors.latitude);
  assert.ok(validateBrief(b).fieldErrors.areaChoice);
});
test('a deliberate globe pick uses the same exact confirmed circle contract and preserves its method', () => {
  const brief = validBrief(); brief.areaChoice = { ...brief.areaChoice!, method: 'globe', generation: 2 }; brief.areaConfirmation = null;
  assert.ok(validateBrief(brief).fieldErrors.areaConfirmation);
  brief.areaConfirmation = areaSignature(brief.areaChoice);
  assert.equal(validateBrief(brief).value?.area.method, 'globe');
  brief.longitude = '-9.6'; assert.ok(validateBrief(brief).fieldErrors.areaChoice);
});
test('actual coordinate changes invalidate old intent and confirmation, while equivalent values remain geographic zero', () => {
  const b = validBrief(); b.radiusKm = '30';
  assert.ok(validateBrief(b).fieldErrors.areaChoice);
  b.areaChoice = { ...b.areaChoice!, radiusKm: 30, generation: 2 };
  assert.ok(validateBrief(b).fieldErrors.areaConfirmation);
  b.areaConfirmation = areaSignature(b.areaChoice);
  assert.equal(validateBrief(b).value?.area.radiusKm, 30);
});
test('reference dates are mandatory and ordered even when general timing is to be discussed', () => {
  for (const pair of [['', ''], ['2026-02-30', '2026-03-02'], ['2026-10-14', '2026-10-14'], ['2026-10-15', '2026-10-14']]) {
    const b = validBrief({ baselineDate: pair[0]!, recentDate: pair[1]!, timingToDiscuss: true });
    assert.equal(validateBrief(b).value, undefined);
  }
  const b = validBrief({ timingToDiscuss: true });
  assert.equal(validateBrief(b).value?.requestedWindow, null);
});
test('ground-resolution units normalize while blank optional facts and legitimate zero cloud remain distinct', () => {
  assert.equal(validateBrief(validBrief({ maxResolution: '500', resolutionUnit: 'cm' })).value?.maxResolutionM, 5);
  assert.equal(validateBrief(validBrief({ maxResolution: '0.005', resolutionUnit: 'km' })).value?.maxResolutionM, 5);
  assert.equal(validateBrief(validBrief({ maxResolution: '', cloudCover: '' })).value?.cloudCover, null);
  assert.equal(validateBrief(validBrief({ cloudCover: '0' })).value?.cloudCover, 0);
  for (const n of ['0', '-1', 'Infinity', 'NaN']) assert.ok(validateBrief(validBrief({ maxResolution: n })).fieldErrors.maxResolution);
  assert.ok(validateBrief(validBrief({ cloudCover: '101' })).fieldErrors.cloudCover);
});
test('unsupported service/sensor/output cannot be relabeled into a supported saved journey', () => {
  assert.ok(validateBrief(validBrief({ family: 'Communications' })).fieldErrors.family);
  for (const sensor of ['UNSUPPORTED-SENSOR', 'PAN', 'OTHER']) assert.ok(validateBrief(validBrief({ sensor })).fieldErrors.sensor);
  for (const output of ['Video', 'GIS']) assert.ok(validateBrief(validBrief({ outputs: [output] })).fieldErrors.outputs);
  assert.equal(validateBrief(validBrief({ sensor: 'OPEN' })).value?.sensor, 'OPEN');
});
test('DST gaps and repeated wall times are refused instead of silently normalized', () => {
  for (const start of ['2026-03-08T02:30', '2026-11-01T01:30']) {
    const b = validBrief({ timezone: 'America/New_York', windowStart: start, windowEnd: '2026-12-01T12:00' });
    assert.ok(validateBrief(b).fieldErrors.windowStart);
  }
  const b = validBrief({ timezone: 'Europe/Dublin', windowStart: '2026-10-23T08:00', windowEnd: '2026-10-23T09:00' });
  assert.equal(validateBrief(b).value?.requestedWindow?.startUtc, '2026-10-23T07:00:00.000Z');
  assert.equal(validateBrief(b).value?.baselineDate, '2026-10-07');
});
test('bounded contact, unknowns and evidence validation preserves the original prose', () => {
  const purpose = '  Our original question.\nKeep this second line.  ';
  assert.equal(validateBrief(validBrief({ purpose })).value?.purpose, purpose);
  assert.ok(validateBrief(validBrief({ unknowns: Array(21).fill('Unresolved fact').join('\n') })).fieldErrors.unknowns);
  assert.ok(validateBrief(validBrief({ contact: { name: 'Demo', email: 'invalid', organization: 'Demo' } })).fieldErrors['contact.email']);
  assert.ok(validateBrief(validBrief({ selectedEvidence: [{ itemId: 'same', evidenceVersion: 'v1' }, { itemId: 'same', evidenceVersion: 'v1' }] })).fieldErrors.selectedEvidence);
});
test('malformed external JSON becomes named validation errors, never an exception', () => {
  for (const input of [null, [], {}, { ...validBrief(), resolutionUnit: { toString: null } }, { ...validBrief(), contact: null }, { ...validBrief(), selectedEvidence: [null] }]) {
    assert.doesNotThrow(() => validateBrief(input));
    assert.equal(validateBrief(input).value, undefined);
  }
});
test('small and global circle readouts remain finite and never wrap large radii', () => {
  assert.ok(circleReadouts(0.001).areaKm2 > 0);
  const earth = circleReadouts(Math.PI * 6371.0088);
  assert.equal(circleReadouts(1e20).areaKm2, earth.areaKm2);
  assert.equal(circleReadouts(1e20).diameterKm, earth.diameterKm);
});
test('reference aliases normalize identifiers without establishing permission', () => {
  assert.equal(normalizeReference('srs-oil01-23456'), 'SRS0110123456');
});

test('only validated nested fields enter a saved brief, with no client capability or role claims', () => {
  const b = validBrief();
  const hostile = { ...b, areaChoice: { ...b.areaChoice!, canSelectOffers: true }, contact: { ...b.contact, role: 'STAFF' }, selectedEvidence: [{ itemId: 'demo-sar-03', evidenceVersion: 'demo-evidence-v1', resolutionM: 0.01, verified: true }] };
  const result = validateBrief(hostile).value!;
  assert.ok(result);
  assert.equal(Object.hasOwn(result.area, 'canSelectOffers'), false);
  assert.equal(Object.hasOwn(result.contact, 'role'), false);
  assert.deepEqual(result.selectedEvidence, [{ itemId: 'demo-sar-03', evidenceVersion: 'demo-evidence-v1' }]);
});
