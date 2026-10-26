import { Temporal } from '@js-temporal/polyfill';
import type { NormalizedBrief, RequestProjection } from './contracts.js';
import type { StaffRequestProjection, ValidationResult } from './workflow.js';
import { zonedInstant } from './validation.js';
import type { DeliveryProjection } from './delivery.js';
import type { ObservationProjection } from './observations.js';

export type ImageRole = 'BASELINE' | 'RECENT';
export type DateAlignment = 'ALIGNED' | 'DIFFERENT' | 'INCOMPLETE';
export interface ImageVersionRef { assetId: string; contentVersion: number }
export interface ResultDraftInput {
  title: string; provider: string; targetLabel: string; source: string; uncertainty: string;
  licence: string; rightsExpiresAt: string; permittedUse: string; demonstration: true;
}
export interface NormalizedResultDraft extends Omit<ResultDraftInput, 'rightsExpiresAt'> { rightsExpiresAt: string | null }
export interface ImageMetadataInput { name: string; source: string; provider: string; sensorContext: string; permittedUse: string }
/** Immutable origin facts supplied by the original recipe, never editable client metadata. */
export interface SyntheticImageOrigin {
  sourceAssetId: string; recipeVersion: string; illustrativeDate: string;
  dateBasis: 'D0_UTC_CALENDAR'; actualCollection: null; demonstration: true;
  source: string; provider: string; sensorContext: string;
}
export interface ImageVersionSnapshot extends ImageVersionRef {
  resultId: string; role: ImageRole; metadata: ImageMetadataInput; origin: SyntheticImageOrigin;
  width: number; height: number; contentHash: string; createdAt: string;
}
export interface AcceptedDateContext {
  requestId: string; organizationId: string; acceptedQuoteId: string; briefRevision: number;
  baselineReferenceDate: string; recentReferenceDate: string; requestTimezone: string;
}
export interface DateImageContext extends ImageVersionRef {
  role: ImageRole; illustrativeDate: string; dateBasis: 'D0_UTC_CALENDAR';
  actualCollection: null; demonstration: true;
}
export interface DateComparisonRow {
  role: ImageRole; requestedDate: string; supplied: DateImageContext | null; status: DateAlignment;
}
export interface PairDateComparison {
  accepted: AcceptedDateContext; rows: [DateComparisonRow, DateComparisonRow]; status: DateAlignment;
  unequalRoles: ImageRole[]; incompleteRoles: ImageRole[]; notice: string | null;
}
export interface ReviewStamp { id: string; actorId: string; actorName: string; occurredAt: string }
export interface ImageApproveInput { reason: string; dateContextInspected: boolean; discrepancyAcknowledged: boolean }
export interface FindingChecklist {
  answersQuestion: boolean; correctPairRolesDatesVersions: boolean; matchesVisibleMaterial: boolean;
  rightsPermitUse: boolean; accurateDisclosures: boolean;
}
export interface FindingReviewInput { checklist: FindingChecklist; discrepancyAcknowledged: boolean; limitationsExplainDateDiscrepancy: boolean; reason: string }
/** An actual durable staff review, distinct from an expiring command-preview token. */
export interface ImageApprovalRecord extends ReviewStamp {
  assetId: string; contentVersion: number; reason: string; discrepancyAcknowledged: boolean;
  dateComparison: PairDateComparison; acceptedContextDigest: string; imageDigest: string; rightsDigest: string;
}
export interface FindingDraftInput { answer: string; limitations: string; additionalSources: string; citations: ImageVersionRef[] }
export interface FindingVersionSnapshot extends FindingDraftInput { findingId: string; resultId: string; contentVersion: number; createdAt: string }
export interface FindingReviewRecord extends ReviewStamp {
  findingId: string; contentVersion: number; reason: string; checklist: FindingChecklist; discrepancyAcknowledged: boolean; limitationsExplainDateDiscrepancy: boolean;
  dateComparison: PairDateComparison; acceptedContextDigest: string; pairDigest: string; findingDigest: string; rightsDigest: string;
}
export type ByteAvailability = 'NOT_CHECKED' | 'AVAILABLE' | 'UNAVAILABLE';
export interface PublishedImage extends ImageVersionSnapshot {
  state: 'PUBLISHED'; review: ReviewStamp; publishedAt: string; previewUrl: string; thumbnailUrl: string; availability: ByteAvailability;
}
export interface StaffImageProjection {
  id: string; role: ImageRole; state: 'DRAFT' | 'REVIEW' | 'PUBLISHED'; currentVersion: ImageVersionSnapshot | null;
  publishedVersion: PublishedImage | null; approval: ImageApprovalRecord | null; approvalValid: boolean;
  reviews: ImageApprovalRecord[]; previewUrl: string | null; blockers: string[];
}
export interface FindingCitation extends ImageVersionRef {
  ordinal: 1 | 2; label: 'Baseline' | 'Recent'; role: ImageRole; name: string;
  illustrativeDate: string; availability: ByteAvailability;
}
export interface PublishedFinding extends Omit<FindingVersionSnapshot, 'citations'> {
  state: 'PUBLISHED'; citations: FindingCitation[]; review: ReviewStamp; publishedAt: string;
}
export interface StaffFindingProjection {
  id: string; state: 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'WITHDRAWN'; currentVersion: FindingVersionSnapshot;
  review: FindingReviewRecord | null; reviewValid: boolean; publishedVersion: PublishedFinding | null; blockers: string[];
}
export interface GrantResultAccessInput { reason: string }
export interface EntitlementProjection { organizationId: string; active: boolean; version: number; expiresAt: string | null }
export interface StaffEntitlementProjection extends EntitlementProjection { reason: string; actorId: string; actorName: string; occurredAt: string }
export interface DeliveryReadiness {
  ready: boolean; blockers: string[]; dateAlignment: DateAlignment; fileChecks: ByteAvailability;
}
export interface MaterialEvent { id: string; type: string; actorName: string; occurredAt: string; message: string }
export interface ResultLink { id: string; title: string; provider: string; demonstration: true }
export interface CustomerResultProjection {
  id: string; requestId: string; organizationId: string; requestReference: string; question: string;
  requestVersion: number; briefRevision: number;
  metadata: NormalizedResultDraft; acceptedContext: AcceptedDateContext; dateComparison: PairDateComparison;
  images: PublishedImage[]; finding: PublishedFinding | null; contextGeneration: number; serverNow: string;
  observations: ObservationProjection[]; delivery?: DeliveryProjection | null;
}
export interface StaffResultProjection {
  id: string; requestId: string; organizationId: string; requestReference: string; question: string;
  metadata: NormalizedResultDraft; materialVersion: number; acceptedContext: AcceptedDateContext; dateComparison: PairDateComparison;
  images: StaffImageProjection[]; finding: StaffFindingProjection | null; access: StaffEntitlementProjection | null;
  readiness: DeliveryReadiness; history: MaterialEvent[];
  delivery?: DeliveryProjection | null;
}
export interface CustomerResultCard extends ResultLink {
  requestId: string; targetLabel: string; licence: string; rightsExpiresAt: string | null; actualCollection: null;
  illustrativeBaselineDate: string | null; illustrativeRecentDate: string | null;
  cover: { image: ImageVersionRef; thumbnailUrl: string; availability: ByteAvailability } | null;
}
export interface CustomerResultList { results: CustomerResultCard[]; contextGeneration: number; serverNow: string }
export interface MaterialRequestProjection extends RequestProjection { result: ResultLink | null }
export interface StaffMaterialRequestProjection extends StaffRequestProjection { result: StaffResultProjection | null }

