import type { DiscoveryDictionary, DiscoveryEvidence, DiscoveryExclusion, DiscoveryValues, EvidenceMatch } from './discovery-contracts.js';

export type OrbitalSourceKey = 'sar' | 'resource';
export type SourceValidation = 'COMPLETE' | 'PARTIAL';
export interface OrbitalSourceSummary {
  key:OrbitalSourceKey; url:string; version:string|null; retrievedAt:string|null; checkedAt:string|null;
  validation:SourceValidation|'UNAVAILABLE'; rows:number; identified:number; rejected:number; invalidOrbits:number;
  responseHash:string|null; attemptedAt:string|null; nextAllowedAt:string|null; error:string|null;
}
/** Algorithm values are separate from canonical identity and source metadata. */
export interface NormalizedOMM {
  OBJECT_NAME:string; OBJECT_ID:string; EPOCH:string; NORAD_CAT_ID:string;
  CENTER_NAME:'EARTH'; REF_FRAME:'TEME'; TIME_SYSTEM:'UTC'; MEAN_ELEMENT_THEORY:'SGP4';
  MEAN_MOTION:number; ECCENTRICITY:number; INCLINATION:number; RA_OF_ASC_NODE:number;
  ARG_OF_PERICENTER:number; MEAN_ANOMALY:number; EPHEMERIS_TYPE:number;
  CLASSIFICATION_TYPE:string; ELEMENT_SET_NO:number; REV_AT_EPOCH:number;
  BSTAR:number; MEAN_MOTION_DOT:number; MEAN_MOTION_DDOT:number;
}
export interface CapabilityFact {
  id:string; canonicalId:string; field:'family'|'sensor'|'operator'|'operatorCode'|'program'|'resolution'|'missionHistory'|'instrument'|'band'|'spatialResolution'|'nominalSwath'|'wavelength';
  value:string|number|number[]; unit:string|null; mode:string|null; product:string|null;
  sourceUrl:string; section:string; checkedAt:string; version:string; uncertainty:string;
}
export interface SourceMembership {
  group:OrbitalSourceKey; sourceVersion:string; retrievedAt:string; rowHash:string;
  confirmation:'CONFIRMED'|'UNCONFIRMED'; lastSeenAt:string;
}
export interface OrbitEvidence {
  state:'VALID'|'INVALID'|'CONFLICT'|'MISSING'; elementVersion:string|null; epoch:string|null; sourceEpoch:string|null;
  retrievedAt:string|null; orbitalHash:string|null; reason:string|null; sourceVersions:string[];
}
export interface RealCatalogItem extends DiscoveryEvidence {
  sourceKind:'PUBLIC_REAL'; demonstration:false; catalogNumber:string; noradId:number;
  snapshotVersion:string; factVersion:string; memberships:SourceMembership[];
  orbit:OrbitEvidence; capabilityFacts:CapabilityFact[]; classification:string[];
  capabilityState:'DOCUMENTED'|'UNKNOWN'|'NEEDS_REVIEW';
  identitySources:{name:string;cosparId:string|null;sourceVersion:string;rowHash:string;group:OrbitalSourceKey}[];
}
export interface RealCatalogCounts {
  unique:number; matching:number; unknown:number; excluded:number; rejected:number;
  invalidOrbits:number; loaded:number; sourceTotal:null;
}
export interface RealCatalogQuery {
  snapshotVersion?:string; cursor?:string; criteria?:DiscoveryValues; exclusions?:DiscoveryExclusion[];
}
export interface RealCatalogPage {
  sourceKind:'PUBLIC_REAL'; snapshotVersion:string|null; factVersion:string; serverNow:string;
  availability:'READY'|'UNAVAILABLE'; validation:SourceValidation|'UNAVAILABLE'; sources:OrbitalSourceSummary[];
  counts:RealCatalogCounts; items:EvidenceMatch<RealCatalogItem>[]; nextCursor:string|null;
  dictionary:DiscoveryDictionary; message:string|null;
}
export interface RealCatalogDetail {
  snapshotVersion:string; factVersion:string; item:RealCatalogItem; match:EvidenceMatch<RealCatalogItem>|null;
  exclusionReasons:string[]; serverNow:string;
}
export interface RealEvidenceSnapshot {
  sourceKind:'PUBLIC_REAL'; itemId:string; evidenceVersion:string; name:string; verified:true;
  operator:string|null; ownerCountry:string|null; sensors:string[]|null; resolutionM:number|null;
  source:string; checkedAt:string; caveats:string[]; matchReasons:string[]; uncertainties:string[];
  matchesReviewedCriteria:boolean; snapshotVersion:string; factVersion:string; catalogNumber:string;
  memberships:SourceMembership[]; orbit:OrbitEvidence; capabilityFacts:CapabilityFact[];
  /** Exact server-resolved facts for later revision rematching; never current-source substitution. */
  matchingFacts:RealCatalogItem;
}
export interface NormalizedSourceRow {
  id:string; catalogNumber:string; name:string; aliases:string[]; cosparId:string|null;
  rowHash:string; omm:NormalizedOMM|null; orbitalHash:string|null; epoch:string|null; sourceEpoch:string|null; error:string|null;
}
export interface ParsedSource {
  group:OrbitalSourceKey; version:string; responseHash:string; retrievedAt:string; checkedAt:string;
  validation:SourceValidation; rowCount:number; rejected:number; invalidOrbits:number; rows:NormalizedSourceRow[];
}
export interface CatalogCapture {
  snapshotVersion:string; factVersion:string; validation:SourceValidation; sources:OrbitalSourceSummary[];
  items:RealCatalogItem[]; dictionary:DiscoveryDictionary; rejected:number;
}
export interface BrowseCandidate { item:RealCatalogItem; omm:NormalizedOMM|null; matched:boolean; positionSelected:boolean; pathSelected:boolean }
export interface BrowseSnapshot {
  snapshotVersion:string; factVersion:string; validation:SourceValidation; sources:OrbitalSourceSummary[];
  matching:number; candidates:BrowseCandidate[]; displayLimited:number; pathsLimited:number;
  sourceRejected:number;
}
export interface OrbitalBrowseInput {
  snapshotVersion:string; factVersion:string; representedAt:string; generation:number;
  criteria:DiscoveryValues; exclusions?:DiscoveryExclusion[]; selectedId?:string|null;
  shortlistedIds?:string[]; visibility?:'ALL'|'MATCHES'|'SHORTLIST'|'SHORTLIST_ONLY'; cursor?:string;
}
export interface OrbitalPosition { latitude:number; longitude:number; heightKm:number; x:number; y:number; z:number }
export interface OrbitalPathPoint extends OrbitalPosition { at:string }
export interface OrbitalBrowseObject {
  id:string; name:string; evidenceVersion:string; matched:boolean; epoch:string|null; sourceEpoch:string|null; retrievedAt:string|null;
  position:OrbitalPosition|null; positionAvailability:'AVAILABLE'|'UNAVAILABLE'|'DISPLAY_LIMITED'|'INCOMPLETE';
  path:OrbitalPathPoint[][]|null; pathAvailability:'AVAILABLE'|'UNAVAILABLE'|'DISPLAY_LIMITED'|'INCOMPLETE'; reason:string|null;
  positionReason?:string|null; pathReason?:string|null; pathWindow?:{start:string;end:string;stepSeconds:30;clippedStart:boolean;clippedEnd:boolean}|null;
}
export interface OrbitalBrowsePage {
  snapshotVersion:string; factVersion:string; representedAt:string; generation:number; serverNow:string;
  objects:OrbitalBrowseObject[]; nextCursor:string|null; validation:SourceValidation;
  counts:{matching:number;positions:number;paths:number;displayLimited:number;pathsLimited:number;unavailable:number;processed:number;remaining:number};
  state:'COMPLETE'|'INCOMPLETE'; message:string|null;
}
export interface RefreshSourceOutcome { group:OrbitalSourceKey; state:'UPDATED'|'UNCHANGED'|'FAILED'|'RATE_LIMITED'|'NOT_ATTEMPTED'; message:string; nextAllowedAt:string|null }
export interface RefreshCatalogOutcome { snapshotVersion:string|null; sources:RefreshSourceOutcome[]; serverNow:string }
