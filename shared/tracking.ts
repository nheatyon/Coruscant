import type { Context, RequestProjection, Role } from './contracts.js';
import type { ResultLink } from './material.js';

export type DetailAvailability = 'KNOWN' | 'UNAVAILABLE';
export interface TrackingRequest extends RequestProjection {
  result: ResultLink | null;
  detailAvailability: { quote: DetailAvailability; window: DetailAvailability; result: DetailAvailability };
}
export interface MissionsSnapshot {
  requests: TrackingRequest[];
  contextGeneration: number;
  serverNow: string;
  scope: { kind: 'ALL_AUTHORIZED_WORKSPACE_REQUESTS'; organizationId: string; loaded: number; total: number };
  completeness: 'COMPLETE' | 'PARTIAL';
}
export interface RequestListPage {
  requests: RequestProjection[]; total: number; page: number; pageSize: 20;
  hasNext: boolean; nextPage: number | null; contextGeneration: number; serverNow: string;
}
/** Presentation hints only; actual writes still require current server authority. */
export interface TrackingAuthority { role: Role | null; canSelectOffers: boolean; organizationId: string | null }
export type MissionGroup = 'Current' | 'Upcoming' | 'Past';
export type NextStepKind = 'PLANNING' | 'CLARIFICATION' | 'QUOTE_LIVE' | 'QUOTE_EXPIRED' | 'AWAITING_DELIVERY' | 'AWAITING_SCHEDULE' | 'REVIEW' | 'DELIVERED' | 'UNKNOWN';
export interface MissionNextStep {
  kind: NextStepKind; label: string; href: string;
  action: 'REPLY' | 'READ' | 'DECIDE' | 'ASK_OWNER' | 'ASK_TEAM' | 'VIEW_PLAN' | 'VIEW_RESULT';
  attention: boolean; deadlineUtc: string | null;
}
export interface MissionWindow {
  request: TrackingRequest; startUtc: string; endUtc: string; provider: string;
  state: 'OPEN' | 'UPCOMING'; label: 'Within planned window' | 'Scheduled'; href: string;
}
export interface TrackingCount { known: number; unknown: number; complete: boolean }
export interface MissionsPresentation {
  readouts: { missionsInView: TrackingCount; decisionsAndNextSteps: TrackingCount; upcomingWindows: TrackingCount };
  attention: { request: TrackingRequest; nextStep: MissionNextStep }[];
  windows: MissionWindow[];
  groups: Record<MissionGroup, TrackingRequest[]>;
  unclassified: TrackingRequest[];
  incomplete: boolean;
}

export function trackingAuthority(context: Pick<Context, 'role' | 'canSelectOffers' | 'organization'>): TrackingAuthority {
  return { role: context.role, canSelectOffers: context.canSelectOffers, organizationId: context.organization?.id ?? null };
}