/** These extend the existing global command routes/receipts, not a second command system. */
export interface MaterialPayloads {
  createResultSet: Record<string, never>;
  saveResultDraft: { result: ResultDraftInput };
  prepareDemoPair: Record<string, never>;
  saveImageMetadata: { metadata: ImageMetadataInput };
  approveImage: ImageApproveInput;
  publishImage: { reason: string; imageReviewId: string };
  saveFindingDraft: { finding: FindingDraftInput };
  reviewFinding: FindingReviewInput;
  publishFinding: { findingReviewId: string };
  withdrawFinding: { reason: string };
  grantResultAccess: GrantResultAccessInput;
}
export type MaterialCommandName = keyof MaterialPayloads;
export interface MaterialTarget { requestId: string; resultId?: string; assetId?: string; findingId?: string }
export interface MaterialExpected { materialVersion?: number; imageContentVersion?: number; findingContentVersion?: number; accessVersion?: number }
export interface MaterialConfirmation {
  result?: StaffResultProjection; image?: ImageVersionSnapshot; finding?: FindingVersionSnapshot;
  dateComparison?: PairDateComparison; imageReview?: ImageApprovalRecord; findingReview?: FindingReviewRecord;
  access?: { organizationId: string; organizationName: string; reason: string };
}
export interface MaterialOutcomeFields { resultId?: string; materialVersion?: number; assetId?: string; imageContentVersion?: number; findingId?: string; findingContentVersion?: number; accessVersion?: number }

