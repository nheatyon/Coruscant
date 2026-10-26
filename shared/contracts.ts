import type { BriefRevisionProjection, ClarificationMessage, QuoteDecision, QuoteProjection, ScheduleProjection } from './workflow.js';
import type { DeliveryProjection } from './delivery.js';
import type { RealEvidenceSnapshot } from './orbital-contracts.js';
import type { DiscoverySnapshot, DiscoverySnapshotInput } from './discovery-contracts.js';
import type { PlaceSourceReference, PlaceSourceSnapshot } from './place-contracts.js';
import type { AcceptedPlanSnapshot, AssessmentHandoffContinuation, AssessmentHandoffResult, PlanSelectionInput, ProposedPlanProjection } from './plan-contracts.js';
import type { ProposedPlanReview } from './workflow.js';
/** Coruscant's shared public contracts. Runtime authority is always server-derived. */
export type Audience = 'PUBLIC' | 'CUSTOMER' | 'STAFF';
export type Role = 'OWNER' | 'REQUESTER' | 'VIEWER';
export type RequestStatus = 'Planning' | 'Submitted' | 'In review' | 'Needs information' | 'Quote ready' | 'Accepted' | 'Scheduled' | 'Delivered';
export type ObservationIntent = 'single-observation' | 'comparison';
export type BriefContact = { name: string; email: string; organization: string };
export interface Organization { id: string; name: string }
export interface Membership { organizationId: string; organizationName: string; role: Role; canSelectOffers: boolean }
export interface Persona { id: string; name: string; description: string }
export interface Context {
  audience: Audience; actor: { id: string; name: string } | null;
  organization: Organization | null; role: Role | null; canSelectOffers: boolean;
  memberships: Membership[]; contextGeneration: number; contextToken: string | null;
  csrfToken: string | null; serverNow: string;
  planningHandoff?: { phase: 'CONTINUE'; continuation: AssessmentHandoffContinuation } | { phase: 'COMPLETE'; result: AssessmentHandoffResult };
}
export interface CatalogItem {
  id: string; name: string; family: 'EO'; type: 'catalog';
  operator: string | null; ownerCountry: string | null;
  sensors: string[] | null; resolutionM: number | null;
  evidenceVersion: string; source: string; checkedAt: string;
  demonstration: true; caveats: string[]; status: 'unknown'; launchDate: null;
}
export interface PublicCatalog {
  items: CatalogItem[]; personas: Persona[];
  demo: { d0: string; baselineDate: string; recentDate: string; target: { latitude: number; longitude: number; radiusKm: number } };
}
export interface AreaChoice { latitude: number; longitude: number; radiusKm: number; method: 'coordinates' | 'globe'; generation: number }
export type CatalogContext = { sourceKind: 'PUBLIC_REAL'; snapshotVersion: string | null; factVersion: string | null } | { sourceKind: 'DEMONSTRATION' };
export interface BriefInput {
  /** Absent only on legacy comparison inputs. New surfaces make this explicit. */
  observationIntent?: ObservationIntent;
  areaSource?: PlaceSourceReference | null;
  areaReviewedPurpose?: string;
  purpose: string; family: string; sensor: string; outputs: string[];
  latitude: string; longitude: string; radiusKm: string;
  areaChoice: AreaChoice | null; areaConfirmation: string | null;
  baselineDate: string; recentDate: string; timezone: string;
  maxResolution: string; resolutionUnit: 'm' | 'cm' | 'km';
  cloudCover: string; revisitHours: string; spectralRequirements: string;
  timingToDiscuss: boolean; windowStart: string; windowEnd: string; deadline: string; timingNotes: string;
  unknowns: string; contact: { name: string; email: string; organization: string };
  selectedEvidence: { itemId: string; evidenceVersion: string }[]; acknowledged: boolean;
  discovery?: DiscoverySnapshotInput;
  catalogContext?: CatalogContext;
}
export interface NormalizedBrief {
  observationIntent?: ObservationIntent;
  areaSource?: PlaceSourceSnapshot | null;
  areaPurposeDigest?: string;
  purpose: string; family: 'EO'; sensor: 'SAR' | 'OPEN' | 'VISIBLE' | 'SWIR' | 'THERMAL'; outputs: ['Imagery'];
  area: AreaChoice; areaConfirmation: string;
  baselineDate: string; recentDate: string; timezone: string;
  maxResolutionM: number | null; cloudCover: number | null; revisitHours: number | null;
  spectralRequirements: string; timingToDiscuss: boolean;
  requestedWindow: { startUtc: string; endUtc: string; localStart: string; localEnd: string; timezone: string } | null;
  deadline: { utc: string; local: string; timezone: string } | null;
  timingNotes: string; unknowns: string[]; contact: { name: string; email: string; organization: string };
  selectedEvidence: { itemId: string; evidenceVersion: string }[];
  discovery?: DiscoverySnapshot;
  catalogContext?: CatalogContext;
}
export interface LegacyEvidenceSnapshot {
  itemId: string; evidenceVersion: string; name: string; verified: boolean;
  operator: string | null; ownerCountry: string | null; sensors: string[] | null; resolutionM: number | null;
  source: string | null; checkedAt: string | null; caveats: string[];
  matchReasons?: string[]; uncertainties?: string[]; matchesReviewedCriteria?: boolean;
}
export type EvidenceSnapshot = LegacyEvidenceSnapshot | RealEvidenceSnapshot;
export interface RequestEvent { id: string; type: string; actorName: string; occurredAt: string; message: string }
export interface RequestProjection {
  id: string; reference: string; organizationId: string; organizationName: string;
  title: string; status: RequestStatus; requestVersion: number; briefRevision: number;
  firstSavedAt: string; submittedAt: string | null; submittedBy: string | null;
  originalSubmittedContact: BriefContact | null; brief: NormalizedBrief;
  evidence: EvidenceSnapshot[]; history: RequestEvent[];
  matchingState: 'Preliminary check ready' | 'Automatic check unavailable';
  humanReview: 'Not submitted' | 'Manual review required'; responseTarget: null;
  messages: ClarificationMessage[]; revisions: BriefRevisionProjection[];
  currentQuote: QuoteProjection | null; acceptedQuote: QuoteProjection | null;
  earlierQuotes: QuoteProjection[]; decisions: QuoteDecision[]; schedule: ScheduleProjection | null;
  currentProposedPlan: ProposedPlanProjection | null; earlierProposedPlans: ProposedPlanProjection[];
  acceptedPlan: AcceptedPlanSnapshot | null;
  delivery?: DeliveryProjection | null;
}
export interface CommandEnvelope {
  commandId: string; contextGeneration: number; contextToken: string;
  target: { organizationId?: string; requestId?: string };
  expected: Record<string, number>; payload: { brief: BriefInput; selection?: PlanSelectionInput }; reviewToken: string;
}
export interface SubmissionReview {
  reviewToken: string; brief: NormalizedBrief; organization: Organization; expiresAt: string;
  contextGeneration: number;
  proposedPlan?: ProposedPlanReview;
}
export interface SubmissionOutcome {
  outcome: 'saved' | 'replayed'; requestId: string; reference: string;
  requestVersion: number; contextGeneration: number; detailsUnavailable?: boolean;
  proposedPlanId?: string; proposedPlanVersion?: number;
}
export interface ApiErrorBody {
  code: string; message: string; fieldErrors?: Record<string, string>; retryable: boolean; correlationId: string;
}