function utc(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 19) === value.slice(0, 19) ? result : null;
}
export function missionHref(request: Pick<RequestProjection, 'organizationId' | 'id'>): string {
  return `/workspaces/${encodeURIComponent(request.organizationId)}/missions/${encodeURIComponent(request.id)}`;
}
export function clarificationHref(request: Pick<RequestProjection, 'organizationId' | 'id'>): string {
  return `/workspaces/${encodeURIComponent(request.organizationId)}/service-requests/${encodeURIComponent(request.id)}#clarifications`;
}
interface WindowState { kind: 'NONE' | 'UNKNOWN' | 'UPCOMING' | 'OPEN' | 'ELAPSED'; start: number | null; end: number | null }
function windowState(request: TrackingRequest, now: string): WindowState {
  const unknown: WindowState = { kind: 'UNKNOWN', start: null, end: null };
  if (request.detailAvailability.window !== 'KNOWN') return unknown;
  if (!request.schedule) return ['Scheduled', 'Delivered'].includes(request.status) ? unknown : { kind: 'NONE', start: null, end: null };
  const start = utc(request.schedule.startUtc), end = utc(request.schedule.endUtc), at = utc(now);
  if (start === null || end === null || at === null || start >= end) return unknown;
  return { kind: at >= end ? 'ELAPSED' : at >= start ? 'OPEN' : 'UPCOMING', start, end };
}
/** Time changes presentation only: an elapsed saved Scheduled record remains Scheduled. */
export function missionGroup(request: TrackingRequest, now: string): MissionGroup | null {
  if (request.status === 'Delivered') return 'Past';
  if (request.status === 'Accepted') return 'Upcoming';
  if (request.status !== 'Scheduled') return 'Current';
  const window = windowState(request, now);
  return window.kind === 'ELAPSED' ? 'Current' : window.kind === 'OPEN' || window.kind === 'UPCOMING' ? 'Upcoming' : null;
}
/** Returned roles/actions are interface hints, never permission to execute a command. */
export function missionNextStep(request: TrackingRequest, now: string, authority: TrackingAuthority): MissionNextStep {
  const href = missionHref(request), deadline = request.acceptedQuote?.pricedBrief.deadline?.utc ?? request.brief.deadline?.utc ?? null;
  const step = (kind: NextStepKind, label: string, action: MissionNextStep['action'], attention = false, deadlineUtc: string | null = null, target = href): MissionNextStep => ({ kind, label, action, attention, deadlineUtc, href: target });
  const unknown = () => step('UNKNOWN', 'Open the mission or refresh for current details', 'READ');
  const matchingOrganization = authority.organizationId === request.organizationId;
  if (request.status === 'Planning') return step('PLANNING', matchingOrganization && (authority.role === 'OWNER' || authority.role === 'REQUESTER') ? 'Continue planning or explicitly submit for review' : 'View the saved Planning request', 'READ');
  if (request.status === 'Needs information') {
    const writable = matchingOrganization && (authority.role === 'OWNER' || authority.role === 'REQUESTER');
    return step('CLARIFICATION', writable ? 'Reply to the team' : 'View the clarification', writable ? 'REPLY' : 'READ', true, deadline, clarificationHref(request));
  }
  if (request.status === 'Quote ready') {
    if (request.detailAvailability.quote !== 'KNOWN') return unknown();
    const quote = request.currentQuote, expiry = utc(quote?.terms.validUntil), at = utc(now);
    if (!quote || quote.state !== 'PUBLISHED' || expiry === null || at === null) return unknown();
    if (expiry <= at) return step('QUOTE_EXPIRED', 'Ask the team for an updated quote', 'ASK_TEAM', true, quote.terms.validUntil);
    const canDecide = matchingOrganization && authority.role === 'OWNER' && authority.canSelectOffers;
    return step('QUOTE_LIVE', canDecide ? 'Review the quote' : 'Ask your workspace owner', canDecide ? 'DECIDE' : 'ASK_OWNER', true, quote.terms.validUntil);
  }
  if (request.status === 'Scheduled') {
    const window = windowState(request, now);
    if (window.kind === 'UNKNOWN' || window.kind === 'NONE') return unknown();
    return window.kind === 'ELAPSED' ? step('AWAITING_DELIVERY', 'Planned window elapsed · awaiting team delivery', 'VIEW_PLAN', true, request.schedule!.endUtc) : step('REVIEW', 'Follow the recorded plan', 'VIEW_PLAN');
  }
  if (request.status === 'Accepted') {
    if (request.detailAvailability.window !== 'KNOWN' || request.schedule) return unknown();
    return step('AWAITING_SCHEDULE', 'Awaiting a schedule from our team', 'READ', true, deadline);
  }
  if (request.status === 'Delivered') {
    return request.detailAvailability.result === 'KNOWN' && request.result ? step('DELIVERED', 'Inspect the supplied result', 'VIEW_RESULT', false, null, `/workspaces/${encodeURIComponent(request.organizationId)}/results/${encodeURIComponent(request.result.id)}`) : step('DELIVERED', 'View delivery history', 'READ');
  }
  return step('REVIEW', request.status === 'Submitted' ? 'Manual review required' : 'Feasibility under review', 'READ');
}
export function missionWindow(request: TrackingRequest, now: string): MissionWindow | null {
  if (request.status !== 'Scheduled') return null;
  const state = windowState(request, now);
  if (!request.schedule || state.kind !== 'OPEN' && state.kind !== 'UPCOMING') return null;
  return { request, startUtc: request.schedule.startUtc, endUtc: request.schedule.endUtc, provider: request.schedule.provider, state: state.kind, label: state.kind === 'OPEN' ? 'Within planned window' : 'Scheduled', href: missionHref(request) };
}
const priority: Partial<Record<NextStepKind, number>> = { CLARIFICATION: 0, QUOTE_LIVE: 1, QUOTE_EXPIRED: 1, AWAITING_DELIVERY: 2, AWAITING_SCHEDULE: 3 };
function compareText(a: string, b: string): number { const left = a.toLocaleLowerCase('en'), right = b.toLocaleLowerCase('en'); return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0; }
function compareIdentity(a: TrackingRequest, b: TrackingRequest): number { return compareText(a.title, b.title) || compareText(a.id, b.id); }
function count(known: number, unknown: number): TrackingCount { return { known, unknown, complete: unknown === 0 }; }
/** Derive all regions from one captured loaded snapshot and an explicit server-based UTC instant. */
export function presentMissions(snapshot: MissionsSnapshot, now: string, authority: TrackingAuthority): MissionsPresentation {
  const groups: Record<MissionGroup, TrackingRequest[]> = { Current: [], Upcoming: [], Past: [] }, unclassified: TrackingRequest[] = [];
  const attention: MissionsPresentation['attention'] = [], windows: MissionWindow[] = [];
  let unknownSteps = 0, unknownWindows = 0;
  for (const request of snapshot.requests) {
    const group = missionGroup(request, now); if (group) groups[group].push(request); else unclassified.push(request);
    const nextStep = missionNextStep(request, now, authority); if (nextStep.attention) attention.push({ request, nextStep }); else if (nextStep.kind === 'UNKNOWN') unknownSteps++;
    const window = missionWindow(request, now); if (window) windows.push(window);
    if (request.status === 'Scheduled' && windowState(request, now).kind === 'UNKNOWN') unknownWindows++;
  }
  attention.sort((a, b) => (priority[a.nextStep.kind] ?? 4) - (priority[b.nextStep.kind] ?? 4) || (utc(a.nextStep.deadlineUtc) ?? Infinity) - (utc(b.nextStep.deadlineUtc) ?? Infinity) || compareIdentity(a.request, b.request));
  windows.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || utc(a.startUtc)! - utc(b.startUtc)! || compareIdentity(a.request, b.request));
  for (const group of Object.values(groups)) group.sort((a, b) => Date.parse(b.submittedAt ?? b.firstSavedAt) - Date.parse(a.submittedAt ?? a.firstSavedAt) || compareIdentity(a, b));
  unclassified.sort(compareIdentity);
  const missingRows = Math.max(0, snapshot.scope.total - snapshot.requests.length);
  return { readouts: { missionsInView: count(snapshot.requests.length, missingRows), decisionsAndNextSteps: count(attention.length, unknownSteps + missingRows), upcomingWindows: count(windows.length, unknownWindows + missingRows) }, attention, windows, groups, unclassified,
    incomplete: snapshot.completeness !== 'COMPLETE' || missingRows > 0 || unclassified.length > 0 || snapshot.requests.some(request => Object.values(request.detailAvailability).some(value => value !== 'KNOWN')) };
}
