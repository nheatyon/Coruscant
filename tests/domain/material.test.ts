import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareDateContext, createEmptyFindingReview, createEmptyResultDraft, DATE_DIFFERENCE_NOTICE, DELIVERY_DATE_BLOCKER,
  findingReviewScope, imageApprovalScope, resultRightsValid, validateFindingDraft, validateFindingReview,
  validateGrantResultAccess, validateImageApprove, validateImageMetadata, validateResultDraft, validateResultForPublication,
  type AcceptedDateContext, type FindingVersionSnapshot, type ImageVersionSnapshot } from '../../shared/material.js';

const now = '2026-10-21T12:00:00.000Z';
const context = (): AcceptedDateContext => ({ requestId: 'request-one', organizationId: 'org-a', acceptedQuoteId: 'quote-one', briefRevision: 2,
  baselineReferenceDate: '2026-10-07', recentReferenceDate: '2026-10-14', requestTimezone: 'Pacific/Auckland' });
const images = (): ImageVersionSnapshot[] => (['BASELINE', 'RECENT'] as const).map((role, index) => ({ assetId: `image-${role}`, resultId: 'result-one', contentVersion: 1, role,
  metadata: { name: `Fictional estuary — ${role}`, source: 'Coruscant original synthetic estuary scene v1', provider: 'Coruscant demonstration material', sensorContext: 'Synthetic illustration — not radar observations', permittedUse: 'Local testing and demonstration' },
  origin: { sourceAssetId: `demo-estuary-${role}`, recipeVersion: 'estuary-scenes-v1', illustrativeDate: index === 0 ? '2026-10-07' : '2026-10-14', dateBasis: 'D0_UTC_CALENDAR', actualCollection: null, demonstration: true,
    source: 'Coruscant original synthetic estuary scene v1', provider: 'Coruscant demonstration material', sensorContext: 'Synthetic illustration — not radar observations' },
  width: 1600, height: 1000, contentHash: String(index).repeat(64), createdAt: now }));
const metadata = () => validateResultDraft({ ...createEmptyResultDraft(), title: 'An illustrative estuary comparison', licence: 'Original demonstration material', permittedUse: 'Local review only' }).value!;
const finding = (): FindingVersionSnapshot => ({ findingId: 'finding-one', resultId: 'result-one', contentVersion: 1, answer: '  Larger dark region is visible.\nThis is an illustration.  ', limitations: 'Synthetic images cannot establish flooding, causation, passability, damage or calibrated area.', additionalSources: '', citations: images().map(image => ({ assetId: image.assetId, contentVersion: image.contentVersion })), createdAt: now });

