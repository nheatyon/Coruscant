import type { EOBandCapability } from '../../shared/eo-capabilities.js';

/** Independently cited payload facts. IDs/designators are the actual adopted GP identities. */
export const EO_FACT_CHECKED_AT = '2026-10-25T04:22:43.000Z';
export const EO_IDENTITY_DESIGNATORS: Readonly<Record<string, string>> = {
  'norad:42063': '2017-013A', 'norad:60989': '2024-157A',
  'norad:39084': '2013-008A', 'norad:49260': '2021-088A',
};
const uncertainty = 'Nominal instrument evidence only: current health, pointing, whole-area imageability, recording, clouds and provider availability are unverified.';
export function opticalCapabilities(id: string): EOBandCapability[] {
  if (id === 'norad:42063' || id === 'norad:60989') {
    const base = { instrument: 'MSI', mode: 'nominal nadir pushbroom', metric: 'source-stated native spatial resolution' as const, distributedPixelSpacingM: null, nominalSwathKm: 290,
      measurement: 'reflected-light' as const, sourceUrl: 'https://sentiwiki.copernicus.eu/web/s2-mission', checkedAt: EO_FACT_CHECKED_AT, caveat: uncertainty };
    const samples = id === 'norad:42063' ? [[492.3,65],[559,35],[664.9,31],[1610.4,93],[2185.7,181]] : [[489.1,65],[560.6,35],[666.5,31],[1612,90],[2191.3,181]];
    const spectral = (bands: string[], offset: number) => bands.map((band,index) => ({ band, wavelengthNm: samples[offset + index]![0]!, bandwidthNm: samples[offset + index]![1]! }));
    // Tables3/4 give equivalent centers and widths, not measured continuous passbands.
    return [
      { ...base, sensor: 'VISIBLE', bands: ['B02', 'B03', 'B04'], equivalentSpectralSamples: spectral(['B02','B03','B04'],0), wavelengthRangesUm: [], spatialResolutionM: 10, section: 'MSI spatial resolution: visible B02/B03/B04' },
      { ...base, sensor: 'SWIR', bands: ['B11', 'B12'], equivalentSpectralSamples: spectral(['B11','B12'],3), wavelengthRangesUm: [], spatialResolutionM: 20, section: 'MSI spatial resolution: SWIR B11/B12; no10m native SWIR claim' },
    ];
  }
  if (id === 'norad:39084' || id === 'norad:49260') {
    const base = { mode: 'nominal nadir pushbroom', metric: 'source-stated native spatial resolution' as const, nominalSwathKm: 185,
      sourceUrl: id === 'norad:39084' ? 'https://science.nasa.gov/mission/landsat-8/' : 'https://science.nasa.gov/mission/landsat-9/', checkedAt: EO_FACT_CHECKED_AT, caveat: uncertainty };
    return [
      { ...base, instrument: id === 'norad:49260' ? 'OLI-2' : 'OLI', sensor: 'VISIBLE', bands: ['B02', 'B03', 'B04'], wavelengthRangesUm: [{ minimum: .45, maximum: .51 }, { minimum: .53, maximum: .59 }, { minimum: .64, maximum: .67 }], spatialResolutionM: 30, distributedPixelSpacingM: null, measurement: 'reflected-light', section: 'OLI visible multispectral bands; PAN is a distinct15m channel' },
      { ...base, instrument: id === 'norad:49260' ? 'OLI-2' : 'OLI', sensor: 'SWIR', bands: ['B06', 'B07'], wavelengthRangesUm: [{ minimum: 1.57, maximum: 1.65 }, { minimum: 2.11, maximum: 2.29 }], spatialResolutionM: 30, distributedPixelSpacingM: null, measurement: 'reflected-light', section: 'OLI shortwave infrared bands; night hot-source use needs separate constraints' },
      { ...base, instrument: id === 'norad:49260' ? 'TIRS-2' : 'TIRS', sensor: 'THERMAL', bands: ['B10', 'B11'], wavelengthRangesUm: [{ minimum: 10.60, maximum: 11.19 }, { minimum: 11.50, maximum: 12.51 }], spatialResolutionM: 100, distributedPixelSpacingM: 30, measurement: 'emitted-thermal', section: 'TIRS native100m; resampled30m pixels are not30m native resolution' },
    ];
  }
  return [];
}
