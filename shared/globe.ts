/** Dimensionless Earth-fixed display coordinates, never orbital elements or telemetry. */
export interface Vec3 { x: number; y: number; z: number }
export const GEOGRAPHIC_FRAME = 'earth-fixed-display-v1';
export const GEOMETRY_METHOD = 'synthetic display geometry v1';
export const EARTH_DISPLAY_RADIUS = 1 as const;
export const EARTH_RADIUS_KM = 6371.0088;
export const GEOMETRY_CADENCE_SECONDS = 300;
export const GEOMETRY_SPAN_DAYS = 15;
export interface GeometryKnot { at: string; radius: number; direction: Vec3 }
export interface DemoTrack {
  itemId: string; frame: string; method: string; epoch: string; spanStart: string; spanEnd: string;
  cadenceSeconds: number; periodSeconds: number; displayRadius: number; tiltDeg: number; azimuthDeg: number; phaseDeg: number;
  knots: GeometryKnot[]; noradId: null; cosparId: null; elements: null; altitudeKm: null; propagator: null;
}
export interface DemoGeometry {
  recipeVersion: string; frame: string; method: string; epoch: string; spanStart: string; spanEnd: string;
  cadenceSeconds: number; earthRadius: 1; tracks: DemoTrack[]; recipeHash?: string;
}
export interface TrackValidation { valid: boolean; reason?: string }
export interface CircleGeometry {
  latitude: number; longitude: number; radiusKm: number; normal: Vec3; theta: number; cosTheta: number;
  ring: Vec3[]; global: boolean; areaKm2: number; diameterKm: number;
}
export interface TrackPath { points: Vec3[]; start: string; end: string; closed: boolean }
const PI = Math.PI, TAU = 2 * PI, DEG = PI / 180;
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (v: Vec3, amount: number): Vec3 => ({ x: v.x * amount, y: v.y * amount, z: v.z * amount });
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
function unit(v: Vec3): Vec3 | null {
  if (!v || ![v.x, v.y, v.z].every(Number.isFinite)) return null;
  const length = Math.hypot(v.x, v.y, v.z); return length > 0 && Number.isFinite(length) ? scale(v, 1 / length) : null;
}
function validLocation(latitude: number, longitude: number): boolean { return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180; }
export function latLonToVector(latitude: number, longitude: number, radius = 1): Vec3 {
  if (!validLocation(latitude, longitude) || !Number.isFinite(radius) || radius <= 0) throw new Error('Use finite geographic coordinates and a positive display radius.');
  const phi = latitude * DEG, lambda = longitude * DEG;
  return { x: radius * Math.cos(phi) * Math.cos(lambda), y: radius * Math.sin(phi), z: -radius * Math.cos(phi) * Math.sin(lambda) };
}
export function vectorToLatLon(vector: Vec3): { latitude: number; longitude: number; radius: number } | null {
  const direction = unit(vector); if (!direction) return null;
  return { latitude: Math.asin(clamp(direction.y, -1, 1)) / DEG, longitude: Math.hypot(direction.x, direction.z) < 1e-14 ? 0 : Math.atan2(-direction.z, direction.x) / DEG, radius: Math.hypot(vector.x, vector.y, vector.z) };
}
export function geographicUV(latitude: number, longitude: number): { u: number; v: number; imageX: number; imageY: number } {
  if (!validLocation(latitude, longitude)) throw new Error('Use valid geographic coordinates for texture coordinates.');
  const u = (longitude + 180) / 360, v = (latitude + 90) / 180;
  return { u, v, imageX: u, imageY: 1 - v };
}
export function pointerToNdc(clientX: number, clientY: number, rectangle: { left: number; top: number; width: number; height: number }): { x: number; y: number } | null {
  if (![clientX, clientY, rectangle.left, rectangle.top, rectangle.width, rectangle.height].every(Number.isFinite) || rectangle.width <= 0 || rectangle.height <= 0) return null;
  const x = (clientX - rectangle.left) / rectangle.width, y = (clientY - rectangle.top) / rectangle.height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x: 2 * x - 1, y: 1 - 2 * y };
}
export function circleGeometry(latitude: number, longitude: number, radiusKm: number, segments = 180, lift = 1.003): CircleGeometry {
  if (!validLocation(latitude, longitude) || !Number.isFinite(radiusKm) || radiusKm < 0.001 || !Number.isInteger(segments) || segments < 8 || !Number.isFinite(lift) || lift < 1) throw new Error('Use a valid deliberately chosen circle and finite drawing parameters.');
  const normal = latLonToVector(latitude, longitude), theta = Math.min(radiusKm / EARTH_RADIUS_KM, PI), global = theta === PI;
  const helper = Math.abs(normal.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const first = unit(cross(helper, normal))!, second = cross(normal, first), cosine = Math.cos(theta), sine = Math.sin(theta);
  const ring = global ? [] : Array.from({ length: segments + 1 }, (_, index) => {
    const angle = index === segments ? 0 : TAU * index / segments;
    return scale({ x: cosine * normal.x + sine * (first.x * Math.cos(angle) + second.x * Math.sin(angle)), y: cosine * normal.y + sine * (first.y * Math.cos(angle) + second.y * Math.sin(angle)), z: cosine * normal.z + sine * (first.z * Math.cos(angle) + second.z * Math.sin(angle)) }, lift);
  });
  return { latitude, longitude, radiusKm, normal, theta, cosTheta: cosine, ring, global, areaKm2: 4 * PI * EARTH_RADIUS_KM ** 2 * Math.sin(theta / 2) ** 2, diameterKm: 2 * Math.min(radiusKm, PI * EARTH_RADIUS_KM / 2) };
}
export function circleContains(normal: Vec3, theta: number, point: Vec3): boolean {
  const centre = unit(normal), direction = unit(point);
  if (!centre || !direction || !Number.isFinite(theta) || theta < 0 || theta > PI) return false;
  return Math.atan2(Math.hypot(...Object.values(cross(centre, direction))), clamp(dot(centre, direction), -1, 1)) <= theta + 1e-14;
}
export function slerpDirections(first: Vec3, second: Vec3, fraction: number): Vec3 | null {
  const a = unit(first), b = unit(second); if (!a || !b || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const cosine = clamp(dot(a, b), -1, 1); if (cosine <= -1 + 1e-10) return null;
  if (cosine >= 1 - 1e-10) return unit({ x: a.x + fraction * (b.x - a.x), y: a.y + fraction * (b.y - a.y), z: a.z + fraction * (b.z - a.z) });
  const angle = Math.acos(cosine), sine = Math.sin(angle), p = Math.sin((1 - fraction) * angle) / sine, q = Math.sin(fraction * angle) / sine;
  return unit({ x: p * a.x + q * b.x, y: p * a.y + q * b.y, z: p * a.z + q * b.z });
}
function utcMilliseconds(value: string): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const milliseconds = Date.parse(value); if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  return canonical.slice(0, 19) === value.slice(0, 19) ? milliseconds : null;
}
export function validateTrack(track: DemoTrack): TrackValidation {
  const invalid = (reason: string): TrackValidation => ({ valid: false, reason });
  if (!track || track.frame !== GEOGRAPHIC_FRAME || track.method !== GEOMETRY_METHOD) return invalid('The declared display frame or synthetic method is unavailable.');
  if (!['demo-sar-03', 'demo-sar-08', 'demo-sar-country'].includes(track.itemId)) return invalid('This catalog identity has no defined demonstration geometry.');
  if (![track.displayRadius, track.tiltDeg, track.azimuthDeg, track.phaseDeg, track.periodSeconds].every(Number.isFinite) || track.displayRadius <= 1 || track.periodSeconds <= 0 || track.cadenceSeconds !== GEOMETRY_CADENCE_SECONDS) return invalid('Drawing parameters or the declared cadence are invalid.');
  if (track.noradId !== null || track.cosparId !== null || track.elements !== null || track.altitudeKm !== null || track.propagator !== null) return invalid('Synthetic display geometry cannot claim real identifiers or orbital elements.');
  const epoch = utcMilliseconds(track.epoch), start = utcMilliseconds(track.spanStart), end = utcMilliseconds(track.spanEnd), day = 86400 * 1000;
  if (epoch === null || start === null || end === null || start !== epoch - GEOMETRY_SPAN_DAYS * day || end !== epoch + GEOMETRY_SPAN_DAYS * day) return invalid('The declared inclusive geometry span is invalid.');
  const expected = (end - start) / (track.cadenceSeconds * 1000) + 1;
  if (!Array.isArray(track.knots) || track.knots.length !== expected) return invalid('The declared keyframe sequence is incomplete.');
  let previous: Vec3 | null = null;
  for (let index = 0; index < track.knots.length; index++) {
    const knot = track.knots[index]!;
    if (!knot || utcMilliseconds(knot.at) !== start + index * track.cadenceSeconds * 1000) return invalid('Keyframes must be strictly ordered at the exact declared cadence and endpoints.');
    if (!Number.isFinite(knot.radius) || knot.radius <= 1 || !knot.direction || ![knot.direction.x, knot.direction.y, knot.direction.z].every(Number.isFinite) || Math.abs(Math.hypot(knot.direction.x, knot.direction.y, knot.direction.z) - 1) > 1e-9) return invalid('A keyframe radius or normalized direction is invalid.');
    if (previous && dot(previous, knot.direction) <= -1 + 1e-10) return invalid('An antipodal bracket has no unambiguous shortest display arc.');
    previous = knot.direction;
  }
  return { valid: true };
}
function evaluateValidated(track: DemoTrack, instant: number): Vec3 | null {
  const first = Date.parse(track.spanStart), last = Date.parse(track.spanEnd);
  if (!Number.isFinite(instant) || instant < first || instant > last) return null;
  let low = 0, high = track.knots.length - 1;
  while (low <= high) { const middle = (low + high) >>> 1, time = Date.parse(track.knots[middle]!.at); if (time === instant) return scale(track.knots[middle]!.direction, track.knots[middle]!.radius); if (time < instant) low = middle + 1; else high = middle - 1; }
  if (high < 0 || low >= track.knots.length) return null;
  const before = track.knots[high]!, after = track.knots[low]!, start = Date.parse(before.at), end = Date.parse(after.at);
  if (end - start !== track.cadenceSeconds * 1000) return null;
  const fraction = (instant - start) / (end - start), direction = slerpDirections(before.direction, after.direction, fraction);
  return direction ? scale(direction, before.radius + fraction * (after.radius - before.radius)) : null;
}
/** Full validation precedes evaluation; never extrapolate or wrap represented time. */
export function evaluateTrack(track: DemoTrack, time: string | number): Vec3 | null {
  if (!validateTrack(track).valid) return null;
  return evaluateValidated(track, typeof time === 'number' ? time : utcMilliseconds(time) ?? NaN);
}
/** Validates once, then evaluates all path samples through the same bracket interpolator. */
export function sampleTrackPath(track: DemoTrack, time: string | number): TrackPath | null {
  if (!validateTrack(track).valid) return null;
  const instant = typeof time === 'number' ? time : utcMilliseconds(time) ?? NaN;
  if (!evaluateValidated(track, instant)) return null;
  const half = track.periodSeconds * 500, start = Math.max(Date.parse(track.spanStart), instant - half), end = Math.min(Date.parse(track.spanEnd), instant + half);
  const segments = Math.max(1, Math.ceil((end - start) / (track.periodSeconds * 1000 / 72))), points: Vec3[] = [];
  for (let index = 0; index <= segments; index++) { const at = index === segments ? end : start + (end - start) * index / segments, point = evaluateValidated(track, at); if (!point) return null; points.push(point); }
  return { points, start: new Date(start).toISOString(), end: new Date(end).toISOString(), closed: start === instant - half && end === instant + half };
}
