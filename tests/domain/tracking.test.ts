import test from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedBrief, RequestStatus } from '../../shared/contracts.js';
import type { QuoteProjection, ScheduleProjection } from '../../shared/workflow.js';
import { clarificationHref, missionGroup, missionHref, missionNextStep, missionWindow, presentMissions, trackingAuthority, type MissionsSnapshot, type TrackingAuthority, type TrackingRequest } from '../../shared/tracking.js';

const now = '2026-10-22T12:00:00.000Z';
const owner: TrackingAuthority = { role: 'OWNER', canSelectOffers: true, organizationId: 'workspace-river' };
function brief(): NormalizedBrief {
  return { purpose: 'Compare the two supplied fictional shoreline illustrations.', family: 'EO', sensor: 'SAR', outputs: ['Imagery'], area: { latitude: 41.2, longitude: -8.5, radiusKm: 18, method: 'coordinates', generation: 1 }, areaConfirmation: 'test-deliberate-circle', baselineDate: '2026-10-03', recentDate: '2026-10-10', timezone: 'Europe/Lisbon', maxResolutionM: 8, cloudCover: null, revisitHours: null, spectralRequirements: '', timingToDiscuss: false, requestedWindow: { startUtc: '2026-10-22T08:00:00.000Z', endUtc: '2026-10-25T20:00:00.000Z', localStart: '2026-10-22T09:00', localEnd: '2026-10-25T21:00', timezone: 'Europe/Lisbon' }, deadline: null, timingNotes: '', unknowns: ['Feasibility needs team review.'], contact: { name: 'Fictional shoreline researcher', email: 'shoreline@example.test', organization: 'Fictional river workspace' }, selectedEvidence: [] };
}
function request(id: string, status: RequestStatus, patch: Partial<TrackingRequest> = {}): TrackingRequest {
  return { id, reference: `SRS-DEMO-${id}`, organizationId: 'workspace-river', organizationName: 'Fictional river workspace', title: id, status, requestVersion: 1, briefRevision: 1, firstSavedAt: '2026-10-21T10:00:00.000Z', originalSubmittedContact: brief().contact, submittedAt: '2026-10-21T10:00:00.000Z', submittedBy: 'Fictional requester', brief: brief(), evidence: [], history: [], matchingState: 'Preliminary check ready', humanReview: 'Manual review required', responseTarget: null, messages: [], revisions: [], currentQuote: null, acceptedQuote: null, earlierQuotes: [], decisions: [], schedule: null, currentProposedPlan: null, earlierProposedPlans: [], acceptedPlan: null, result: null, detailAvailability: { quote: 'KNOWN', window: 'KNOWN', result: 'KNOWN' }, ...patch };
}
function quote(id: string, expiry = '2026-10-23T12:00:00.000Z'): QuoteProjection {
  return { id: `quote-${id}`, requestId: id, organizationId: 'workspace-river', state: 'PUBLISHED', briefRevision: 1, contentVersion: 1, terms: { priceType: 'FIXED', amount: '1750', minimum: null, maximum: null, currency: 'EUR', scope: 'Illustrative supplied comparison', licence: 'Demonstration use only', validUntil: expiry, recommendation: '', recommendedEvidence: [] }, pricedBrief: brief(), createdAt: '2026-10-21T11:00:00.000Z', publishedAt: '2026-10-21T11:05:00.000Z', actorId: 'staff-demo', actorName: 'Fictional staff' };
}
function schedule(id: string, startUtc: string, endUtc: string): ScheduleProjection {
  return { id: `plan-${id}`, requestId: id, organizationId: 'workspace-river', acceptedQuoteId: `quote-${id}`, briefRevision: 1, version: 1, provider: 'Fictional comparison desk', startUtc, endUtc, localStart: startUtc, localEnd: endUtc, timezone: 'UTC', trackedItemIds: [], notes: 'Staff recorded illustration plan; not execution.', createdAt: '2026-10-21T11:30:00.000Z', actorId: 'staff-demo', actorName: 'Fictional staff' };
}
function snapshot(requests: TrackingRequest[], patch: Partial<MissionsSnapshot> = {}): MissionsSnapshot {
  return { requests, serverNow: now, contextGeneration: 3, scope: { kind: 'ALL_AUTHORIZED_WORKSPACE_REQUESTS', organizationId: 'workspace-river', loaded: requests.length, total: requests.length }, completeness: 'COMPLETE', ...patch };
}

