// Newly authored provider-response doubles used only by the isolated browser server.
// No request from this fetcher reaches Nominatim or any external host.
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
export const placeFixtureProvider = 'https://place-fixture.coruscant.invalid/search';
const candidate = (display_name, lat, lon, osm_id, address = {}) => ({ display_name, lat: String(lat), lon: String(lon), osm_type: 'relation', osm_id, type: 'test-place', address });
const responses = new Map([
  ['Busan Harbor', [candidate('Busan Harbor — generated provider-response test place', 35.1017, 129.0407, 900001, { country: 'South Korea', city: 'Busan' })]],
  ['Dublin', [candidate('Dublin — generated provider-response test place', 53.3498, -6.2603, 900002, { country: 'Ireland', city: 'Dublin' })]],
  ['Springfield', [candidate('Springfield North — generated provider-response test place', 42.1, -72.6, 900003, { country: 'Test country', region: 'North' }), candidate('Springfield South — generated provider-response test place', 37.2, -93.3, 900004, { country: 'Test country', region: 'South' })]],
]);
export function placeFixtureFetcher(dataRoot) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== new URL(placeFixtureProvider).origin) throw new Error('The place fixture refuses external requests.');
    const query = url.searchParams.get('q');
    await appendFile(join(dataRoot, 'place-fixture-requests.jsonl'), JSON.stringify({ query, keys: [...url.searchParams.keys()], userAgent: new Headers(options.headers).get('user-agent'), authorization: new Headers(options.headers).get('authorization'), cookie: new Headers(options.headers).get('cookie') }) + '\n', { mode: 0o600 });
    if (query === 'Unavailable Test Place') return new Response('Unavailable test fixture', { status: 503 });
    if (query === 'Rate Limited Test Place') return new Response('Rate limited test fixture', { status: 429, headers: { 'Retry-After': '2' } });
    if (query === 'Timeout Test Place') return new Promise((_, reject) => { options.signal?.addEventListener('abort', () => reject(new Error('Fixture timeout')), { once: true }); });
    return Response.json(responses.get(query) ?? []);
  };
}
