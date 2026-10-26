/** Public place evidence is not a confirmed area, a country filter or spacecraft capability. */
export const PLACE_RULES_VERSION = 'coruscant-place-phrase-v2';
export const PLACE_ATTRIBUTION = '© OpenStreetMap contributors · ODbL · Nominatim';
export interface PlaceSpan { start: number; end: number }
export interface PlacePhrase {
  state: 'none' | 'ready' | 'review'; phrase: string; span: PlaceSpan | null;
  origin: 'stated' | 'manual'; reason: string; rulesVersion: string;
}
export interface PlaceCandidate {
  id: string; label: string; latitude: number; longitude: number;
  osmType: 'node' | 'way' | 'relation' | null; osmId: string | null;
  kind: string | null; country: string | null; region: string | null;
  boundingBox: [number, number, number, number] | null;
}
export interface PlaceLookupResult {
  version: string; query: string; retrievedAt: string; provider: string;
  attribution: string; candidates: PlaceCandidate[]; cached: boolean;
  limit: 5; exhaustive: false;
}
/** All these fields remain local; only the separately disclosed query is sent upstream. */
export interface PlaceSourceReference {
  lookupVersion: string; candidateId: string; sourcePhrase: string;
  phraseOrigin: 'stated' | 'manual'; phraseSpan: PlaceSpan | null;
  questionAtLookup: string; reviewedPurpose: string;
  radiusAssumptionKm: 25;
}
/** Only the server creates this snapshot from its own exact cached candidate. */
export interface PlaceSourceSnapshot {
  lookupVersion: string; candidateId: string; sourcePhrase: string;
  phraseOrigin: 'stated' | 'manual'; phraseSpan: PlaceSpan | null;
  questionDigest: string; reviewedPurposeDigest: string; purposeAreaDigest: string;
  query: string; label: string; provider: string; retrievedAt: string; attribution: string;
  osmType: PlaceCandidate['osmType']; osmId: string | null;
  sourceCenter: { latitude: number; longitude: number };
  appliedCenter: { latitude: number; longitude: number };
  radiusAssumptionKm: 25; appliedRadiusKm: number; adjusted: boolean;
}
