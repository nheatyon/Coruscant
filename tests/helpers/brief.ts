import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import type { BriefInput } from '../../shared/contracts.js';
/** Newly authored synthetic test input, never a seeded completed user request. */
export function validBrief(overrides: Partial<BriefInput> = {}): BriefInput {
  const b: BriefInput = {
    ...createEmptyBrief(), purpose: 'Compare possible surface-water expansion before and after heavy rainfall in this river/estuary area.',
    sensor: 'SAR', latitude: '52.6', longitude: '-9.7', radiusKm: '25',
    baselineDate: '2026-10-07', recentDate: '2026-10-14', timezone: 'UTC',
    maxResolution: '10', contact: { name: 'Demonstration contact', email: 'researcher@estuary.example', organization: 'Demo Estuary Research' },
    timingToDiscuss: false, windowStart: '2026-10-23T08:00', windowEnd: '2026-10-25T18:00',
    acknowledged: true, ...overrides,
  };
  b.areaChoice = { method: 'coordinates', generation: 1, latitude: Number(b.latitude), longitude: Number(b.longitude), radiusKm: Number(b.radiusKm) };
  b.areaConfirmation = areaSignature(b.areaChoice);
  return b;
}
