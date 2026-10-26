import type { EOBandCapability } from './eo-capabilities.js';
/** Public suggestions and learner choices; these records never establish runtime authority. */
export const DISCOVERY_RULES_VERSION = 'coruscant-local-rules-v1';
export type DiscoveryFamily = 'EO' | 'SPACE' | 'COMMUNICATIONS' | 'SERVICING';
export type DiscoverySensor = 'OPEN' | 'SAR' | 'VISIBLE' | 'SWIR' | 'THERMAL';
export type DiscoveryOutput = 'Imagery' | 'Video' | 'GIS';
export interface DiscoveryWindow { startUtc: string; endUtc: string }
export interface DiscoveryValues {
  family: DiscoveryFamily | null; sensor: DiscoverySensor | null; maxResolutionM: number | null;
  outputs: DiscoveryOutput[] | null; keyword: string | null; operator: string | null; ownerCountry: string | null;
  place: string | null; cloudCover: number | null; revisitHours: number | null;
  timezone: string | null; window: DiscoveryWindow | null; deadline: string | null; delivery: string | null;
  documentedOnly: boolean;
}
export type DiscoveryField = keyof DiscoveryValues;
export type DiscoveryValue = DiscoveryValues[DiscoveryField];
export interface SourceSpan { start: number; end: number }
export interface DiscoveryFact {
  field: DiscoveryField; value: DiscoveryValue; phrase: string; span: SourceSpan | null;
  origin: 'stated' | 'inferred' | 'manual'; ruleId: string; generation: number;
}
export interface ManualChoice { field: DiscoveryField; action: 'SET' | 'CLEAR'; value?: DiscoveryValue; label: string }
export interface DiscoveryExclusion extends Omit<DiscoveryFact, 'field' | 'value'> {
  field: 'sensor' | 'family' | 'outputs'; value: string;
  /** False only after an explicit opposing manual choice is acknowledged against this query. */
  active?: boolean;
}
export interface DiscoveryDiagnostic {
  id: string; field: DiscoveryField | 'description'; phrase: string; span: SourceSpan | null;
  reason: string; severity: 'unresolved' | 'conflict';
  requiresManual?: boolean;
}
export interface DiscoveryRoute { kind: 'EO' | 'PLANNED' | 'REVIEW'; family?: DiscoveryFamily; reason: string }
export interface DiscoverySnapshotInput {
  rulesVersion: string; generation: number; originalText: string; manual: ManualChoice[]; reviewedSignature?: string;
}
export interface DiscoveryInterpretation extends DiscoverySnapshotInput {
  facts: DiscoveryFact[]; exclusions: DiscoveryExclusion[]; diagnostics: DiscoveryDiagnostic[];
  effective: DiscoveryValues; rationale: string[]; route: DiscoveryRoute; reviewSignature: string;
}
export type DiscoverySnapshot = DiscoveryInterpretation;
export interface DictionaryEntry { value: string; label: string; aliases: string[] }
export interface DiscoveryDictionary { operators: DictionaryEntry[]; countries: DictionaryEntry[]; places: DictionaryEntry[] }
export interface InterpretNeedInput {
  text: string; generation: number; manual?: ManualChoice[]; dictionary?: DiscoveryDictionary; reviewedSignature?: string;
}
/** Broader optional rank dimensions remain unknown for the actual six fictional catalog records. */
export interface DiscoveryEvidence {
  id: string; name: string; family: string; type: 'catalog' | 'service'; operator: string | null; ownerCountry: string | null;
  sensors: string[] | null; resolutionM: number | null; evidenceVersion: string; source: string; checkedAt: string;
  demonstration: boolean; caveats: string[]; status: 'operational' | 'unknown' | 'ended'; launchDate: string | null;
  aliases?: string[]; operatorCode?: string | null; noradId?: number | null; cosparId?: string | null;
  commercial?: boolean | null;
  /** Explicit false means source scope alone, not independently documented mission/service family. */
  familyDocumented?: boolean;
  bandCapabilities?: EOBandCapability[];
}
export interface EvidenceMatch<T extends DiscoveryEvidence = DiscoveryEvidence> { item: T; reasons: string[]; unknowns: string[]; documentedCriteria: number }
export interface EvidenceExclusion<T extends DiscoveryEvidence = DiscoveryEvidence> { item: T; reasons: string[] }
export interface EvidenceMatches<T extends DiscoveryEvidence = DiscoveryEvidence> { matches: EvidenceMatch<T>[]; excluded: EvidenceExclusion<T>[]; total: number }
export interface DiscoveryBriefRequirements {
  family: string; sensor: string; outputs: string[]; maxResolutionM: number | null;
  cloudCover: number | null; revisitHours: number | null;
  timezone?: string; requestedWindow?: { startUtc: string; endUtc: string } | null; deadline?: { utc: string } | null;
}
