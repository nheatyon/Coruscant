import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDecimals, decimalsEqual, normalizeDecimal } from '../../shared/decimal.js';
import { validateBrief } from '../../shared/validation.js';
import { createEmptyQuoteDraft, createEmptySchedule, customerReplyAllowed, quoteToInput, revisionAllowed, revisionToInput,
  statusAfterMessage, statusAfterRevision, validateBriefRevision, validateDecline, validateMessage,
  validateQuoteDraft, validateQuoteForPublication, validateSchedule, type QuoteDraftInput, type ScheduleInput } from '../../shared/workflow.js';
import { validBrief } from '../helpers/brief.js';

const now = '2026-10-21T12:00:00.000Z';
const brief = () => validateBrief(validBrief()).value!;
const quote = (overrides: Partial<QuoteDraftInput> = {}): QuoteDraftInput => ({ ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '2400.00', scope: 'Demonstration SAR/Imagery comparison within the reviewed area and requested dates/window.', licence: 'Local demonstration review only; synthetic illustration, no collection.', validUntil: '2026-10-22T18:00', ...overrides });
const schedule = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({ ...createEmptySchedule(), provider: 'Coruscant demonstration material', start: '2026-10-24T10:00', end: '2026-10-24T12:00', timezone: 'UTC', ...overrides });