test('groups follow saved status and exact half-open UTC windows without advancing workflow', () => {
  for (const status of ['Submitted', 'In review', 'Needs information', 'Quote ready'] as const) assert.equal(missionGroup(request(status, status), now), 'Current');
  assert.equal(missionGroup(request('awaiting', 'Accepted'), now), 'Upcoming');
  const open = request('open', 'Scheduled', { schedule: schedule('open', now, '2026-10-22T13:00:00.000Z') });
  const elapsed = request('elapsed', 'Scheduled', { schedule: schedule('elapsed', '2026-10-22T10:00:00.000Z', now) });
  const future = request('future', 'Scheduled', { schedule: schedule('future', '2026-10-23T10:00:00.000Z', '2026-10-23T11:00:00.000Z') });
  assert.equal(missionGroup(open, now), 'Upcoming'); assert.equal(missionGroup(future, now), 'Upcoming'); assert.equal(missionGroup(elapsed, now), 'Current');
  assert.equal(missionGroup(request('delivered', 'Delivered', { schedule: future.schedule }), now), 'Past');
  assert.equal(elapsed.status, 'Scheduled'); assert.equal(missionNextStep(elapsed, now, owner).kind, 'AWAITING_DELIVERY');
  assert.equal(missionGroup(open, '2026-10-22T13:00:00.000Z'), 'Current'); assert.equal(open.status, 'Scheduled');
});

test('unknown or missing Scheduled windows remain unclassified and cannot imply no upcoming work', () => {
  const rows = [request('lost', 'Scheduled', { detailAvailability: { quote: 'KNOWN', window: 'UNAVAILABLE', result: 'KNOWN' } }), request('missing', 'Scheduled')];
  const result = presentMissions(snapshot(rows, { completeness: 'PARTIAL' }), now, owner);
  assert.deepEqual(result.unclassified.map(row => row.id), ['lost', 'missing']);
  assert.deepEqual(result.groups, { Current: [], Upcoming: [], Past: [] });
  assert.deepEqual(result.readouts.upcomingWindows, { known: 0, unknown: 2, complete: false });
  assert.deepEqual(result.readouts.decisionsAndNextSteps, { known: 0, unknown: 2, complete: false });
  assert.equal(result.incomplete, true); assert.equal(result.windows.length, 0);
  for (const row of rows) { assert.equal(missionGroup(row, now), null); assert.equal(missionNextStep(row, now, owner).kind, 'UNKNOWN'); }
});

test('attention uses clarification, live or expired quote, elapsed plan, accepted-awaiting-schedule priority', () => {
  const rows = [request('schedule', 'Accepted'), request('routine', 'In review'), request('elapsed', 'Scheduled', { schedule: schedule('elapsed', '2026-10-21T08:00:00.000Z', '2026-10-21T09:00:00.000Z') }), request('live', 'Quote ready', { currentQuote: quote('live') }), request('reply', 'Needs information'), request('expired', 'Quote ready', { currentQuote: quote('expired', now) })];
  const result = presentMissions(snapshot(rows), now, owner);
  assert.deepEqual(result.attention.map(row => row.request.id), ['reply', 'expired', 'live', 'elapsed', 'schedule']);
  assert.equal(result.readouts.decisionsAndNextSteps.known, 5); assert.equal(result.attention.some(row => row.request.id === 'routine'), false);
  assert.equal(missionNextStep(rows[5]!, now, owner).action, 'ASK_TEAM'); assert.equal(rows[5]!.status, 'Quote ready');
  assert.equal(missionNextStep(rows[0]!, now, owner).action, 'READ');
});

test('quote and clarification hints honor role, current organization and explicit offer authority', () => {
  const row = request('offer', 'Quote ready', { currentQuote: quote('offer') });
  assert.equal(missionNextStep(row, now, owner).action, 'DECIDE');
  for (const authority of [{ ...owner, role: 'REQUESTER' as const }, { ...owner, role: 'VIEWER' as const }, { ...owner, canSelectOffers: false }, { ...owner, organizationId: 'different-workspace' }, { ...owner, role: null }]) assert.equal(missionNextStep(row, now, authority).action, 'ASK_OWNER');
  const question = request('question', 'Needs information');
  assert.equal(missionNextStep(question, now, { ...owner, role: 'REQUESTER', canSelectOffers: false }).action, 'REPLY');
  assert.equal(missionNextStep(question, now, { ...owner, role: 'VIEWER' }).action, 'READ');
  assert.equal(missionNextStep(question, now, { ...owner, organizationId: null }).action, 'READ');
  assert.equal(missionNextStep(question, now, owner).href, clarificationHref(question));
});

test('upcoming windows are actual Scheduled plans, open first then nearest start, with provider and UTC preserved', () => {
  const rows = [request('later', 'Scheduled', { schedule: schedule('later', '2026-10-24T10:00:00.000Z', '2026-10-24T12:00:00.000Z') }), request('open-b', 'Scheduled', { schedule: schedule('open-b', '2026-10-22T11:00:00.000Z', '2026-10-22T15:00:00.000Z') }), request('near', 'Scheduled', { schedule: schedule('near', '2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z') }), request('open-a', 'Scheduled', { schedule: schedule('open-a', '2026-10-22T10:00:00.000Z', '2026-10-22T14:00:00.000Z') }), request('past', 'Delivered', { schedule: schedule('past', now, '2026-10-22T16:00:00.000Z') })];
  const result = presentMissions(snapshot(rows), now, owner);
  assert.deepEqual(result.windows.map(row => row.request.id), ['open-a', 'open-b', 'near', 'later']);
  assert.deepEqual(result.windows.map(row => row.label), ['Within planned window', 'Within planned window', 'Scheduled', 'Scheduled']);
  assert.equal(result.windows[0]!.provider, 'Fictional comparison desk'); assert.equal(result.windows[0]!.startUtc, rows[3]!.schedule!.startUtc);
  assert.equal(missionWindow(rows[4]!, now), null); assert.equal(missionWindow(request('unplanned', 'Accepted'), now), null);
});

