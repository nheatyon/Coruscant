import { json2satrec, propagate, gstime, eciToEcf, type OMMJsonObject } from 'satellite.js';
import type { NormalizedOMM } from '../../shared/orbital-contracts.js';
import { latLonToVector, type Vec3 } from '../../shared/globe.js';

const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), RAD = Math.PI / 180;
export interface Observer { ecfKm: Vec3; up: Vec3 }
export interface PropagatedPosition {
  ok: true; at: string; catalogNumber: string;
  teme: { positionKm: Vec3; velocityKmPerSecond: Vec3 }; ecfKm: Vec3;
  geodetic: { latitude: number; longitude: number; heightKm: number }; display: Vec3;
}
export interface PropagationFailure { ok: false; at: string; reason: string; errorCode?: number }
export type PropagationResult = PropagatedPosition | PropagationFailure;
export interface OrbitPropagator { readonly catalogNumber: string; readonly epoch: string; at: (utc: string) => PropagationResult }
const finiteVector = (value: Vec3 | null | undefined): value is Vec3 => !!value && [value.x, value.y, value.z].every(Number.isFinite);
export function canonicalInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function epochInstant(omm: NormalizedOMM): string {
  if (omm.CENTER_NAME !== 'EARTH' || omm.REF_FRAME !== 'TEME' || omm.TIME_SYSTEM !== 'UTC' || omm.MEAN_ELEMENT_THEORY !== 'SGP4') throw new Error('Unsupported orbit reference metadata.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:[0-5]\d(?:\.\d{1,9})?Z?$/.test(omm.EPOCH)) throw new Error('The declared UTC element epoch is invalid.');
  const time = Date.parse(omm.EPOCH.endsWith('Z') ? omm.EPOCH : `${omm.EPOCH}Z`);
  if (!Number.isFinite(time)) throw new Error('The element epoch is unavailable.');
  return new Date(time).toISOString();
}
/** Approximate ECF -> WGS84 geodetic. Physical coordinates are never derived from display vectors. */
export function ecfToGeodetic(ecf: Vec3): { latitude: number; longitude: number; heightKm: number } | null {
  if (!finiteVector(ecf)) return null;
  const p = Math.hypot(ecf.x, ecf.y);
  if (p < 1e-12) return Math.abs(ecf.z) > 0 ? { latitude: Math.sign(ecf.z) * 90, longitude: 0, heightKm: Math.abs(ecf.z) - A * (1 - F) } : null;
  let latitude = Math.atan2(ecf.z, p * (1 - E2));
  for (let iteration = 0; iteration < 30; iteration++) {
    const sin = Math.sin(latitude), n = A / Math.sqrt(1 - E2 * sin * sin), next = Math.atan2(ecf.z + E2 * n * sin, p);
    if (Math.abs(next - latitude) < 1e-14) { latitude = next; break; }
    latitude = next;
  }
  const sin = Math.sin(latitude), cos = Math.cos(latitude), n = A / Math.sqrt(1 - E2 * sin * sin);
  const heightKm = Math.abs(cos) > 1e-8 ? p / cos - n : ecf.z / sin - n * (1 - E2);
  const result = { latitude: latitude / RAD, longitude: Math.atan2(ecf.y, ecf.x) / RAD, heightKm };
  return Object.values(result).every(Number.isFinite) ? result : null;
}
export function observerAt(latitude: number, longitude: number): Observer {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new Error('A finite geodetic Earth center is required.');
  const phi = latitude * RAD, lambda = longitude * RAD, sin = Math.sin(phi), cos = Math.cos(phi), n = A / Math.sqrt(1 - E2 * sin * sin);
  return { ecfKm: { x: n * cos * Math.cos(lambda), y: n * cos * Math.sin(lambda), z: n * (1 - E2) * sin }, up: { x: cos * Math.cos(lambda), y: cos * Math.sin(lambda), z: sin } };
}
export function lookAngles(ecfKm: Vec3, observer: Observer): { elevationDeg: number; slantRangeKm: number } | null {
  if (!finiteVector(ecfKm) || !finiteVector(observer.ecfKm) || !finiteVector(observer.up)) return null;
  const x = ecfKm.x - observer.ecfKm.x, y = ecfKm.y - observer.ecfKm.y, z = ecfKm.z - observer.ecfKm.z;
  const range2 = x * x + y * y + z * z;
  if (!Number.isFinite(range2) || range2 < 1e-18) return null;
  const vertical = x * observer.up.x + y * observer.up.y + z * observer.up.z;
  return { elevationDeg: Math.atan2(vertical, Math.sqrt(Math.max(0, range2 - vertical * vertical))) / RAD, slantRangeKm: Math.sqrt(range2) };
}
/** One isolated mutable library record per calculation, using satellite.js WGS72/improved mode. */
export function createPropagator(omm: NormalizedOMM): OrbitPropagator {
  if (!/^\d{1,9}$/.test(omm.NORAD_CAT_ID) || Number(omm.NORAD_CAT_ID) <= 0) throw new Error('The full catalog identity is invalid.');
  const epoch = epochInstant(omm);
  const input = { ...omm, EPOCH: epoch, NORAD_CAT_ID: Number(omm.NORAD_CAT_ID) } as OMMJsonObject;
  const satrec = json2satrec(input, 'i');
  if (satrec.error || !Number.isFinite(satrec.jdsatepoch)) throw new Error(`The orbit could not be initialized (${satrec.error}).`);
  return { catalogNumber: omm.NORAD_CAT_ID, epoch, at(utc) {
    if (!canonicalInstant(utc)) return { ok: false, at: utc, reason: 'Use an exact UTC instant with millisecond precision.' };
    try {
      const date = new Date(utc), position = propagate(satrec, date);
      if (!position || satrec.error || !finiteVector(position.position) || !finiteVector(position.velocity)) return { ok: false, at: utc, reason: 'Propagation is unavailable or the orbit is decayed.', errorCode: satrec.error };
      const ecfKm = eciToEcf(position.position, gstime(date)), geodetic = ecfToGeodetic(ecfKm);
      if (!geodetic || geodetic.heightKm <= 0) return { ok: false, at: utc, reason: 'The predicted position is nonfinite or below the reference surface.' };
      const display = latLonToVector(geodetic.latitude, geodetic.longitude, 1 + geodetic.heightKm / A);
      return { ok: true, at: utc, catalogNumber: omm.NORAD_CAT_ID, teme: { positionKm: { ...position.position }, velocityKmPerSecond: { ...position.velocity } }, ecfKm, geodetic, display };
    } catch { return { ok: false, at: utc, reason: 'The current element set could not produce a valid predicted position.' }; }
  } };
}
