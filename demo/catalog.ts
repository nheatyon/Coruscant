import type { CatalogItem } from '../shared/contracts.js';

export const DEMO_EVIDENCE_VERSION = 'demo-evidence-v1';
export const DEMO_CATALOG_SOURCE = 'Coruscant newly authored demonstration catalog';
export const demonstrationTarget = { latitude: 52.6, longitude: -9.7, radiusKm: 25 };

export interface DemoCatalogItem extends CatalogItem {
  noradId: null;
  cosparId: null;
}

/** The backend supplies the recorded initialization instant, never a new read-time date. */
export function canonicalDemoEpoch(d0: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(d0)) {
    throw new Error('The demonstration origin must be an explicit UTC initialization instant.');
  }
  const date = new Date(d0);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== d0.slice(0, 10)) {
    throw new Error('The demonstration origin is not a valid calendar instant.');
  }
  return date.toISOString();
}

export function comparisonDates(d0: string): { baselineDate: string; recentDate: string } {
  const epoch = canonicalDemoEpoch(d0);
  const day = new Date(`${epoch.slice(0, 10)}T00:00:00.000Z`);
  const offset = (days: number) => new Date(day.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { baselineDate: offset(-14), recentDate: offset(-7) };
}

export function makeCatalog(d0: string): DemoCatalogItem[] {
  const checkedAt = canonicalDemoEpoch(d0);
  const caveats = [
    'Newly authored fictional demonstration evidence, not real-provider documentation.',
    'Technical criteria do not establish area/time coverage, operator availability, price or booking.',
    'Any orbital context is labeled demonstration geometry; no telemetry or real propagation is supplied.',
  ];
  const rows: Pick<CatalogItem, 'id' | 'name' | 'operator' | 'ownerCountry' | 'sensors' | 'resolutionM'>[] = [
    { id: 'demo-sar-03', name: 'Estuary SAR 03', operator: 'Northline Demo Imaging', ownerCountry: 'IE', sensors: ['SAR'], resolutionM: 3 },
    { id: 'demo-sar-08', name: 'Coast SAR 08', operator: 'Northline Demo Imaging', ownerCountry: 'IE', sensors: ['SAR'], resolutionM: 8 },
    { id: 'demo-sar-20', name: 'Wide SAR 20', operator: 'Harbour Demo Systems', ownerCountry: 'CA', sensors: ['SAR'], resolutionM: 20 },
    { id: 'demo-visible', name: 'Coast Visible', operator: 'Harbour Demo Systems', ownerCountry: 'CA', sensors: ['VISIBLE'], resolutionM: 0.5 },
    { id: 'demo-eo-unknown', name: 'Survey Candidate', operator: null, ownerCountry: null, sensors: null, resolutionM: null },
    { id: 'demo-sar-country', name: 'Delta SAR 05', operator: 'Delta Demo Instruments', ownerCountry: null, sensors: ['SAR'], resolutionM: 5 },
  ];
  return rows.map((row) => ({
    ...row,
    family: 'EO',
    type: 'catalog',
    evidenceVersion: DEMO_EVIDENCE_VERSION,
    source: DEMO_CATALOG_SOURCE,
    checkedAt,
    demonstration: true,
    caveats: [...caveats],
    status: 'unknown',
    launchDate: null,
    noradId: null,
    cosparId: null,
  }));
}
