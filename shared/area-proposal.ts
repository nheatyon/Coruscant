import { EARTH_RADIUS_KM, vectorToLatLon, type Vec3 } from './globe.js';

/** A staged area is never an applied or independently confirmed brief target. */
export interface AreaCircle { latitude: number; longitude: number; radiusKm: number }
export interface AreaProposal { generation: number; origin: 'globe-drag' | 'numeric' | 'lookup'; circle: AreaCircle }
export type AreaInteractionMode = 'rotate' | 'select';
export type AreaStrokeFeedback =
  | { phase: 'start' }
  | { phase: 'move'; circle: AreaCircle | null; message: string }
  | { phase: 'complete'; circle: AreaCircle }
  | { phase: 'cancel' | 'blocked'; message: string };
export const DRAWING_MIN_RADIUS_KM = 1;
export const DRAWING_MAX_RADIUS_KM = 500;
export const EARTH_INPUT_MIN_FACING = .02;

export function validAreaCircle(value: unknown): value is AreaCircle {
  if (!value || typeof value !== 'object') return false;
  const v = value as AreaCircle;
  return Number.isFinite(v.latitude) && v.latitude >= -90 && v.latitude <= 90 && Number.isFinite(v.longitude) && v.longitude >= -180 && v.longitude <= 180 && Number.isFinite(v.radiusKm) && v.radiusKm >= .001;
}
function unit(value: Vec3): Vec3 | null {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite)) return null;
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 0 && Number.isFinite(length) ? { x: value.x / length, y: value.y / length, z: value.z / length } : null;
}
/** Uses the surface normal and camera→surface ray, independently of screen pixels. */
export function stableNearSideHit(surfaceNormal: Vec3, rayDirection: Vec3): boolean {
  const normal = unit(surfaceNormal), direction = unit(rayDirection);
  return !!normal && !!direction && -(normal.x * direction.x + normal.y * direction.y + normal.z * direction.z) > EARTH_INPUT_MIN_FACING;
}
export function shortestGroundDistanceKm(first: Vec3, second: Vec3): number | null {
  const a = unit(first), b = unit(second); if (!a || !b) return null;
  const cross = Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  return EARTH_RADIUS_KM * Math.atan2(cross, Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
}
/** Rejects the measured drawing radius; never clamps or broadens numeric limits. */
export function drawingArea(center: Vec3, edge: Vec3): { circle: AreaCircle | null; measuredRadiusKm: number | null; message: string } {
  const coordinates = vectorToLatLon(center), radiusKm = shortestGroundDistanceKm(center, edge);
  if (!coordinates || radiusKm === null) return { circle: null, measuredRadiusKm: null, message: 'Move onto the visible Earth.' };
  if (radiusKm < 1e-9) return { circle: null, measuredRadiusKm: radiusKm, message: 'Drag to set a radius, or enter coordinates.' };
  if (radiusKm < DRAWING_MIN_RADIUS_KM || radiusKm > DRAWING_MAX_RADIUS_KM) return { circle: null, measuredRadiusKm: radiusKm, message: `Measured radius ${radiusKm.toFixed(3)} km is outside the drawing range of1–500km. Use numeric coordinates/radius for finer or larger areas.` };
  return { circle: { latitude: coordinates.latitude, longitude: coordinates.longitude, radiusKm }, measuredRadiusKm: radiusKm, message: 'Release to preview; then use and confirm the area separately.' };
}
export function nextAreaGeneration(...values: (number | null | undefined)[]): number {
  const current = Math.max(0, ...values.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0));
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('Area generation is exhausted; reopen this preparation.');
  return current + 1;
}