export const DATE_DIFFERENCE_NOTICE = 'Requested comparison dates differ from supplied illustrative dates';
export const DELIVERY_DATE_BLOCKER = 'Delivery blocked: supplied comparison dates differ from the accepted reference dates.';
export const DEMONSTRATION_FINDING_PROPOSAL = "In these illustrative images, the recent view shows a larger dark region contiguous with the river than the baseline view. This demonstrates how a supplied comparison can address the team's question; it does not establish actual flooding.";

function object(input: unknown): Record<string, unknown> | null { return input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null; }
function text(row: Record<string, unknown>, name: string, errors: Record<string, string>, max?: number): string {
  const value = row[name];
  if (typeof value !== 'string') { errors[name] = 'Enter text in this field.'; return ''; }
  if (max !== undefined && value.length > max) errors[name] = `Use at most ${max} characters.`;
  return value;
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString() === value; } catch { return false; }
}
function validTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || !(value === 'UTC' || /^[A-Za-z][A-Za-z0-9_+\-/]+\/[A-Za-z0-9_+\-/]+$/.test(value))) return false;
  try { Temporal.Instant.from('2000-01-01T00:00:00Z').toZonedDateTimeISO(value); return true; } catch { return false; }
}
function utcExpiry(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?Z$/.test(value)) return Temporal.Instant.from(value).toString({ smallestUnit: 'millisecond' });
  return zonedInstant(value, 'UTC');
}
export function createEmptyResultDraft(): ResultDraftInput {
  return { title: '', provider: '', targetLabel: '', source: '', uncertainty: '', licence: '', rightsExpiresAt: '', permittedUse: '', demonstration: true };
}
export function resultToInput(value: NormalizedResultDraft): ResultDraftInput {
  return { title: value.title, provider: value.provider, targetLabel: value.targetLabel, source: value.source, uncertainty: value.uncertainty,
    licence: value.licence, rightsExpiresAt: value.rightsExpiresAt ?? '', permittedUse: value.permittedUse, demonstration: true };
}
export function validateResultDraft(input: unknown): ValidationResult<NormalizedResultDraft> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { result: 'Provide supplied-result metadata.' } };
  const title = text(row, 'title', errors, 200), provider = text(row, 'provider', errors, 2000), targetLabel = text(row, 'targetLabel', errors, 500);
  const source = text(row, 'source', errors, 2000), uncertainty = text(row, 'uncertainty', errors, 2000), licence = text(row, 'licence', errors, 2000), permittedUse = text(row, 'permittedUse', errors, 2000);
  const rawExpiry = text(row, 'rightsExpiresAt', errors); let rightsExpiresAt: string | null = null;
  if (row.demonstration !== true) errors.demonstration = 'This supplied pair remains a synthetic demonstration.';
  if (rawExpiry.trim()) { try { rightsExpiresAt = utcExpiry(rawExpiry); } catch { errors.rightsExpiresAt = 'Enter a valid absolute rights expiry in UTC or leave it unstated.'; } }
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { title, provider, targetLabel, source, uncertainty, licence, rightsExpiresAt, permittedUse, demonstration: true } };
}
export function validateResultForPublication(metadata: NormalizedResultDraft, now: string | Date): ValidationResult<NormalizedResultDraft> {
  const result = validateResultDraft(resultToInput(metadata)); if (!result.value) return result;
  const value = result.value, errors = result.fieldErrors;
  if (!value.title.trim()) errors.title = 'Name the supplied result.';
  if (!value.licence.trim()) errors.licence = 'Record the applicable licence.';
  if (!value.permittedUse.trim()) errors.permittedUse = 'Record permitted use before publication or access.';
  if (value.rightsExpiresAt && Temporal.Instant.compare(value.rightsExpiresAt, typeof now === 'string' ? now : now.toISOString()) <= 0) errors.rightsExpiresAt = 'The supplied rights have expired.';
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value };
}
export function validateImageMetadata(input: unknown): ValidationResult<ImageMetadataInput> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { metadata: 'Provide image metadata.' } };
  for (const key of ['role', 'origin', 'illustrativeDate', 'dateBasis', 'actualCollection', 'demonstration', 'width', 'height', 'contentHash', 'recipeVersion', 'sourceAssetId']) {
    if (Object.hasOwn(row, key)) errors[key] = 'Recipe provenance and file facts are read-only; they cannot be relabeled to align dates.';
  }
  const name = text(row, 'name', errors), source = text(row, 'source', errors), provider = text(row, 'provider', errors), sensorContext = text(row, 'sensorContext', errors), permittedUse = text(row, 'permittedUse', errors);
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { name, source, provider, sensorContext, permittedUse } };
}
export function dateContextFromAccepted(requestId: string, organizationId: string, acceptedQuoteId: string, briefRevision: number, brief: NormalizedBrief): AcceptedDateContext {
  return { requestId, organizationId, acceptedQuoteId, briefRevision, baselineReferenceDate: brief.baselineDate, recentReferenceDate: brief.recentDate, requestTimezone: brief.timezone };
}
export function imageDateContext(image: ImageVersionSnapshot): DateImageContext {
  return { assetId: image.assetId, contentVersion: image.contentVersion, role: image.role, illustrativeDate: image.origin.illustrativeDate,
    dateBasis: image.origin.dateBasis, actualCollection: image.origin.actualCollection, demonstration: image.origin.demonstration };
}
export function compareReferenceDates(context: AcceptedDateContext, images: readonly DateImageContext[]): PairDateComparison {
  const accepted: AcceptedDateContext = { requestId: context.requestId, organizationId: context.organizationId, acceptedQuoteId: context.acceptedQuoteId, briefRevision: context.briefRevision,
    baselineReferenceDate: context.baselineReferenceDate, recentReferenceDate: context.recentReferenceDate, requestTimezone: context.requestTimezone };
  const acceptedValid = !!accepted.requestId && !!accepted.organizationId && !!accepted.acceptedQuoteId && Number.isSafeInteger(accepted.briefRevision) && accepted.briefRevision > 0 &&
    validTimezone(accepted.requestTimezone) && validDate(accepted.baselineReferenceDate) && validDate(accepted.recentReferenceDate) && accepted.baselineReferenceDate < accepted.recentReferenceDate;
  const rows = (['BASELINE', 'RECENT'] as const).map(role => {
    const candidates = images.filter(image => image.role === role), image = candidates[0];
    const supplied: DateImageContext | null = image ? { assetId: image.assetId, contentVersion: image.contentVersion, role, illustrativeDate: image.illustrativeDate,
      dateBasis: image.dateBasis, actualCollection: image.actualCollection, demonstration: image.demonstration } : null;
    const requestedDate = role === 'BASELINE' ? accepted.baselineReferenceDate : accepted.recentReferenceDate;
    const complete = acceptedValid && candidates.length === 1 && supplied && !!supplied.assetId && Number.isSafeInteger(supplied.contentVersion) && supplied.contentVersion > 0 &&
      validDate(supplied.illustrativeDate) && supplied.dateBasis === 'D0_UTC_CALENDAR' && supplied.actualCollection === null && supplied.demonstration === true;
    const status: DateAlignment = !complete ? 'INCOMPLETE' : supplied.illustrativeDate === requestedDate ? 'ALIGNED' : 'DIFFERENT';
    return { role, requestedDate, supplied, status };
  }) as [DateComparisonRow, DateComparisonRow];
  const incompleteRoles = rows.filter(row => row.status === 'INCOMPLETE').map(row => row.role), unequalRoles = rows.filter(row => row.status === 'DIFFERENT').map(row => row.role);
  const status: DateAlignment = incompleteRoles.length ? 'INCOMPLETE' : unequalRoles.length ? 'DIFFERENT' : 'ALIGNED';
  return { accepted, rows, status, unequalRoles, incompleteRoles, notice: status === 'DIFFERENT' ? DATE_DIFFERENCE_NOTICE : status === 'INCOMPLETE' ? 'Comparison date context is incomplete.' : null };
}
export function createEmptyFindingDraft(): FindingDraftInput { return { answer: '', limitations: '', additionalSources: '', citations: [] }; }
export function validateFindingDraft(input: unknown, resultId: string, versions: readonly ImageVersionSnapshot[]): ValidationResult<FindingDraftInput> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { finding: 'Provide the finding and its exact evidence.' } };
  const answer = text(row, 'answer', errors, 4000), limitations = text(row, 'limitations', errors, 2000), additionalSources = text(row, 'additionalSources', errors, 2000);
  if (!answer.trim()) errors.answer = 'Write the finding that answers the original question.';
  if (!limitations.trim()) errors.limitations = 'Explain uncertainty and synthetic-material limitations.';
  const selected: ImageVersionSnapshot[] = [];
  if (!Array.isArray(row.citations) || row.citations.length !== 2) errors.citations = 'Select the exact Baseline and Recent versions from this result.';
  else for (const raw of row.citations) {
    const ref = object(raw);
    const match = ref && typeof ref.assetId === 'string' && Number.isSafeInteger(ref.contentVersion) ? versions.find(image => image.assetId === ref.assetId && image.contentVersion === ref.contentVersion && image.resultId === resultId) : undefined;
    if (!match) errors.citations = 'Each citation must name an exact version from this same result.'; else selected.push(match);
  }
  if (selected.filter(image => image.role === 'BASELINE').length !== 1 || selected.filter(image => image.role === 'RECENT').length !== 1) errors.citations = 'Cite one exact Baseline and one exact Recent version.';
  const citations = (['BASELINE', 'RECENT'] as const).flatMap(role => selected.filter(image => image.role === role).map(image => ({ assetId: image.assetId, contentVersion: image.contentVersion })));
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { answer, limitations, additionalSources, citations } };
}
export function validateImageApproval(input: unknown, comparison: PairDateComparison): ValidationResult<ImageApproveInput> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { review: 'Record an actual image review.' } };
  const reason = text(row, 'reason', errors);
  if (!reason.trim()) errors.reason = 'Record the reason for this image approval.';
  if (row.dateContextInspected !== true) errors.dateContextInspected = 'Inspect the requested-versus-supplied date table.';
  if (comparison.status === 'INCOMPLETE') errors.dateComparison = 'Incomplete date context cannot be approved.';
  if (comparison.status === 'DIFFERENT' && row.discrepancyAcknowledged !== true) errors.discrepancyAcknowledged = 'Explicitly acknowledge the displayed date discrepancy; this does not amend accepted work or permit delivery.';
  if (typeof row.discrepancyAcknowledged !== 'boolean') errors.discrepancyAcknowledged = 'State whether the displayed discrepancy was acknowledged.';
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { reason, dateContextInspected: true, discrepancyAcknowledged: row.discrepancyAcknowledged as boolean } };
}
export function createEmptyFindingReview(): FindingReviewInput { return { checklist: { answersQuestion: false, correctPairRolesDatesVersions: false, matchesVisibleMaterial: false, rightsPermitUse: false, accurateDisclosures: false }, discrepancyAcknowledged: false, limitationsExplainDateDiscrepancy: false, reason: '' }; }
export function validateFindingReview(input: unknown, comparison: PairDateComparison): ValidationResult<FindingReviewInput> {
  const row = object(input), errors: Record<string, string> = {};
  if (!row) return { fieldErrors: { review: 'Record an actual finding review.' } };
  const source = object(row.checklist), checklist: FindingChecklist = { answersQuestion: false, correctPairRolesDatesVersions: false, matchesVisibleMaterial: false, rightsPermitUse: false, accurateDisclosures: false };
  for (const key of Object.keys(checklist) as (keyof FindingChecklist)[]) {
    if (source?.[key] !== true) errors[`checklist.${key}`] = 'Inspect and confirm this finding-review item.';
    checklist[key] = source?.[key] === true;
  }
  const reason = text(row, 'reason', errors);
  if (comparison.status === 'INCOMPLETE') errors.dateComparison = 'Incomplete date context cannot be reviewed as valid.';
  if (typeof row.discrepancyAcknowledged !== 'boolean') errors.discrepancyAcknowledged = 'State whether the displayed discrepancy was acknowledged.';
  if (comparison.status === 'DIFFERENT') {
    if (row.discrepancyAcknowledged !== true) errors.discrepancyAcknowledged = 'Acknowledge the exact displayed discrepancy after checking the authored limitations; this does not waive the delivery blocker.';
    if (row.limitationsExplainDateDiscrepancy !== true) errors.limitationsExplainDateDiscrepancy = 'Confirm that the authored limitations explain the actual requested-versus-supplied date discrepancy shown above.';
    if (!reason.trim()) errors.reason = 'Record what you inspected about the date discrepancy; finding limitations must explain it.';
  }
  if (typeof row.limitationsExplainDateDiscrepancy !== 'boolean') errors.limitationsExplainDateDiscrepancy = 'State whether the authored limitations explain the displayed date discrepancy.';
  return Object.keys(errors).length ? { fieldErrors: errors } : { fieldErrors: {}, value: { checklist, reason, discrepancyAcknowledged: row.discrepancyAcknowledged as boolean, limitationsExplainDateDiscrepancy: row.limitationsExplainDateDiscrepancy as boolean } };
}
export function validateMaterialReason(input: unknown): ValidationResult<{ reason: string }> {
  const row = object(input), reason = row?.reason;
  return typeof reason !== 'string' || !reason.trim() ? { fieldErrors: { reason: 'Record a nonblank reason for this action.' } } : { fieldErrors: {}, value: { reason } };
}
export const validateGrantResultAccess = validateMaterialReason;
export const validateReason = validateMaterialReason;
export const validateImageApprove = validateImageApproval;
export function compareDateContext(context: AcceptedDateContext, images: readonly ImageVersionSnapshot[]): PairDateComparison { return compareReferenceDates(context, images.map(imageDateContext)); }
export function resultRightsValid(metadata: NormalizedResultDraft, now: string | Date): boolean {
  if (!metadata.licence.trim() || !metadata.permittedUse.trim()) return false;
  try { return !metadata.rightsExpiresAt || Temporal.Instant.compare(metadata.rightsExpiresAt, typeof now === 'string' ? now : now.toISOString()) > 0; } catch { return false; }
}
function acceptedSnapshot(value: AcceptedDateContext): AcceptedDateContext {
  return { requestId: value.requestId, organizationId: value.organizationId, acceptedQuoteId: value.acceptedQuoteId, briefRevision: value.briefRevision,
    baselineReferenceDate: value.baselineReferenceDate, recentReferenceDate: value.recentReferenceDate, requestTimezone: value.requestTimezone };
}
function metadataSnapshot(value: NormalizedResultDraft): NormalizedResultDraft {
  return { title: value.title, provider: value.provider, targetLabel: value.targetLabel, source: value.source, uncertainty: value.uncertainty,
    licence: value.licence, rightsExpiresAt: value.rightsExpiresAt, permittedUse: value.permittedUse, demonstration: value.demonstration };
}
function imageSnapshot(value: ImageVersionSnapshot): ImageVersionSnapshot {
  const m = value.metadata, o = value.origin;
  return { assetId: value.assetId, contentVersion: value.contentVersion, resultId: value.resultId, role: value.role,
    metadata: { name: m.name, source: m.source, provider: m.provider, sensorContext: m.sensorContext, permittedUse: m.permittedUse },
    origin: { sourceAssetId: o.sourceAssetId, recipeVersion: o.recipeVersion, illustrativeDate: o.illustrativeDate, dateBasis: o.dateBasis,
      actualCollection: o.actualCollection, demonstration: o.demonstration, source: o.source, provider: o.provider, sensorContext: o.sensorContext },
    width: value.width, height: value.height, contentHash: value.contentHash, createdAt: value.createdAt };
}
/** Counterpart/pair and material/access counters are deliberately absent from this validity scope. */
export function imageApprovalScope(accepted: AcceptedDateContext, image: ImageVersionSnapshot, metadata: NormalizedResultDraft) {
  return { accepted: acceptedSnapshot(accepted), image: imageSnapshot(image), metadata: metadataSnapshot(metadata) };
}
/** Full pair dependency for the authored finding, unlike single-image approval validity. */
export function findingReviewScope(accepted: AcceptedDateContext, finding: FindingVersionSnapshot, images: readonly ImageVersionSnapshot[], metadata: NormalizedResultDraft) {
  const pair = (['BASELINE', 'RECENT'] as const).flatMap(role => images.filter(image => image.role === role && finding.citations.some(ref => ref.assetId === image.assetId && ref.contentVersion === image.contentVersion)).map(imageSnapshot));
  return { accepted: acceptedSnapshot(accepted), finding: { findingId: finding.findingId, resultId: finding.resultId, contentVersion: finding.contentVersion,
    answer: finding.answer, limitations: finding.limitations, additionalSources: finding.additionalSources, citations: finding.citations.map(ref => ({ assetId: ref.assetId, contentVersion: ref.contentVersion })), createdAt: finding.createdAt }, pair, metadata: metadataSnapshot(metadata) };
}
