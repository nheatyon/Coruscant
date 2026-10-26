import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublicCatalog } from '../shared/contracts.js';
import type { RealCatalogPage } from '../shared/orbital-contracts.js';
import { GEOGRAPHIC_FRAME, GEOMETRY_METHOD, validateTrack, type DemoGeometry } from '../shared/globe.js';

/** Read-only contract smoke: no cookie, persona selection, session creation or workflow writes. */
export async function checkWorkspace(origin = 'http://127.0.0.1:3000', read: typeof fetch = fetch) {
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw new Error('Use only the configured http://127.0.0.1:PORT origin.');
  }
  const json = async (path: string, expected = 200) => {
    const response = await read(new URL(path, address), { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (response.status !== expected) throw new Error(`${path}: expected ${expected}, received ${response.status}. Stop the existing listener, rebuild, run db:migrate and non-destructive demo:init, then restart; do not reset .local.`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`${path}: JSON was expected; a static-page fallback is not a healthy API.`);
    const text = await response.text();
    if (text.length > 16 * 1024 * 1024) throw new Error(`${path}: response exceeded the bounded smoke-check size.`);
    return JSON.parse(text) as unknown;
  };
  const catalog = await json('/api/public/catalog') as PublicCatalog;
  const geometry = await json('/api/public/geometry') as DemoGeometry;
  if (!catalog.demo?.d0 || !Array.isArray(catalog.items) || geometry.epoch !== catalog.demo.d0 || geometry.frame !== GEOGRAPHIC_FRAME || geometry.method !== GEOMETRY_METHOD || !Array.isArray(geometry.tracks) || geometry.tracks.length !== 3 || geometry.tracks.some(track => !validateTrack(track).valid || !catalog.items.some(item => item.id === track.itemId))) {
    throw new Error('Catalog/held-D0 geometry definitions disagree or are incomplete. Run non-destructive demo:init after the build; preserve the existing D0 and saved work.');
  }
  const real = await json('/api/public/real-catalog') as RealCatalogPage;
  if (real.sourceKind !== 'PUBLIC_REAL' || !['READY','UNAVAILABLE'].includes(real.availability) || !Array.isArray(real.items) || real.items.length > 100 ||
    real.items.some(row => row.item.sourceKind !== 'PUBLIC_REAL' || row.item.demonstration || !/^norad:[1-9]\d{0,8}$/.test(row.item.id)) ||
    !Number.isSafeInteger(real.counts?.unique) || real.counts.unique < 0 || !Number.isSafeInteger(real.counts.matching) || real.counts.matching < real.items.length ||
    (real.availability === 'READY' && !real.snapshotVersion) || (real.availability === 'UNAVAILABLE' && (real.items.length || real.snapshotVersion))) {
    throw new Error('Real-catalog route returned an inconsistent source/page contract. Stop the older listener and rebuild; never substitute demonstration rows.');
  }
  // A denied command does not write. This catches an old server serving a newer
  // client whose new place/planning actions would otherwise return API-not-found.
  const protectedProbes:[string,Record<string,unknown>][]=[
    ['/api/place-lookups',{target:{organizationId:'org-a'},expected:{},payload:{}}],
    ['/api/command-reviews/savePlanningRequest',{target:{organizationId:'org-a'},expected:{},payload:{}}],
    ['/api/orbital-assessments',{}],['/api/orbital-assessments/status',{}],['/api/orbital-assessments/recheck',{}],['/api/orbital-assessments/cancel',{}],['/api/orbital-assessments/handoff',{}],
    ['/api/command-reviews/saveProposedPlan',{target:{organizationId:'org-a'},expected:{},payload:{brief:{},selection:{}}}],
  ];
  for (const [path,body] of protectedProbes) {
    const response = await read(new URL(path, address), { method: 'POST', body: JSON.stringify(body), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: address.origin } });
    const result = await response.json() as { code?: string };
    if (response.status !== 401 || result.code !== 'ACCESS_REQUIRED') throw new Error(`${path}: expected an access-protected registered action; received ${response.status}. Stop the existing listener, rebuild/migrate/init and restart without resetting data.`);
  }
  // An unauthenticated refusal proves route registration without reading or changing customer data.
  const missions = await json('/api/customer/org-a/missions', 401) as { code?: string };
  if (missions.code !== 'ACCESS_REQUIRED') throw new Error('The Missions route did not enforce the expected access boundary.');
  return { d0: catalog.demo.d0, baselineDate: catalog.demo.baselineDate, recentDate: catalog.demo.recentDate, authoredTracks: geometry.tracks.length, realCatalog: { availability: real.availability, unique: real.counts.unique, snapshotVersion: real.snapshotVersion }, missions: 'registered and access-protected' as const };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log('PASS existing-workspace read-only smoke', await checkWorkspace(process.argv[2])); }
  catch (failure) { console.error(failure instanceof Error ? failure.message : 'Workspace smoke check failed.'); process.exitCode = 1; }
}
