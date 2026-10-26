import { Temporal } from '@js-temporal/polyfill';
import type { Audience, BriefInput, EvidenceSnapshot, NormalizedBrief, RequestProjection, RequestStatus } from './contracts.js';
import { compareDecimals, normalizeDecimal } from './decimal.js';
import { observationIntent, validateBrief, zonedInstant, type BriefValidationOptions } from './validation.js';
import type { MaterialConfirmation, MaterialExpected, MaterialOutcomeFields, MaterialPayloads, MaterialTarget } from './material.js';
import type { DeliveryConfirmation, DeliveryOutcomeFields, DeliveryPayloads } from './delivery.js';
import type { ObservationExpected, ObservationOutcomeFields, ObservationPayloads, ObservationTarget } from './observations.js';
import type { DiscoveryDictionary } from './discovery-contracts.js';
import { makeDiscoveryDictionary, validateDiscoverySnapshot } from './discovery.js';
import type { AssessmentManifestRef, PlanInputSummary, PlanOption, PlanSelectionInput, PlanUserAssumption } from './plan-contracts.js';
import type { CapabilityFact } from './orbital-contracts.js';

export interface ProposedPlanReview {
  assessment: AssessmentManifestRef; input: PlanInputSummary; option: PlanOption;
  selectedAtUtc: string | null; acknowledgedUnknownIds: string[]; assumptions: PlanUserAssumption[];
  facts: CapabilityFact[]; digest: string;
}

export interface EvidenceRef { itemId: string; evidenceVersion: string }
export interface ValidationResult<T> { value?: T; fieldErrors: Record<string, string> }
export type BriefRevisionInput = Omit<BriefInput, 'contact'> & { contact?: BriefInput['contact'] };
export interface QuoteDraftInput {
  priceType: '' | 'FIXED' | 'RANGE'; amount: string; minimum: string; maximum: string;
  currency: string; scope: string; licence: string; validUntil: string;
  recommendation: string; recommendedEvidence: EvidenceRef[];
}
export interface NormalizedQuote {
  priceType: 'FIXED' | 'RANGE' | null; amount: string | null; minimum: string | null; maximum: string | null;
  currency: string; scope: string; licence: string; validUntil: string | null;
  recommendation: string; recommendedEvidence: EvidenceRef[];
}
export interface ScheduleInput { provider: string; start: string; end: string; timezone: string; trackedItemIds: string[]; notes: string }
export interface NormalizedSchedule {
  provider: string; startUtc: string; endUtc: string; localStart: string; localEnd: string;
  timezone: string; trackedItemIds: string[]; notes: string;
}
export interface MessagePayload { message: string }
export interface DecisionPayload { reason: string }
export interface ClarificationMessage {
  id: string; kind: 'STAFF_QUESTION' | 'CUSTOMER_REPLY' | 'STAFF_REPLY'; audience: 'CUSTOMER' | 'STAFF';
  actorId: string; actorName: string; occurredAt: string; message: string;
}
export interface BriefRevisionProjection {
  revision: number; createdAt: string; actorId: string; actorName: string;
  brief: NormalizedBrief; evidence: EvidenceSnapshot[];
}
export interface QuoteDraftProjection {
  id: string; requestId: string; organizationId: string; state: 'DRAFT'; briefRevision: number;
  contentVersion: number; terms: NormalizedQuote; createdAt: string; updatedAt: string; actorId: string; actorName: string;
}
export interface QuoteProjection {
  id: string; requestId: string; organizationId: string; state: 'PUBLISHED' | 'ACCEPTED' | 'DECLINED' | 'SUPERSEDED';
  briefRevision: number; contentVersion: number; terms: NormalizedQuote; pricedBrief: NormalizedBrief;
  createdAt: string; publishedAt: string; actorId: string; actorName: string;
}
export interface QuoteDecision {
  id: string; quoteId: string; decision: 'ACCEPT' | 'DECLINE'; actorId: string; actorName: string;
  occurredAt: string; reason: string | null;
}
export interface ScheduleProjection extends NormalizedSchedule {
  id: string; requestId: string; organizationId: string; acceptedQuoteId: string; briefRevision: number;
  version: number; createdAt: string; actorId: string; actorName: string;
}
export interface StaffRequestProjection extends RequestProjection { quoteDrafts: QuoteDraftProjection[] }