test('failed quote facts and invalid date facts are unknown rather than expired or actionable', () => {
  const missing = request('missing', 'Quote ready');
  const failed = request('failed', 'Quote ready', { currentQuote: quote('failed'), detailAvailability: { quote: 'UNAVAILABLE', window: 'KNOWN', result: 'KNOWN' } });
  const invalid = request('invalid', 'Quote ready', { currentQuote: quote('invalid', '2026-02-30T12:00:00.000Z') });
  for (const row of [missing, failed, invalid]) assert.equal(missionNextStep(row, now, owner).kind, 'UNKNOWN');
  assert.equal(missionNextStep(request('time', 'Quote ready', { currentQuote: quote('time') }), 'not-a-UTC-time', owner).kind, 'UNKNOWN');
  const badWindow = request('window', 'Scheduled', { schedule: schedule('window', '2026-10-22T14:00:00.000Z', '2026-10-22T13:00:00.000Z') });
  assert.equal(missionGroup(badWindow, now), null); assert.equal(missionWindow(badWindow, now), null);
  const result = presentMissions(snapshot([missing, failed, invalid]), now, owner);
  assert.deepEqual(result.readouts.decisionsAndNextSteps, { known: 0, unknown: 3, complete: false });
});

test('loaded-scope readouts distinguish empty success from missing records and child detail failure', () => {
  const empty = presentMissions(snapshot([]), now, owner);
  assert.equal(empty.incomplete, false); assert.deepEqual(empty.readouts.missionsInView, { known: 0, unknown: 0, complete: true });
  const loaded = request('loaded', 'Submitted');
  const partial = presentMissions(snapshot([loaded], { completeness: 'PARTIAL', scope: { kind: 'ALL_AUTHORIZED_WORKSPACE_REQUESTS', organizationId: 'workspace-river', loaded: 1, total: 3 } }), now, owner);
  assert.deepEqual(partial.readouts.missionsInView, { known: 1, unknown: 2, complete: false });
  assert.deepEqual(partial.readouts.decisionsAndNextSteps, { known: 0, unknown: 2, complete: false });
  assert.equal(partial.incomplete, true); assert.equal(partial.groups.Current[0]!.id, loaded.id);
  const unknownResult = presentMissions(snapshot([request('done', 'Delivered', { detailAvailability: { quote: 'KNOWN', window: 'KNOWN', result: 'UNAVAILABLE' } })], { completeness: 'PARTIAL' }), now, owner);
  assert.equal(unknownResult.incomplete, true); assert.equal(unknownResult.groups.Past.length, 1);
});

test('stable deadline/title/identity ties and exact record links do not mutate saved inputs', () => {
  const rows = [request('b', 'Needs information', { title: 'Same title' }), request('a', 'Needs information', { title: 'Same title' }), request('z', 'Needs information', { title: 'Earlier title' })];
  const before = structuredClone(rows), result = presentMissions(snapshot(rows), now, owner);
  assert.deepEqual(result.attention.map(row => row.request.id), ['z', 'a', 'b']); assert.deepEqual(rows, before);
  const delivered = request('saved/id', 'Delivered', { organizationId: 'workspace one', result: { id: 'exact/result', title: 'Published supplied material', provider: 'Fictional staff', demonstration: true } });
  assert.equal(missionHref(delivered), '/workspaces/workspace%20one/missions/saved%2Fid');
  assert.equal(missionNextStep(delivered, now, owner).href, '/workspaces/workspace%20one/results/exact%2Fresult');
  assert.notEqual(missionNextStep(delivered, now, owner).href, missionHref(delivered));
  delivered.detailAvailability.result = 'UNAVAILABLE'; assert.equal(missionNextStep(delivered, now, owner).action, 'READ');
  assert.deepEqual(trackingAuthority({ role: 'VIEWER', canSelectOffers: false, organization: { id: 'workspace-river', name: 'Fictional river workspace' } }), { role: 'VIEWER', canSelectOffers: false, organizationId: 'workspace-river' });
});


test('Planning stays Current with no staff-review attention, actual schedule or invented submission time', () => {
  const row = request('saved-only', 'Planning', { submittedAt: null, submittedBy: null, originalSubmittedContact: null, humanReview: 'Not submitted' });
  const view = presentMissions(snapshot([row]), now, owner);
  assert.equal(missionGroup(row, now), 'Current'); assert.equal(missionNextStep(row, now, owner).kind, 'PLANNING');
  assert.equal(missionNextStep(row, now, owner).attention, false); assert.deepEqual(view.groups.Current, [row]);
  assert.equal(view.windows.length, 0); assert.equal(view.attention.length, 0); assert.equal(view.readouts.missionsInView.known, 1);
  assert.equal(row.submittedAt, null); assert.equal(row.status, 'Planning');
});
