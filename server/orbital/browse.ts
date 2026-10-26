import { randomBytes, createHash } from 'node:crypto';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import type { Database } from '../db/database.js';
import type { Clock } from '../security.js';
import { ApiError } from '../errors.js';
import type { BrowseSnapshot, OrbitalBrowseInput, OrbitalBrowseObject, OrbitalBrowsePage, OrbitalPathPoint } from '../../shared/orbital-contracts.js';
import { ORBITAL_LIMITS, orbitalFreshness } from '../../shared/orbital-policy.js';
import { captureBrowseSnapshot } from './repository.js';
import { canonicalInstant, createPropagator, type OrbitPropagator, type PropagatedPosition } from './propagation.js';

export interface BrowseCalculationOptions { signal?: AbortSignal; now?: () => number; yieldControl?: () => Promise<unknown>; propagator?: typeof createPropagator }
export type BrowseCalculation = Omit<OrbitalBrowsePage, 'nextCursor'>;
const point = (value: PropagatedPosition) => ({ ...value.geodetic, ...value.display });
const aborted = () => new ApiError(409, 'BROWSE_SUPERSEDED', 'The globe changed while this display was being prepared. Its old response was discarded.');
/** No source fetches, SQL writes or private workflow mutations occur inside propagation. */
export async function calculateBrowse(snapshot: BrowseSnapshot, input: OrbitalBrowseInput, serverNow: string, options: BrowseCalculationOptions = {}): Promise<BrowseCalculation> {
  if (!canonicalInstant(input.representedAt)) throw new ApiError(422, 'TIME_INVALID', 'Choose an exact represented UTC instant.');
  const now = options.now ?? (() => performance.now()), yieldControl = options.yieldControl ?? yieldEventLoop, start = now();
  let evaluations = 0, positionsUsed = 0, pathsUsed = 0, processed = 0, remaining = 0;
  const objects: OrbitalBrowseObject[] = [];
  const check = () => { if (options.signal?.aborted) throw aborted(); return now() - start < ORBITAL_LIMITS.browseDeadlineMs; };
  const evaluate = async (orbit: OrbitPropagator, at: string) => {
    if (!check()) return null;
    const value = orbit.at(at); evaluations++;
    if (evaluations % ORBITAL_LIMITS.yieldEvaluations === 0) { await yieldControl(); if (!check()) return null; }
    return value;
  };
  let candidateIndex = 0;
  for (const candidate of snapshot.candidates) {
    if (candidateIndex++ % ORBITAL_LIMITS.browseChunkObjects === 0) await yieldControl();
    const { item } = candidate;
    const row: OrbitalBrowseObject = { id: item.id, name: item.name, evidenceVersion: item.evidenceVersion, matched: candidate.matched,
      epoch: item.orbit.epoch, sourceEpoch: item.orbit.sourceEpoch, retrievedAt: item.orbit.retrievedAt, position: null, positionAvailability: 'UNAVAILABLE',
      path: null, pathAvailability: 'UNAVAILABLE', reason: null };
    if (!check()) {
      row.positionAvailability = row.pathAvailability = 'INCOMPLETE'; row.reason = 'Not processed — the globe calculation reached its time limit.';
      row.positionReason = row.pathReason = row.reason; remaining++; objects.push(row); continue;
    }
    const invalid = item.orbit.state !== 'VALID' || !candidate.omm ? item.orbit.reason ?? 'Validated orbit elements are unavailable.' : orbitalFreshness(item.orbit.epoch, item.orbit.retrievedAt, serverNow, [input.representedAt]);
    if (invalid) { row.reason = row.positionReason = row.pathReason = invalid; objects.push(row); processed++; continue; }
    if (positionsUsed >= ORBITAL_LIMITS.positions) {
      row.positionAvailability = row.pathAvailability = 'DISPLAY_LIMITED'; row.reason = row.positionReason = row.pathReason = 'Not plotted — display limit.';
      objects.push(row); processed++; continue;
    }
    // Allocation concerns eligible identities, not stale/missing entries ranked ahead of them.
    let orbit: OrbitPropagator;
    try { orbit = (options.propagator ?? createPropagator)(candidate.omm!); }
    catch { row.reason = row.positionReason = row.pathReason = 'The supplied orbit could not be initialized.'; objects.push(row); processed++; continue; }
    const position = await evaluate(orbit, input.representedAt);
    if (!position) {
      row.positionAvailability = row.pathAvailability = 'INCOMPLETE'; row.reason = row.positionReason = row.pathReason = 'Not processed — the globe calculation reached its time limit.';
      objects.push(row); remaining++; continue;
    }
    if (!position.ok) { row.reason = row.positionReason = row.pathReason = position.reason; objects.push(row); processed++; continue; }
    row.position = point(position); row.positionAvailability = 'AVAILABLE'; positionsUsed++;
    if (pathsUsed >= ORBITAL_LIMITS.paths) { row.pathAvailability = 'DISPLAY_LIMITED'; row.pathReason = 'Path not plotted — display limit.'; objects.push(row); processed++; continue; }
    const represented = Date.parse(input.representedAt), epoch = Date.parse(item.orbit.epoch!), desiredStart = represented - ORBITAL_LIMITS.pathSeconds * 1000, desiredEnd = represented + ORBITAL_LIMITS.pathSeconds * 1000;
    const first = Math.max(desiredStart, epoch - ORBITAL_LIMITS.maxSpanMs), last = Math.min(desiredEnd, epoch + ORBITAL_LIMITS.maxSpanMs), times: number[] = [];
    for (let time = first; time <= last; time += ORBITAL_LIMITS.pathCadenceSeconds * 1000) times.push(time);
    if (times.at(-1) !== last) times.push(last);
    row.pathWindow = { start: new Date(first).toISOString(), end: new Date(last).toISOString(), stepSeconds: ORBITAL_LIMITS.pathCadenceSeconds, clippedStart: first !== desiredStart, clippedEnd: last !== desiredEnd };
    const segments: OrbitalPathPoint[][] = []; let segment: OrbitalPathPoint[] = [], incomplete = false, failures = 0;
    for (const time of times) {
      const at = new Date(time).toISOString(), value = await evaluate(orbit, at);
      if (!value) { incomplete = true; break; }
      if (!value.ok) { if (segment.length > 1) segments.push(segment); segment = []; failures++; }
      else segment.push({ at, ...point(value) });
    }
    if (segment.length > 1) segments.push(segment);
    if (incomplete) { row.pathAvailability = 'INCOMPLETE'; row.pathReason = 'Path incomplete — the globe calculation reached its time limit.'; remaining++; }
    else if (segments.length) { row.path = segments; row.pathAvailability = 'AVAILABLE'; pathsUsed++; row.pathReason = failures ? 'Unavailable propagation intervals are shown as gaps.' : first !== desiredStart || last !== desiredEnd ? 'Path clipped to the supported element span.' : null; processed++; }
    else { row.pathReason = 'No valid continuous path segment is available.'; processed++; }
    objects.push(row);
    if (objects.length % ORBITAL_LIMITS.browseChunkObjects === 0) { await yieldControl(); check(); }
  }
  check();
  return { snapshotVersion: snapshot.snapshotVersion, factVersion: snapshot.factVersion, representedAt: input.representedAt, generation: input.generation, serverNow,
    objects, validation: snapshot.validation,
    counts: { matching: snapshot.matching, positions: objects.filter(row => row.positionAvailability === 'AVAILABLE').length, paths: objects.filter(row => row.pathAvailability === 'AVAILABLE').length,
      displayLimited: objects.filter(row => row.positionAvailability === 'DISPLAY_LIMITED').length, pathsLimited: objects.filter(row => row.pathAvailability === 'DISPLAY_LIMITED').length,
      unavailable: objects.filter(row => row.positionAvailability === 'UNAVAILABLE').length, processed, remaining },
    state: remaining ? 'INCOMPLETE' : 'COMPLETE', message: remaining ? 'Display incomplete — its declared time limit was reached. Unprocessed objects are not missing orbit data.' : null };
}
interface CachedBrowse { key: string; owner: string; fingerprint: string; result: BrowseCalculation; expires: number }
function fingerprint(input: OrbitalBrowseInput): string {
  const { cursor: _cursor, ...value } = input;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** Bounded transient browse results; restart simply requires recomputing the same paused time. */
export function createBrowseService(db: Database, clock: Clock) {
  const active = new Map<string, AbortController>(), cache = new Map<string, CachedBrowse>();
  const prune = () => { const at = clock().getTime(); for (const [key, entry] of cache) if (entry.expires <= at) cache.delete(key); while (cache.size > 8) cache.delete(cache.keys().next().value!); };
  return {
    close() { for (const controller of active.values()) controller.abort(); active.clear(); cache.clear(); },
    async run(input: OrbitalBrowseInput, owner: string, signal: AbortSignal, reauthorize: () => void): Promise<OrbitalBrowsePage> {
      prune(); if (signal.aborted) throw aborted(); reauthorize(); const wanted = fingerprint(input); let entry: CachedBrowse, offset = 0;
      if (input.cursor) {
        const match = /^([A-Za-z0-9_-]{32})\.(\d{1,5})$/.exec(input.cursor), cached = match ? cache.get(match[1]!) : undefined;
        if (!cached || cached.owner !== owner || cached.fingerprint !== wanted) throw new ApiError(409, 'BROWSE_PAGE_CHANGED', 'This globe page belongs to different inputs or has expired. Retry the current view.');
        entry = cached; offset = Number(match![2]); if (offset > entry.result.objects.length) throw new ApiError(422, 'BROWSE_PAGE_CHANGED', 'That globe page is unavailable.');
        captureBrowseSnapshot(db, input); // Current source/fact version must still agree.
      } else {
        active.get(owner)?.abort(); const controller = new AbortController(); active.set(owner, controller);
        const cancel = () => controller.abort(); signal.addEventListener('abort', cancel, { once: true });
        try {
          const snapshot = captureBrowseSnapshot(db, input), serverNow = clock().toISOString();
          const result = await calculateBrowse(snapshot, input, serverNow, { signal: controller.signal });
          reauthorize(); captureBrowseSnapshot(db, input); if (active.get(owner) !== controller || controller.signal.aborted) throw aborted();
          entry = { key: randomBytes(24).toString('base64url'), owner, fingerprint: wanted, result, expires: clock().getTime() + 2 * 60 * 1000 }; cache.set(entry.key, entry); prune();
        } finally { signal.removeEventListener('abort', cancel); if (active.get(owner) === controller) active.delete(owner); }
      }
      if (signal.aborted) throw aborted(); reauthorize();
      const rows: OrbitalBrowseObject[] = [];
      for (let index = offset; index < entry.result.objects.length && rows.length < ORBITAL_LIMITS.browsePage; index++) {
        const row = entry.result.objects[index]!;
        if (Buffer.byteLength(JSON.stringify({ ...entry.result, objects: [...rows, row], nextCursor: `${entry.key}.${index + 1}` })) > ORBITAL_LIMITS.browseBytes) {
          if (!rows.length) throw new ApiError(503, 'BROWSE_OUTPUT_LIMIT', 'A globe record exceeds its declared display-output limit. List evidence remains available.');
          break;
        }
        rows.push(row);
      }
      const next = offset + rows.length;
      return { ...entry.result, objects: rows, nextCursor: next < entry.result.objects.length ? `${entry.key}.${next}` : null };
    },
  };
}