export interface WorkflowPayloads extends MaterialPayloads, DeliveryPayloads, ObservationPayloads {
  saveProposedPlan: { brief: BriefInput; selection: PlanSelectionInput };
  submitPlanningRequest: { brief: BriefInput };
  startReview: Record<string, never>;
  reviseBrief: { brief: BriefRevisionInput };
  askCustomer: MessagePayload; replyToTeam: MessagePayload; staffReply: MessagePayload;
  saveQuoteDraft: { quote: QuoteDraftInput };
  publishQuote: { replacesQuoteId: string | null };
  acceptQuote: Record<string, never>; declineQuote: DecisionPayload;
  recordInitialSchedule: { schedule: ScheduleInput; acceptedQuoteId: string };
}
export type WorkflowCommandName = keyof WorkflowPayloads;
export interface WorkflowExpected extends MaterialExpected, ObservationExpected { requestVersion: number; briefRevision: number; quoteContentVersion?: number; proposedPlanVersion?: number | null }
export interface WorkflowTarget extends MaterialTarget, ObservationTarget { quoteId?: string }
export interface WorkflowCommandEnvelope<K extends WorkflowCommandName = WorkflowCommandName> {
  commandId: string; contextGeneration: number; contextToken: string;
  target: WorkflowTarget; expected: WorkflowExpected; payload: WorkflowPayloads[K]; reviewToken?: string;
}
export interface WorkflowConfirmation extends MaterialConfirmation, DeliveryConfirmation {
  request: RequestProjection; brief?: NormalizedBrief; evidence?: EvidenceSnapshot[];
  quote?: QuoteProjection; quoteDraft?: QuoteDraftProjection; replacesQuote?: QuoteProjection | null;
  schedule?: NormalizedSchedule; acceptedQuote?: QuoteProjection; message?: string; reason?: string;
  proposedPlan?: ProposedPlanReview;
}
export interface WorkflowReview {
  commandName: WorkflowCommandName; reviewToken: string; expiresAt: string; contextGeneration: number;
  requestId: string; requestVersion: number; briefRevision: number; confirmation: WorkflowConfirmation;
}
export interface WorkflowOutcome extends MaterialOutcomeFields, DeliveryOutcomeFields, ObservationOutcomeFields {
  outcome: 'saved' | 'replayed'; requestId: string; requestVersion: number; briefRevision: number;
  contextGeneration: number; message: string; quoteId?: string; quoteContentVersion?: number;
  scheduleId?: string; clarificationId?: string; detailsUnavailable?: boolean;
  proposedPlanId?: string; proposedPlanVersion?: number; reference?: string;
}