test('result drafts preserve authored text and approved limits without manufacturing rights or collection', () => {
  const empty = createEmptyResultDraft(); assert.equal(empty.demonstration, true); assert.equal(empty.rightsExpiresAt, '');
  const saved = validateResultDraft({ ...empty, title: '  A title\nwith exact spacing  ', source: 'Original source', role: 'STAFF' }).value!;
  assert.equal(saved.title, '  A title\nwith exact spacing  '); assert.equal(saved.rightsExpiresAt, null); assert.equal(Object.hasOwn(saved, 'role'), false);
  for (const [key, max] of [['title', 200], ['provider', 2000], ['targetLabel', 500], ['source', 2000], ['uncertainty', 2000], ['licence', 2000], ['permittedUse', 2000]] as const) {
    assert.ok(validateResultDraft({ ...empty, [key]: 'x'.repeat(max) }).value);
    assert.ok(validateResultDraft({ ...empty, [key]: 'x'.repeat(max + 1) }).fieldErrors[key]);
  }
  assert.ok(validateResultDraft({ ...empty, demonstration: false }).fieldErrors.demonstration);
  assert.ok(validateResultDraft({ ...empty, rightsExpiresAt: '2026-02-30T10:00' }).fieldErrors.rightsExpiresAt);
  assert.equal(resultRightsValid(saved, now), false);
  assert.ok(validateResultForPublication(saved, now).fieldErrors.licence);
  const expired = { ...metadata(), rightsExpiresAt: now };
  assert.equal(resultRightsValid(expired, now), false); assert.ok(validateResultForPublication(expired, now).fieldErrors.rightsExpiresAt);
  assert.equal(resultRightsValid(metadata(), now), true);
});
test('recipe facts cannot be relabeled through descriptive metadata correction', () => {
  const source = images()[1]!;
  assert.deepEqual(validateImageMetadata({ ...source.metadata, arbitraryClaim: 'verified' }).value, source.metadata);
  for (const patch of [{ illustrativeDate: '2026-10-07' }, { actualCollection: now }, { role: 'BASELINE' }, { origin: source.origin }, { width: 200 }]) assert.equal(validateImageMetadata({ ...source.metadata, ...patch }).value, undefined);
  const corrected = validateImageMetadata({ ...source.metadata, name: 'Corrected descriptive caption' }).value!;
  assert.equal(corrected.name, 'Corrected descriptive caption'); assert.equal(Object.hasOwn(corrected, 'illustrativeDate'), false);
});
test('date equality compares calendar labels without shifting D0 dates into the request zone', () => {
  const accepted = context(), pair = images(), before = structuredClone({ accepted, pair });
  const comparison = compareDateContext(accepted, pair);
  assert.equal(comparison.status, 'ALIGNED'); assert.equal(comparison.rows[0].supplied?.illustrativeDate, '2026-10-07');
  assert.equal(comparison.accepted.requestTimezone, 'Pacific/Auckland'); assert.deepEqual({ accepted, pair }, before);
  assert.deepEqual(comparison.unequalRoles, []); assert.equal(comparison.rows[0].supplied?.actualCollection, null);
});
test('valid mismatch names exact roles/values; acknowledgment cannot make it aligned or waive delivery', () => {
  const accepted = { ...context(), baselineReferenceDate: '2026-10-06' }, comparison = compareDateContext(accepted, images());
  assert.equal(comparison.status, 'DIFFERENT'); assert.equal(comparison.notice, DATE_DIFFERENCE_NOTICE);
  assert.deepEqual(comparison.unequalRoles, ['BASELINE']); assert.equal(comparison.rows[0].requestedDate, '2026-10-06');
  assert.equal(comparison.rows[0].supplied?.illustrativeDate, '2026-10-07');
  assert.ok(validateImageApprove({ reason: 'Inspected both date labels and synthetic provenance.', dateContextInspected: true, discrepancyAcknowledged: false }, comparison).fieldErrors.discrepancyAcknowledged);
  assert.ok(validateImageApprove({ reason: 'Inspected the displayed discrepancy.', dateContextInspected: true, discrepancyAcknowledged: true }, comparison).value);
  assert.equal(comparison.status, 'DIFFERENT'); assert.equal(accepted.baselineReferenceDate, '2026-10-06');
  assert.equal(DELIVERY_DATE_BLOCKER, 'Delivery blocked: supplied comparison dates differ from the accepted reference dates.');
});
test('incomplete/malformed/duplicate date context cannot become valid by acknowledgment', () => {
  for (const pair of [images().slice(0, 1), [images()[0]!, images()[0]!, images()[1]!], images().map((image, index) => index ? { ...image, origin: { ...image.origin, illustrativeDate: '2026-02-30' } } : image)]) {
    const comparison = compareDateContext(context(), pair);
    assert.equal(comparison.status, 'INCOMPLETE');
    assert.ok(validateImageApprove({ reason: 'Checked', dateContextInspected: true, discrepancyAcknowledged: true }, comparison).fieldErrors.dateComparison);
  }
  assert.equal(compareDateContext({ ...context(), requestTimezone: 'invalid-zone' }, images()).status, 'INCOMPLETE');
});
test('finding validates authored bounds and exact same-result Baseline/Recent citations', () => {
  const current = finding(), pair = images();
  const value = validateFindingDraft({ ...current, citations: [...current.citations].reverse(), confidence: 99 }, 'result-one', pair).value!;
  assert.equal(value.answer, current.answer); assert.deepEqual(value.citations, current.citations); assert.equal(Object.hasOwn(value, 'confidence'), false);
  assert.ok(validateFindingDraft({ ...current, answer: 'x'.repeat(4001) }, 'result-one', pair).fieldErrors.answer);
  assert.ok(validateFindingDraft({ ...current, limitations: 'x'.repeat(2001) }, 'result-one', pair).fieldErrors.limitations);
  assert.ok(validateFindingDraft({ ...current, additionalSources: 'x'.repeat(2001) }, 'result-one', pair).fieldErrors.additionalSources);
  assert.ok(validateFindingDraft(current, 'another-result', pair).fieldErrors.citations);
  assert.ok(validateFindingDraft({ ...current, citations: [current.citations[0], current.citations[0]] }, 'result-one', pair).fieldErrors.citations);
  assert.ok(validateFindingDraft({ ...current, citations: current.citations.map(ref => ({ ...ref, contentVersion: 2 })) }, 'result-one', pair).fieldErrors.citations);
});
test('finding review is an actual five-item inspection with separate mismatch acknowledgment and reason', () => {
  const raw = createEmptyFindingReview(), aligned = compareDateContext(context(), images());
  assert.equal(validateFindingReview(raw, aligned).value, undefined);
  for (const key of Object.keys(raw.checklist) as (keyof typeof raw.checklist)[]) raw.checklist[key] = true;
  assert.ok(validateFindingReview(raw, aligned).value);
  const different = compareDateContext({ ...context(), baselineReferenceDate: '2026-10-06' }, images());
  assert.ok(validateFindingReview(raw, different).fieldErrors.discrepancyAcknowledged);
  assert.ok(validateFindingReview({ ...raw, discrepancyAcknowledged: true }, different).fieldErrors.reason);
  assert.ok(validateFindingReview({ ...raw, discrepancyAcknowledged: true, reason: 'Inspected the date table.' }, different).fieldErrors.limitationsExplainDateDiscrepancy);
  assert.ok(validateFindingReview({ ...raw, discrepancyAcknowledged: true, limitationsExplainDateDiscrepancy: true, reason: 'The authored limitations explain the exact requested/supplied Baseline difference.' }, different).value);
});
test('single-image approval excludes counterpart/counters, finding review depends on the complete cited pair', () => {
  const accepted = context(), pair = images(), result = metadata(), draft = finding();
  const beforeImage = imageApprovalScope(accepted, pair[0]!, result), beforeFinding = findingReviewScope(accepted, draft, pair, result);
  const recentCorrection = { ...pair[1]!, contentVersion: 2, metadata: { ...pair[1]!.metadata, name: 'Corrected Recent description' } };
  const newFinding = { ...draft, citations: [draft.citations[0]!, { assetId: recentCorrection.assetId, contentVersion: 2 }] };
  const unrelatedCounters = { ...result, materialVersion: 8, accessVersion: 4 };
  assert.deepEqual(imageApprovalScope(accepted, pair[0]!, unrelatedCounters), beforeImage);
  assert.notDeepEqual(findingReviewScope(accepted, newFinding, [pair[0]!, recentCorrection], result), beforeFinding);
  assert.notDeepEqual(imageApprovalScope(accepted, pair[0]!, { ...result, permittedUse: 'Changed rights' }), beforeImage);
  assert.notDeepEqual(imageApprovalScope({ ...accepted, acceptedQuoteId: 'different-acceptance' }, pair[0]!, result), beforeImage);
});
test('initial entitlement grant accepts reason only; it neither publishes nor trusts target/active claims', () => {
  assert.ok(validateGrantResultAccess({ reason: '  Intended workspace review.  ', active: false, organizationId: 'org-b', publish: true }).value);
  assert.deepEqual(validateGrantResultAccess({ reason: '  Intended workspace review.  ', active: false }).value, { reason: '  Intended workspace review.  ' });
  assert.ok(validateGrantResultAccess({ reason: ' ' }).fieldErrors.reason);
});
