/** Cited instrument facts, separate from an element set, output grid or available service. */
export interface EOBandCapability {
  instrument: string; mode: string; sensor: 'VISIBLE' | 'SWIR' | 'THERMAL';
  bands: string[];
  equivalentSpectralSamples?: { band: string; wavelengthNm: number; bandwidthNm: number }[];
  wavelengthRangesUm: { minimum: number; maximum: number }[];
  spatialResolutionM: number; metric: 'source-stated native spatial resolution';
  distributedPixelSpacingM: number | null; nominalSwathKm: number;
  measurement: 'reflected-light' | 'emitted-thermal';
  sourceUrl: string; section: string; checkedAt: string;
  caveat: string;
}