export function createEmptyQuoteDraft(): QuoteDraftInput {
  return { priceType: '', amount: '', minimum: '', maximum: '', currency: 'USD', scope: '', licence: '', validUntil: '', recommendation: '', recommendedEvidence: [] };
}
export function createEmptySchedule(): ScheduleInput { return { provider: '', start: '', end: '', timezone: '', trackedItemIds: [], notes: '' }; }
function object(input: unknown): Record<string, unknown> | null { return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null; }
function stringField(row: Record<string, unknown>, name: string, errors: Record<string, string>, required = false): string {
  const raw = row[name];
  if (typeof raw !== 'string') { errors[name] = 'Enter text in this field.'; return ''; }
  if (required && !raw.trim()) errors[name] = 'This field is required.';
  return raw;
}
function expiryInstant(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/.test(raw)) {
    return Temporal.Instant.from(raw).toString({ smallestUnit: 'millisecond' });
  }
  return zonedInstant(raw, 'UTC');
}
export function validateQuoteDraft(input: unknown): ValidationResult<NormalizedQuote> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { quote: 'Provide quote draft fields.' } };
  const priceType = row.priceType === '' ? null : row.priceType;
  if (priceType !== null && priceType !== 'FIXED' && priceType !== 'RANGE') errors.priceType = 'Choose Fixed amount or Range.';
  const amountField = (name: string): string | null => {
    const raw = stringField(row, name, errors);
    if (!raw.trim()) return null;
    try { return normalizeDecimal(raw); } catch { errors[name] = 'Enter a nonnegative decimal amount without exponent notation.'; return null; }
  };
  const amount = priceType === 'FIXED' ? amountField('amount') : null;
  const minimum = priceType === 'RANGE' ? amountField('minimum') : null;
  const maximum = priceType === 'RANGE' ? amountField('maximum') : null;
  if (minimum !== null && maximum !== null && compareDecimals(minimum, maximum) > 0) errors.maximum = 'Range maximum must be at least the minimum.';
  const currency = stringField(row, 'currency', errors).trim().toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) errors.currency = 'Enter an explicit three-letter currency code.';
  const scope = stringField(row, 'scope', errors), licence = stringField(row, 'licence', errors);
  const recommendation = stringField(row, 'recommendation', errors), rawExpiry = stringField(row, 'validUntil', errors);
  let validUntil: string | null = null;
  if (rawExpiry.trim()) { try { validUntil = expiryInstant(rawExpiry); } catch { errors.validUntil = 'Enter a valid absolute expiry in UTC.'; } }
  const recommendedEvidence: EvidenceRef[] = [];
  if (!Array.isArray(row.recommendedEvidence) || row.recommendedEvidence.length > 50) errors.recommendedEvidence = 'Choose at most 50 saved evidence records.';
  else {
    for (const value of row.recommendedEvidence) {
      const ref = object(value);
      if (!ref || typeof ref.itemId !== 'string' || !ref.itemId.trim() || typeof ref.evidenceVersion !== 'string' || !ref.evidenceVersion.trim()) { errors.recommendedEvidence = 'Choose evidence by its saved identity and version.'; continue; }
      recommendedEvidence.push({ itemId: ref.itemId, evidenceVersion: ref.evidenceVersion });
    }
    if (new Set(recommendedEvidence.map(ref => ref.itemId)).size !== recommendedEvidence.length) errors.recommendedEvidence = 'Choose each saved evidence identity only once.';
  }
  if (Object.keys(errors).length) return { fieldErrors: errors };
  return { fieldErrors: {}, value: { priceType: priceType as NormalizedQuote['priceType'], amount, minimum, maximum, currency, scope, licence, validUntil, recommendation, recommendedEvidence } };
}
export function quoteToInput(quote: NormalizedQuote): QuoteDraftInput {
  return { priceType: quote.priceType ?? '', amount: quote.amount ?? '', minimum: quote.minimum ?? '', maximum: quote.maximum ?? '', currency: quote.currency,
    scope: quote.scope, licence: quote.licence, validUntil: quote.validUntil ?? '', recommendation: quote.recommendation,
    recommendedEvidence: quote.recommendedEvidence.map(ref => ({ itemId: ref.itemId, evidenceVersion: ref.evidenceVersion })) };
}
export function validateQuoteForPublication(quote: NormalizedQuote, brief: NormalizedBrief, now: Date | string): ValidationResult<NormalizedQuote> {
  const result = validateQuoteDraft(quoteToInput(quote));
  if (!result.value) return result;
  const value = result.value, errors = result.fieldErrors;
  if (!value.priceType) errors.priceType = 'Choose Fixed amount or Range.';
  if (value.priceType === 'FIXED' && value.amount === null) errors.amount = 'Enter the fixed amount.';
  if (value.priceType === 'RANGE') { if (value.minimum === null) errors.minimum = 'Enter the range minimum.'; if (value.maximum === null) errors.maximum = 'Enter the range maximum.'; }
  if (!value.currency) errors.currency = 'Enter the quote currency.';
  if (!value.scope.trim()) errors.scope = 'Enter the customer-facing scope of work.';
  if (!value.licence.trim()) errors.licence = 'Enter licence and permitted use.';
  if (!value.validUntil) errors.validUntil = 'Enter a future expiry in UTC.';
  else if (Temporal.Instant.compare(value.validUntil, typeof now === 'string' ? now : now.toISOString()) <= 0) errors.validUntil = 'Expiry must still be in the future.';
  if (brief.family !== 'EO' || !['OPEN','SAR','VISIBLE','SWIR','THERMAL'].includes(brief.sensor) || brief.outputs.length !== 1 || brief.outputs[0] !== 'Imagery') errors.brief = 'Review the supported EO/Imagery brief.';
  if (observationIntent(brief) === 'comparison') try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(brief.baselineDate) || !/^\d{4}-\d{2}-\d{2}$/.test(brief.recentDate)) throw new Error();
    const baseline = Temporal.PlainDate.from(brief.baselineDate, { overflow: 'reject' });
    const recent = Temporal.PlainDate.from(brief.recentDate, { overflow: 'reject' });
    if (baseline.toString() !== brief.baselineDate || recent.toString() !== brief.recentDate || Temporal.PlainDate.compare(baseline, recent) >= 0) throw new Error();
  } catch { errors.comparisonDates = 'Resolve valid ordered comparison reference dates in the brief.'; }
  try {
    if (!brief.requestedWindow || Temporal.Instant.compare(brief.requestedWindow.startUtc, brief.requestedWindow.endUtc) >= 0) throw new Error();
  } catch { errors.requestedWindow = 'Resolve the requested window through clarification and a pre-acceptance brief revision before publication.'; }
  const selected = new Set(brief.selectedEvidence.map(ref => JSON.stringify([ref.itemId, ref.evidenceVersion])));
  if (value.recommendedEvidence.some(ref => !selected.has(JSON.stringify([ref.itemId, ref.evidenceVersion])))) errors.recommendedEvidence = 'Recommendations must name evidence saved with this priced brief.';
  return Object.keys(errors).length ? { fieldErrors: errors } : { value, fieldErrors: {} };
}
export function validateSchedule(input: unknown, acceptedBrief: NormalizedBrief, knownItemIds: ReadonlySet<string>): ValidationResult<NormalizedSchedule> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { schedule: 'Provide schedule fields.' } };
  const provider = stringField(row, 'provider', errors, true), start = stringField(row, 'start', errors, true);
  const end = stringField(row, 'end', errors, true), timezone = stringField(row, 'timezone', errors, true), notes = stringField(row, 'notes', errors);
  let startUtc = '', endUtc = '';
  try {
    if (!(timezone === 'UTC' || /^[A-Za-z][A-Za-z0-9_+\-/]+\/[A-Za-z0-9_+\-/]+$/.test(timezone))) throw new Error();
    Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(timezone);
  } catch { errors.timezone = 'Enter an explicit named IANA timezone such as UTC or Europe/Dublin.'; }
  if (!errors.timezone) {
    try { startUtc = zonedInstant(start, timezone); } catch { errors.start = 'Enter a valid unambiguous planned start in this timezone.'; }
    try { endUtc = zonedInstant(end, timezone); } catch { errors.end = 'Enter a valid unambiguous planned end in this timezone.'; }
    if (startUtc && endUtc && Temporal.Instant.compare(startUtc, endUtc) >= 0) errors.end = 'Planned end must be later than planned start.';
  }
  if (!acceptedBrief.requestedWindow) errors.acceptedWindow = 'The accepted brief has no resolved requested window.';
  else if (startUtc && endUtc && (Temporal.Instant.compare(startUtc, acceptedBrief.requestedWindow.startUtc) < 0 || Temporal.Instant.compare(endUtc, acceptedBrief.requestedWindow.endUtc) > 0)) errors.acceptedWindow = 'Keep the initial schedule within the accepted requested window. Discuss proposed changes in Clarifications.';
  const trackedItemIds: string[] = [];
  if (!Array.isArray(row.trackedItemIds) || row.trackedItemIds.some(id => typeof id !== 'string' || !knownItemIds.has(id))) errors.trackedItemIds = 'Choose known saved spacecraft identities or leave none selected.';
  else { trackedItemIds.push(...row.trackedItemIds); if (new Set(trackedItemIds).size !== trackedItemIds.length) errors.trackedItemIds = 'Choose each tracked identity only once.'; }
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { provider, startUtc, endUtc, localStart: start, localEnd: end, timezone, trackedItemIds, notes } };
}
export function validateMessage(input: unknown): ValidationResult<MessagePayload> {
  const row = object(input), message = row?.message;
  return typeof message !== 'string' || !message.trim() || message.length > 4000 ? { fieldErrors: { message: 'Enter 1–4000 characters.' } } : { fieldErrors: {}, value: { message } };
}
export function validateDecline(input: unknown): ValidationResult<DecisionPayload> {
  const row = object(input), reason = row?.reason;
  return typeof reason !== 'string' || !reason.trim() || reason.length > 2000 ? { fieldErrors: { reason: 'Enter a nonblank decline reason of at most 2000 characters.' } } : { fieldErrors: {}, value: { reason } };
}
/** The immutable original contact is server-owned; it is never an editable revision field. */
export function validateBriefRevision(input: unknown, previous: NormalizedBrief, discoveryDictionary?: DiscoveryDictionary, options: Omit<BriefValidationOptions,'discoveryDictionary'|'requireAcknowledgement'> = {}): ValidationResult<NormalizedBrief> {
  const row = object(input);
  if (!row || (!options.preparation && Object.hasOwn(row, 'contact'))) return { fieldErrors: { contact: 'The original submitted contact is read-only.' } };
  const preserveWindow = row.timingToDiscuss === false && previous.requestedWindow !== null &&
    row.windowStart === previous.requestedWindow.localStart && row.windowEnd === previous.requestedWindow.localEnd && row.timezone === previous.requestedWindow.timezone;
  const preserveDeadline = previous.deadline !== null && row.deadline === previous.deadline.local && row.timezone === previous.deadline.timezone;
  // Revalidate changed timing. Untouched saved timing keeps its already resolved instants;
  // an unrelated edit must not reinterpret it through a different timezone-rule version.
  const {discovery:rawDiscovery,...core}=row;
  const result = validateBrief({ ...core, contact: options.preparation && row.contact !== undefined ? row.contact : previous.contact,
    timingToDiscuss: preserveWindow ? true : row.timingToDiscuss, deadline: preserveDeadline ? '' : row.deadline }, { ...options, requireAcknowledgement: false, discoveryDictionary });
  if (!result.value) return result;
  const value = result.value;
  if (preserveWindow) { value.timingToDiscuss = false; value.requestedWindow = { ...previous.requestedWindow! }; }
  if (preserveDeadline) value.deadline = { ...previous.deadline! };
  // Compare provenance only after restoring immutable, already-resolved timing instants.
  if(rawDiscovery!==undefined&&rawDiscovery!==null){
    const checked=validateDiscoverySnapshot(rawDiscovery,value.purpose,discoveryDictionary??makeDiscoveryDictionary([]),value);
    if(!checked.value)return {fieldErrors:checked.fieldErrors};
    value.discovery=checked.value;
  }
  return { fieldErrors: {}, value };
}
export function revisionToInput(brief: NormalizedBrief): BriefRevisionInput {
  return { purpose: brief.purpose, family: brief.family, sensor: brief.sensor, outputs: [...brief.outputs],
    ...(brief.areaPurposeDigest ? { areaReviewedPurpose: brief.purpose } : {}),
    ...(brief.observationIntent ? { observationIntent: brief.observationIntent } : {}),
    latitude: String(brief.area.latitude), longitude: String(brief.area.longitude), radiusKm: String(brief.area.radiusKm), areaChoice: { ...brief.area }, areaConfirmation: brief.areaConfirmation,
    baselineDate: brief.baselineDate, recentDate: brief.recentDate, timezone: brief.timezone, maxResolution: brief.maxResolutionM === null ? '' : String(brief.maxResolutionM), resolutionUnit: 'm',
    cloudCover: brief.cloudCover === null ? '' : String(brief.cloudCover), revisitHours: brief.revisitHours === null ? '' : String(brief.revisitHours), spectralRequirements: brief.spectralRequirements,
    timingToDiscuss: brief.timingToDiscuss, windowStart: brief.requestedWindow?.localStart ?? '', windowEnd: brief.requestedWindow?.localEnd ?? '', deadline: brief.deadline?.local ?? '', timingNotes: brief.timingNotes,
    unknowns: brief.unknowns.join('\n'), selectedEvidence: brief.selectedEvidence.map(ref => ({ itemId: ref.itemId, evidenceVersion: ref.evidenceVersion })), acknowledged: false,
    ...(brief.catalogContext ? {catalogContext: structuredClone(brief.catalogContext)} : {}),
    ...(brief.discovery?{discovery:{rulesVersion:brief.discovery.rulesVersion,generation:brief.discovery.generation,originalText:brief.discovery.originalText,manual:structuredClone(brief.discovery.manual),...(brief.discovery.reviewedSignature?{reviewedSignature:brief.discovery.reviewedSignature}:{})}}:{}) };
}
export function planningToInput(brief: NormalizedBrief): BriefInput { return { ...revisionToInput(brief), areaReviewedPurpose: brief.purpose, contact: { ...brief.contact }, acknowledged: false }; }
export function customerReplyAllowed(status: RequestStatus): boolean { return ['In review', 'Needs information', 'Quote ready', 'Accepted', 'Scheduled', 'Delivered'].includes(status); }
export function revisionAllowed(status: RequestStatus): boolean { return ['Planning','Submitted', 'In review', 'Needs information', 'Quote ready'].includes(status); }
export function statusAfterRevision(status: RequestStatus): RequestStatus { return status === 'Needs information' || status === 'Quote ready' ? 'In review' : status; }
export function statusAfterMessage(status: RequestStatus, audience: Audience): RequestStatus { return audience === 'CUSTOMER' && status === 'Needs information' ? 'In review' : status; }
