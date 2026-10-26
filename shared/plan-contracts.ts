import type { BriefInput, NormalizedBrief } from './contracts.js';
import type { CapabilityFact, OrbitEvidence, OrbitalPathPoint, OrbitalSourceSummary, SourceValidation } from './orbital-contracts.js';

/** C13/C14: choices travel over the existing guarded local JSON transport.
 * Browser claims about roles, source facts or passed checks confer no authority. */
export interface AssessmentHandle { assessmentId: string; generation: number; readCapability: string }
export interface AssessmentStartInput {
  generation: number; brief: BriefInput;
  request?: { requestId: string; requestVersion: number; briefRevision: number };
}
export type AssessmentState = 'QUEUED' | 'RUNNING' | 'COMPLETE' | 'INCOMPLETE' | 'CANCELED' | 'INTERRUPTED' | 'FAILED';
export type AssessmentPageKind = 'OPTIONS' | 'OUTCOMES';
export interface AssessmentReadInput extends AssessmentHandle {
  cursor?: string; kind?: AssessmentPageKind; optionId?: string;
}
/** Read-only exact-instant checks; acknowledgement and durable save stay separate. */
export interface AssessmentRecheckInput extends AssessmentHandle { optionId: string; proposedAtUtc: string }
export interface AssessmentRecheckResult { handle: AssessmentHandle; option: PlanOption; selectedView: AssessmentSelectedView | null }
export interface AssessmentCounts {
  catalogUnique: number; matching: number;
  /** Ready orbit inputs, not verified sensor imageability or a ready-plan count. */
  ready: number;
  completed: number; positive: number; checkedNegative: number;
  stale: number; insufficient: number; incomplete: number; notAssessed: number;
  remaining: number; evaluations: number;
}
export interface AssessmentLimits {
  coarseSeconds: 10; refinementSeconds: 1; maxObjectEvaluations: 20000;
  maxEvaluations: 2000000; maxExecutionMs: 60000;
  maxOpportunitiesPerObject: 200; maxManifestBytes: 33554432;
}
export interface PlanInputSummary {
  purposeDigest: string; observationIntent: 'single-observation' | 'comparison';
  area: NormalizedBrief['area']; areaSource: NormalizedBrief['areaSource'];
  timezone: string; baselineDate: string; recentDate: string;
  window: { startUtc: string; endUtc: string };
  sensor: NormalizedBrief['sensor']; maxResolutionM: number | null;
  cloudCover: number | null; revisitHours: number | null; spectralRequirements: string;
  outputs: string[]; timingNotes: string; unknowns: string[];
}
export type PlanCheckState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'BOUNDARY_UNCERTAIN' | 'NOT_APPLICABLE';
export interface PlanCheck {
  id: string; label: string; applicability: 'REQUIRED' | 'CONTEXT' | 'NOT_APPLICABLE';
  state: PlanCheckState; reason: string;
  actualValue: number | string | null; requiredValue: number | string | null;
  unit: string | null; sourceFactIds: string[];
}
export interface PlanUnknown { id: string; label: string; reason: string }
export interface PlanModelAssumption { id: string; label: string; sourceFactIds: string[] }
/** Optional and explicitly entered; never a provider promise or a default ETA. */
export interface PlanUserAssumption { id: 'processing-hours'; hours: number; explanation: string }
export interface PlanOption {
  id: string; itemId: string; catalogNumber: string; name: string; evidenceVersion: string;
  instrument: string | null; mode: string | null; product: string | null;
  sensor: NormalizedBrief['sensor']; bands: string[]; spatialResolutionM: number | null;
  measurement: string | null; sourceOrbit: OrbitEvidence; capabilityFactIds: string[];
  los: { startUtc: string; endUtc: string; peakUtc: string; peakElevationDeg: number;
    slantRangeKm: number; clippedStart: boolean; clippedEnd: boolean };
  nominalClosest: { atUtc: string; distanceKm: number; thresholdKm: number } | null;
  proposedAtUtc: string | null;
  coverage: 'COMPLETE' | 'PARTIAL'; outcome: 'READY' | 'PROVISIONAL' | 'INELIGIBLE';
  checks: PlanCheck[]; unknowns: PlanUnknown[]; assumptions: PlanModelAssumption[]; reasons: string[];
}
export interface AssessmentObjectOutcome {
  itemId: string; name: string;
  state: 'POSITIVE' | 'CHECKED_NEGATIVE' | 'STALE' | 'INSUFFICIENT' | 'INCOMPLETE' | 'NOT_ASSESSED';
  reason: string; evaluations: number; opportunityIds: string[];
  epoch: string | null; retrievedAt: string | null;
}
export interface AssessmentManifestRef {
  assessmentId: string; manifestDigest: string; inputDigest: string;
  snapshotVersion: string; factVersion: string; completedAt: string; attachmentExpiresAt: string;
}
export interface AssessmentSelectedView {
  optionId: string; itemId: string; atUtc: string;
  arc: { points: OrbitalPathPoint[]; sourceCadenceSeconds: 10; displayStepSeconds: number;
    startUtc: string; endUtc: string; clippedStart: boolean; clippedEnd: boolean } | null;
}
export interface AssessmentPage {
  handle: AssessmentHandle; state: AssessmentState; queuePosition: number | null;
  serverNow: string; startedAt: string | null; completedAt: string | null;
  snapshotVersion: string; factVersion: string; inputDigest: string;
  input: PlanInputSummary; validation: SourceValidation; sources: OrbitalSourceSummary[];
  counts: AssessmentCounts; limits: AssessmentLimits; reason: string | null; coverageWarnings: string[];
  kind: AssessmentPageKind; options: PlanOption[]; outcomes: AssessmentObjectOutcome[];
  totalOptions: number; totalOutcomes: number; nextCursor: string | null;
  preferredOptionId: string | null; manifest: AssessmentManifestRef | null;
  attachmentReference: string | null; selectedView?: AssessmentSelectedView | null;
  /** Only facts actually referenced by this page/selection; full lineage stays private. */
  facts: CapabilityFact[];
}
export interface PlanSelectionInput {
  handle: AssessmentHandle; attachmentReference: string; optionId: string;
  proposedAtUtc: string | null; acknowledgedUnknownIds: string[]; assumptions: PlanUserAssumption[];
}
export interface ProposedPlanProjection {
  id: string; requestId: string; organizationId: string; version: number; briefRevision: number;
  assessment: AssessmentManifestRef; input: PlanInputSummary; option: PlanOption;
  selectedAtUtc: string | null; acknowledgedUnknownIds: string[]; assumptions: PlanUserAssumption[];
  createdAt: string; actorId: string; actorName: string; digest: string;
  state: 'CURRENT' | 'INVALIDATED' | 'ACCEPTED_SNAPSHOT';
  invalidatedAt: string | null; invalidationReason: string | null;
  facts: CapabilityFact[];
}
/** An outer null means no acceptance. An inner null is accepted work with no selected plan. */
export interface AcceptedPlanSnapshot { plan: ProposedPlanProjection | null }
export interface AssessmentHandoffInput { handle: AssessmentHandle; nonce: string }
export interface AssessmentHandoffContinuation { handle: AssessmentHandle; continuationNonce: string }
export interface AssessmentHandoffResult { handle: AssessmentHandle; attachmentReference: string; manifest: AssessmentManifestRef }