test('commercial values retain decimal precision and compare beyond floating-point limits', () => {
  assert.equal(normalizeDecimal('0002400.0000'), '2400.0000');
  assert.equal(normalizeDecimal('.000000000000000001'), '0.000000000000000001');
  assert.equal(compareDecimals('9007199254740993.000000000000000001', '9007199254740993.000000000000000000'), 1);
  assert.equal(compareDecimals('0.1000000000000000001', '0.1'), 1);
  assert.ok(decimalsEqual('2400.00', '02400'));
  for (const raw of ['', '-1', '+1', '1e3', 'NaN', 'Infinity', '1,000', '1 000']) assert.throws(() => normalizeDecimal(raw));
});
test('incomplete drafts stay valid without price/time defaults but malformed entered values fail', () => {
  const empty = createEmptyQuoteDraft();
  assert.equal(empty.currency, 'USD'); assert.equal(empty.priceType, ''); assert.equal(empty.validUntil, '');
  assert.equal(validateQuoteDraft(empty).value?.priceType, null);
  assert.ok(validateQuoteDraft(quote({ amount: '' })).value);
  assert.ok(validateQuoteDraft(quote({ amount: '0' })).value);
  for (const amount of ['-0.1', '1e6', 'NaN']) assert.ok(validateQuoteDraft(quote({ amount })).fieldErrors.amount);
  assert.ok(validateQuoteDraft(quote({ validUntil: '2026-02-30T10:00' })).fieldErrors.validUntil);
  assert.ok(validateQuoteDraft(quote({ priceType: 'RANGE', minimum: '2.01', maximum: '2.00' })).fieldErrors.maximum);
  const past = validateQuoteDraft(quote({ validUntil: '2026-10-20T10:00' }));
  assert.ok(past.value); // Draft saving is not publication; future expiry is a publication guard.
  assert.ok(validateQuoteForPublication(past.value!, brief(), now).fieldErrors.validUntil);
});
test('publication requires complete current terms, ordered comparison dates and resolved planning window', () => {
  const b = brief(), terms = validateQuoteDraft(quote()).value!;
  const published = validateQuoteForPublication(terms, b, now).value!;
  assert.ok(published); assert.equal(published.amount, '2400.00'); assert.equal(published.validUntil, '2026-10-22T18:00:00.000Z');
  const missing = validateQuoteForPublication(validateQuoteDraft(createEmptyQuoteDraft()).value!, b, now).fieldErrors;
  for (const key of ['priceType', 'scope', 'licence', 'validUntil']) assert.ok(missing[key]);
  assert.ok(validateQuoteForPublication(terms, { ...b, baselineDate: '2026-02-30' }, now).fieldErrors.comparisonDates);
  assert.ok(validateQuoteForPublication(terms, { ...b, recentDate: b.baselineDate }, now).fieldErrors.comparisonDates);
  assert.ok(validateQuoteForPublication(terms, { ...b, requestedWindow: null }, now).fieldErrors.requestedWindow);
  assert.ok(validateQuoteForPublication(terms, { ...b, requestedWindow: { ...b.requestedWindow!, endUtc: b.requestedWindow!.startUtc } }, now).fieldErrors.requestedWindow);
  assert.ok(validateQuoteForPublication(terms, b, '2026-10-22T18:00:00Z').fieldErrors.validUntil);
});
test('equal endpoints remain a range and recommendations use only saved exact evidence identities', () => {
  const b = brief(); b.selectedEvidence = [{ itemId: 'demo-sar-03', evidenceVersion: 'demo-evidence-v1' }];
  const terms = validateQuoteDraft(quote({ priceType: 'RANGE', minimum: '2400.000', maximum: '2400.00', recommendedEvidence: [{ ...b.selectedEvidence[0]!, verified: true } as never] })).value!;
  const published = validateQuoteForPublication(terms, b, now).value!;
  assert.equal(published.priceType, 'RANGE'); assert.ok(decimalsEqual(published.minimum!, published.maximum!));
  assert.deepEqual(published.recommendedEvidence, b.selectedEvidence);
  assert.equal(Object.hasOwn(published, 'amountFinal'), false);
  assert.ok(validateQuoteForPublication({ ...terms, recommendedEvidence: [{ itemId: 'demo-sar-03', evidenceVersion: 'private-new-version' }] }, b, now).fieldErrors.recommendedEvidence);
  assert.deepEqual(validateQuoteDraft(quoteToInput(published)).value, published);
});
test('schedule has no provider/date/zone defaults, stays inside accepted window and permits no tracked object', () => {
  assert.deepEqual(createEmptySchedule(), { provider: '', start: '', end: '', timezone: '', trackedItemIds: [], notes: '' });
  const known = new Set(['demo-sar-03']);
  const value = validateSchedule({ ...schedule(), privateRole: 'OWNER' }, brief(), known).value!;
  assert.ok(value); assert.deepEqual(value.trackedItemIds, []); assert.equal(value.startUtc, '2026-10-24T10:00:00.000Z');
  assert.equal(Object.hasOwn(value, 'privateRole'), false);
  assert.ok(validateSchedule(schedule({ start: '2026-10-23T07:59' }), brief(), known).fieldErrors.acceptedWindow);
  assert.ok(validateSchedule(schedule({ end: '2026-10-25T18:01' }), brief(), known).fieldErrors.acceptedWindow);
  assert.ok(validateSchedule(schedule({ end: '2026-10-24T10:00' }), brief(), known).fieldErrors.end);
  assert.ok(validateSchedule(schedule({ timezone: '' }), brief(), known).fieldErrors.timezone);
  assert.ok(validateSchedule(schedule({ trackedItemIds: ['unknown'] }), brief(), known).fieldErrors.trackedItemIds);
  assert.ok(validateSchedule(schedule({ trackedItemIds: ['demo-sar-03', 'demo-sar-03'] }), brief(), known).fieldErrors.trackedItemIds);
});
test('schedule conversion rejects ambiguous or nonexistent wall times and preserves calendar context', () => {
  for (const start of ['2026-03-08T02:30', '2026-11-01T01:30']) assert.ok(validateSchedule(schedule({ start, end: '2026-12-01T12:00', timezone: 'America/New_York' }), brief(), new Set()).fieldErrors.start);
  const b = brief(), value = validateSchedule(schedule({ start: '2026-10-24T11:00', end: '2026-10-24T13:00', timezone: 'Europe/Dublin' }), b, new Set()).value!;
  assert.equal(value.startUtc, '2026-10-24T10:00:00.000Z'); assert.equal(value.localStart, '2026-10-24T11:00');
  assert.equal(b.baselineDate, '2026-10-07'); assert.equal(b.recentDate, '2026-10-14');
});
test('private revision preserves original contact and resolved instants without adding public-submission consent', () => {
  const old = brief(), draft = revisionToInput(old); draft.purpose = 'A carefully revised question.';
  assert.equal(draft.acknowledged, false);
  const value = validateBriefRevision(draft, old).value!;
  assert.ok(value); assert.deepEqual(value.contact, old.contact); assert.deepEqual(value.requestedWindow, old.requestedWindow);
  assert.ok(validateBriefRevision({ ...draft, contact: { ...old.contact, name: 'Different contact' } }, old).fieldErrors.contact);
  assert.ok(validateBriefRevision({ ...draft, baselineDate: '', timingToDiscuss: true }, old).fieldErrors.baselineDate);
  assert.ok(validateBriefRevision({ ...draft, radiusKm: '30' }, old).fieldErrors.areaChoice);
  assert.equal(Object.hasOwn(value, 'acknowledged'), false);
});
test('unrelated revision does not re-resolve existing UTC window or deadline through current timezone rules', () => {
  const old = brief();
  old.timezone = 'America/New_York';
  old.requestedWindow = { localStart: '2026-11-01T01:15', localEnd: '2026-11-01T01:45', timezone: old.timezone, startUtc: '2026-11-01T05:15:00.000Z', endUtc: '2026-11-01T05:45:00.000Z' };
  old.deadline = { local: '2026-11-01T01:50', timezone: old.timezone, utc: '2026-11-01T05:50:00.000Z' };
  const raw = revisionToInput(old); raw.purpose = 'Preserve the already resolved request timing.';
  const value = validateBriefRevision(raw, old).value!;
  assert.ok(value); assert.deepEqual(value.requestedWindow, old.requestedWindow); assert.deepEqual(value.deadline, old.deadline);
  assert.ok(validateBriefRevision({ ...raw, windowStart: '2026-11-01T01:20' }, old).fieldErrors.windowStart);
  assert.ok(validateBriefRevision({ ...raw, deadline: '2026-11-01T01:55' }, old).fieldErrors.deadline);
});
test('previewed messages/reasons preserve exact text and enforce the approved separate bounds', () => {
  assert.equal(validateMessage({ message: '  Please confirm this detail.\nKeep exact wording.  ', actorId: 'staff-admin' }).value?.message, '  Please confirm this detail.\nKeep exact wording.  ');
  assert.deepEqual(validateMessage({ message: 'x', actorId: 'staff-admin' }).value, { message: 'x' });
  assert.ok(validateMessage({ message: 'x'.repeat(4000) }).value); assert.ok(validateMessage({ message: 'x'.repeat(4001) }).fieldErrors.message);
  assert.ok(validateDecline({ reason: 'x'.repeat(2000) }).value); assert.ok(validateDecline({ reason: 'x'.repeat(2001) }).fieldErrors.reason);
  assert.ok(validateMessage({ message: '  ' }).fieldErrors.message); assert.ok(validateDecline({ reason: '' }).fieldErrors.reason);
});
test('commercial conversation does not change accepted work or let time advance status', () => {
  assert.ok(customerReplyAllowed('Needs information')); assert.equal(customerReplyAllowed('Submitted'), false);
  assert.equal(statusAfterMessage('Needs information', 'CUSTOMER'), 'In review');
  assert.equal(statusAfterMessage('Needs information', 'STAFF'), 'Needs information');
  for (const state of ['Quote ready', 'Accepted', 'Scheduled', 'Delivered'] as const) {
    assert.equal(statusAfterMessage(state, 'CUSTOMER'), state); assert.equal(statusAfterMessage(state, 'STAFF'), state);
  }
  assert.equal(statusAfterRevision('Quote ready'), 'In review'); assert.equal(statusAfterRevision('Needs information'), 'In review');
  for (const state of ['Accepted', 'Scheduled', 'Delivered'] as const) assert.equal(revisionAllowed(state), false);
});
