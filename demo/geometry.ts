import { EARTH_DISPLAY_RADIUS, GEOGRAPHIC_FRAME, GEOMETRY_CADENCE_SECONDS, GEOMETRY_METHOD, GEOMETRY_SPAN_DAYS, type DemoGeometry, type GeometryKnot } from '../shared/globe.js';
import { canonicalDemoEpoch } from './catalog.js';

export const GEOMETRY_RECIPE_VERSION = 'synthetic-display-geometry-v1';
export const GEOMETRY_RECIPE = {
  recipeVersion: GEOMETRY_RECIPE_VERSION, frame: GEOGRAPHIC_FRAME, method: GEOMETRY_METHOD,
  earthRadius: EARTH_DISPLAY_RADIUS, spanDays: GEOMETRY_SPAN_DAYS, cadenceSeconds: GEOMETRY_CADENCE_SECONDS,
  objects: [
    { itemId: 'demo-sar-03', displayRadius: 1.12, tiltDeg: 55, azimuthDeg: -25, phaseDeg: 20, periodSeconds: 5400 },
    { itemId: 'demo-sar-08', displayRadius: 1.16, tiltDeg: 75, azimuthDeg: 45, phaseDeg: 140, periodSeconds: 6600 },
    { itemId: 'demo-sar-country', displayRadius: 1.10, tiltDeg: 35, azimuthDeg: 120, phaseDeg: 260, periodSeconds: 7500 },
  ],
} as const;

/** Fresh deterministic display recipe; the server persists D0/hash and never advances them. */
export function makeGeometry(d0: string): DemoGeometry {
  const epoch = canonicalDemoEpoch(d0), origin = Date.parse(epoch), halfSpan = GEOMETRY_SPAN_DAYS * 86400, cadence = GEOMETRY_CADENCE_SECONDS;
  const spanStart = new Date(origin - halfSpan * 1000).toISOString(), spanEnd = new Date(origin + halfSpan * 1000).toISOString();
  const tracks = GEOMETRY_RECIPE.objects.map(object => {
    const radians = Math.PI / 180, b = object.azimuthDeg * radians, i = object.tiltDeg * radians, f = object.phaseDeg * radians;
    const u = { x: Math.cos(b), y: 0, z: -Math.sin(b) }, east = { x: -Math.sin(b), y: 0, z: -Math.cos(b) };
    const v = { x: Math.cos(i) * east.x, y: Math.sin(i), z: Math.cos(i) * east.z };
    const knots: GeometryKnot[] = [];
    for (let elapsed = -halfSpan; elapsed <= halfSpan; elapsed += cadence) {
      const a = f + 2 * Math.PI * elapsed / object.periodSeconds;
      const direction = { x: u.x * Math.cos(a) + v.x * Math.sin(a), y: u.y * Math.cos(a) + v.y * Math.sin(a), z: u.z * Math.cos(a) + v.z * Math.sin(a) };
      const norm = Math.hypot(direction.x, direction.y, direction.z);
      knots.push({ at: new Date(origin + elapsed * 1000).toISOString(), radius: object.displayRadius, direction: { x: direction.x / norm, y: direction.y / norm, z: direction.z / norm } });
    }
    return { ...object, frame: GEOGRAPHIC_FRAME, method: GEOMETRY_METHOD, epoch, spanStart, spanEnd, cadenceSeconds: cadence, knots, noradId: null, cosparId: null, elements: null, altitudeKm: null, propagator: null };
  });
  return { recipeVersion: GEOMETRY_RECIPE_VERSION, frame: GEOGRAPHIC_FRAME, method: GEOMETRY_METHOD, epoch, spanStart, spanEnd, cadenceSeconds: cadence, earthRadius: EARTH_DISPLAY_RADIUS, tracks };
}
