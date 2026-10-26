import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AreaChoice } from '../shared/contracts.js';
import { PLACE_ATTRIBUTION, type PlaceCandidate, type PlaceLookupResult, type PlaceSourceReference, type PlaceSourceSnapshot } from '../shared/place-contracts.js';
import type { Database } from './db/database.js';
import type { AppConfig } from './config.js';
import { ApiError } from './errors.js';
import { bodyObject, guardContext, hash, requireSession, type Clock } from './security.js';

const MAX_BYTES = 256 * 1024, MIN_SPACING_MS = 1100, CACHE_MS = 7 * 86400000;
const DEFAULT_PROVIDER = 'https://nominatim.openstreetmap.org/search';
const APPLICATION_AGENT = 'CoruscantLocalDemo/0.1 (user-initiated educational place lookup)';
interface Cache { nextAllowedAt: number; entries: PlaceLookupResult[] }
export interface PlaceLookupOptions { provider?: string; userAgent?: string; fetcher?: typeof fetch }
const services = new WeakMap<Database, PlaceLookupService>();
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max: number): string | null { return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null; }
function coordinate(value: unknown, max: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value); return Number.isFinite(number) && Math.abs(number) <= max ? number : null;
}
export function normalizePlaceCandidates(value: unknown): Omit<PlaceCandidate, 'id'>[] {
  if (!Array.isArray(value) || value.length > 5) throw new Error('The place service returned an unsupported result list.');
  const result: Omit<PlaceCandidate, 'id'>[] = [], seen = new Set<string>();
  for (const raw of value) {
    if (!object(raw)) throw new Error('A place result is invalid.');
    const label = text(raw.display_name, 4000), latitude = coordinate(raw.lat, 90), longitude = coordinate(raw.lon, 180);
    if (!label || latitude === null || longitude === null) throw new Error('A place result has no valid label or coordinates.');
    const osmType = ['node', 'way', 'relation'].includes(String(raw.osm_type)) ? raw.osm_type as PlaceCandidate['osmType'] : null;
    const osmId = osmType && /^(?:0|[1-9]\d{0,19})$/.test(String(raw.osm_id)) ? String(raw.osm_id) : null;
    const key = osmType && osmId ? `${osmType}:${osmId}` : null;
    if (key && seen.has(key)) continue; if (key) seen.add(key);
    const address = object(raw.address) ? raw.address : {};
    let boundingBox: PlaceCandidate['boundingBox'] = null;
    if (Array.isArray(raw.boundingbox) && raw.boundingbox.length === 4) {
      const b = raw.boundingbox.map((v, i) => coordinate(v, i < 2 ? 90 : 180));
      if (b.every(v => v !== null) && b[0]! <= b[1]!) boundingBox = b as [number, number, number, number];
    }
    result.push({ label, latitude, longitude, osmType: osmId ? osmType : null, osmId,
      kind: text(raw.type, 100), country: text(address.country, 300), region: text(address.state ?? address.region ?? address.city, 300), boundingBox });
  }
  return result;
}
function safeProvider(input: string, test: boolean): string {
  const url = new URL(input);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(test && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('Place provider must be an identified HTTPS endpoint without embedded credentials.');
  return url.href;
}
function validCachedEntry(value: unknown, provider: string): value is PlaceLookupResult {
  if (!object(value) || value.provider !== provider || text(value.query, 200) !== value.query || !/^place:[a-f0-9]{64}$/.test(String(value.version)) || !Number.isFinite(Date.parse(String(value.retrievedAt))) || value.attribution !== PLACE_ATTRIBUTION || value.limit !== 5 || value.exhaustive !== false || !Array.isArray(value.candidates) || value.candidates.length > 5) return false;
  const candidates: Omit<PlaceCandidate, 'id'>[] = [];
  for (const [index, raw] of value.candidates.entries()) {
    if (!object(raw) || raw.id !== `${value.version}:${index}` || text(raw.label, 4000) !== raw.label || typeof raw.latitude !== 'number' || coordinate(raw.latitude, 90) === null || typeof raw.longitude !== 'number' || coordinate(raw.longitude, 180) === null) return false;
    if (!(raw.osmType === null && raw.osmId === null || ['node','way','relation'].includes(String(raw.osmType)) && /^(?:0|[1-9]\d{0,19})$/.test(String(raw.osmId)))) return false;
    for (const [key, max] of [['kind',100],['country',300],['region',300]] as const) if (raw[key] !== null && text(raw[key], max) !== raw[key]) return false;
    if (raw.boundingBox !== null && (!Array.isArray(raw.boundingBox) || raw.boundingBox.length !== 4 || raw.boundingBox.some((v, i) => typeof v !== 'number' || coordinate(v, i < 2 ? 90 : 180) === null) || raw.boundingBox[0] > raw.boundingBox[1])) return false;
    const { id: _id, ...candidate } = raw; candidates.push(candidate as unknown as Omit<PlaceCandidate, 'id'>);
  }
  return value.version === 'place:' + hash(JSON.stringify({ query: value.query, provider, retrievedAt: value.retrievedAt, candidates }));
}
export class PlaceLookupService {
  private cache: Cache = { nextAllowedAt: 0, entries: [] };
  private active: string | null = null;
  private readonly file: string;
  readonly provider: string;
  private readonly userAgent: string;
  private readonly fetcher: typeof fetch;
  constructor(config: Pick<AppConfig, 'dataRoot' | 'mode'>, private readonly clock: Clock, options: PlaceLookupOptions = {}) {
    this.file = resolve(config.dataRoot, 'place-cache', 'lookups.json');
    this.provider = safeProvider(options.provider ?? process.env.CORUSCANT_PLACE_PROVIDER_URL ?? DEFAULT_PROVIDER, config.mode === 'test');
    this.userAgent = options.userAgent ?? process.env.CORUSCANT_PLACE_USER_AGENT ?? APPLICATION_AGENT;
    if (!this.userAgent.trim() || this.userAgent.length > 300 || /[\r\n]/.test(this.userAgent)) throw new Error('Provide a valid identifying place-service User-Agent.');
    this.fetcher = options.fetcher ?? fetch;
    try {
      if (statSync(this.file).size > 32 * 1024 * 1024) throw new Error('Place cache exceeds its bound.');
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (object(data) && Number.isFinite(data.nextAllowedAt) && Number(data.nextAllowedAt) >= 0 && Array.isArray(data.entries) && data.entries.length <= 1000) {
        this.cache = { nextAllowedAt: Number(data.nextAllowedAt), entries: data.entries.filter((v): v is PlaceLookupResult => validCachedEntry(v, this.provider)) };
      }
    } catch { /* First use or unusable cache: no invented result. */ }
  }
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + '.pending';
    await writeFile(temporary, JSON.stringify(this.cache), { mode: 0o600 }); await rename(temporary, this.file);
  }
  async lookup(raw: unknown, context: string): Promise<PlaceLookupResult> {
    const query = text(raw, 200);
    if (!query || query.length < 2 || /[\p{Cc}]/u.test(query)) throw new ApiError(422, 'PLACE_PHRASE_REQUIRED', 'Enter a place phrase of2–200 printable characters. Do not enter a confidential location.');
    const now = this.clock().getTime();
    const cached = this.cache.entries.find(v => v.query.toLocaleLowerCase('en') === query.toLocaleLowerCase('en') && now >= Date.parse(v.retrievedAt) && now - Date.parse(v.retrievedAt) <= CACHE_MS);
    if (cached) return { ...cached, cached: true };
    if (this.active) throw new ApiError(429, 'PLACE_LOOKUP_PENDING', 'A place lookup is already pending. Keep your phrase and try again after it finishes.');
    if (now < this.cache.nextAllowedAt) throw new ApiError(429, 'PLACE_RATE_LIMIT', `Place lookup is cooling down. Try again after ${Math.ceil((this.cache.nextAllowedAt - now) / 1000)} seconds; manual targeting remains available.`, { retryAfter: String(Math.ceil((this.cache.nextAllowedAt - now) / 1000)) });
    this.active = context;
    this.cache.nextAllowedAt = now + MIN_SPACING_MS;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      await this.persist(); // Persist before the single attempt, so a restart cannot bypass spacing.
      const url = new URL(this.provider); url.searchParams.set('format', 'jsonv2'); url.searchParams.set('q', query); url.searchParams.set('limit', '5'); url.searchParams.set('addressdetails', '1'); url.searchParams.set('accept-language', 'en');
      const response = await this.fetcher(url, { method: 'GET', headers: { 'User-Agent': this.userAgent, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal, credentials: 'omit' });
      if (response.status !== 200) {
        const retry = response.headers.get('retry-after');
        const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : null;
        const date = retry && seconds === null ? Date.parse(retry) : NaN;
        this.cache.nextAllowedAt = Math.max(this.cache.nextAllowedAt, seconds !== null ? this.clock().getTime() + seconds * 1000 : Number.isFinite(date) ? date : 0);
        if (!Number.isFinite(this.cache.nextAllowedAt)) this.cache.nextAllowedAt = Number.MAX_SAFE_INTEGER;
        await this.persist();
        throw new ApiError(response.status === 429 ? 429 : 503, 'PLACE_PROVIDER_UNAVAILABLE', 'The place service declined this lookup. No automatic retry was made. Keep the phrase or use drawing/coordinates.', response.status === 429 ? { retryAfter: String(Math.max(1, Math.ceil((this.cache.nextAllowedAt - this.clock().getTime()) / 1000))) } : undefined);
      }
      if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES || !response.body) throw new Error('Place response is unavailable or too large.');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Place response exceeds the reviewed limit.'); } chunks.push(item.value); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const candidates = normalizePlaceCandidates(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      const retrievedAt = this.clock().toISOString(), version = 'place:' + hash(JSON.stringify({ query, provider: this.provider, retrievedAt, candidates }));
      const result: PlaceLookupResult = { version, query, retrievedAt, provider: this.provider, attribution: PLACE_ATTRIBUTION, candidates: candidates.map((v, i) => ({ ...v, id: `${version}:${i}` })), cached: false, limit: 5, exhaustive: false };
      this.cache.entries = [result, ...this.cache.entries.filter(v => this.clock().getTime() - Date.parse(v.retrievedAt) <= CACHE_MS)].slice(0, 1000);
      await this.persist(); return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'PLACE_LOOKUP_UNAVAILABLE', 'Place lookup did not complete. Your question and target are retained. Use drawing/coordinates or explicitly try again.');
    } finally { clearTimeout(timer); this.active = null; }
  }
  resolve(reference: unknown, area: AreaChoice, purpose: string): PlaceSourceSnapshot {
    if (!object(reference) || typeof reference.lookupVersion !== 'string' || typeof reference.candidateId !== 'string') throw new ApiError(422, 'PLACE_SOURCE_INVALID', 'Review the chosen source location.');
    const r = reference as unknown as PlaceSourceReference, entry = this.cache.entries.find(v => v.version === r.lookupVersion), candidate = entry?.candidates.find(v => v.id === r.candidateId);
    if (!entry || !candidate || this.clock().getTime() < Date.parse(entry.retrievedAt) || this.clock().getTime() - Date.parse(entry.retrievedAt) > CACHE_MS) throw new ApiError(409, 'PLACE_SOURCE_UNAVAILABLE', 'Lookup provenance is unavailable. Retain the coordinates and explicitly review them as manual, or choose a current source.');
    if (!['stated', 'manual'].includes(r.phraseOrigin) || typeof r.sourcePhrase !== 'string' || r.sourcePhrase.toLocaleLowerCase('en') !== entry.query.toLocaleLowerCase('en') || typeof r.questionAtLookup !== 'string' || r.questionAtLookup.length > 4000 || r.reviewedPurpose !== purpose || r.radiusAssumptionKm !== 25) throw new ApiError(422, 'PLACE_REVIEW_REQUIRED', 'Review this source location against the current mission purpose.');
    if (r.phraseOrigin === 'stated' && (!r.phraseSpan || !Number.isSafeInteger(r.phraseSpan.start) || !Number.isSafeInteger(r.phraseSpan.end) || r.phraseSpan.start < 0 || r.phraseSpan.end <= r.phraseSpan.start || r.phraseSpan.end > r.questionAtLookup.length || r.questionAtLookup.slice(r.phraseSpan.start, r.phraseSpan.end) !== r.sourcePhrase)) throw new ApiError(422, 'PLACE_PHRASE_CHANGED', 'The stated source phrase does not match the original local question. Review it as a manual place phrase.');
    return rebindPlaceSource({ lookupVersion: entry.version, candidateId: candidate.id, sourcePhrase: r.sourcePhrase, phraseOrigin: r.phraseOrigin, phraseSpan: r.phraseOrigin === 'stated' ? { start: r.phraseSpan!.start, end: r.phraseSpan!.end } : null,
      questionDigest: hash(r.questionAtLookup), reviewedPurposeDigest: hash(purpose), purposeAreaDigest: '', query: entry.query, label: candidate.label, provider: entry.provider, retrievedAt: entry.retrievedAt, attribution: entry.attribution,
      osmType: candidate.osmType, osmId: candidate.osmId, sourceCenter: { latitude: candidate.latitude, longitude: candidate.longitude }, appliedCenter: { latitude: area.latitude, longitude: area.longitude }, radiusAssumptionKm: 25, appliedRadiusKm: area.radiusKm, adjusted: false }, area, purpose);
  }
}
export function rebindPlaceSource(snapshot: PlaceSourceSnapshot, area: AreaChoice, purpose: string): PlaceSourceSnapshot {
  return { ...snapshot, reviewedPurposeDigest: hash(purpose), purposeAreaDigest: hash(JSON.stringify({ purpose, latitude: area.latitude, longitude: area.longitude, radiusKm: area.radiusKm, generation: area.generation })),
    appliedCenter: { latitude: area.latitude, longitude: area.longitude }, appliedRadiusKm: area.radiusKm,
    adjusted: area.latitude !== snapshot.sourceCenter.latitude || area.longitude !== snapshot.sourceCenter.longitude || area.radiusKm !== snapshot.radiusAssumptionKm };
}
export function resolvePlaceSource(db: Database, reference: unknown, area: AreaChoice, purpose: string): PlaceSourceSnapshot {
  const service = services.get(db); if (!service) throw new ApiError(503, 'PLACE_SOURCE_UNAVAILABLE', 'Place-source validation is unavailable; your brief is retained.');
  return service.resolve(reference, area, purpose);
}
export function registerPlaceLookup(app: FastifyInstance, clock: Clock, options: PlaceLookupOptions = {}): void {
  const { db, config } = app.coruscant;
  const service = new PlaceLookupService(config, clock, options); services.set(db, service);
  app.post('/api/place-lookups', async request => {
    const session = requireSession(db, request, clock); guardContext(session, request); const body = bodyObject(request);
    if (Object.keys(body).some(k => !['query', 'generation', 'contextGeneration', 'contextToken'].includes(k)) || !Number.isSafeInteger(body.generation) || Number(body.generation) < 0) throw new ApiError(422, 'PLACE_LOOKUP_INPUT', 'Use only a disclosed place phrase and its current generation for lookup.');
    const result = await service.lookup(body.query, session.cookie_hash + ':' + session.context_generation);
    const current = requireSession(db, request, clock); guardContext(current, request);
    return result;
  });
}
