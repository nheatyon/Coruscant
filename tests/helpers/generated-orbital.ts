import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../server/config.js';
import { openDatabase, transaction } from '../../server/db/database.js';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import { ingestSources, orbitalRoot } from '../../server/orbital/repository.js';

/** Newly authored provider-response doubles, only in the isolated browser-test process.
 * These are NOT acquired CelesTrak records or numerical reference data. No successful
 * workflow/approval/access/delivery/observation is seeded. Actual-source evidence is
 * separately measured against the private, freshly acquired response hashes.
 */
export function installGeneratedOrbitalCatalog(config: AppConfig): void {
  if (config.mode !== 'test') throw new Error('Generated provider doubles require an isolated test data root.');
  const at = new Date().toISOString(), epoch = new Date(Date.parse(at) - 60 * 60 * 1000).toISOString();
  const row = (id: number) => ({
    NORAD_CAT_ID: id, OBJECT_NAME: `Generated provider-response test object ${id}`,
    OBJECT_ID: '', EPOCH: epoch, MEAN_MOTION: 14.6, ECCENTRICITY: .001,
    INCLINATION: 63, RA_OF_ASC_NODE: id % 360, ARG_OF_PERICENTER: 41, MEAN_ANOMALY: id % 360,
    EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', ELEMENT_SET_NO: 1, REV_AT_EPOCH: 1,
    BSTAR: .00001, MEAN_MOTION_DOT: .000001, MEAN_MOTION_DDOT: 0,
  });
  const sar = Array.from({ length: 230 }, (_, i) => row(100001 + i));
  const resource = Array.from({ length: 80 }, (_, i) => row(100201 + i));
  // Explicitly synthetic elements for exercising primary-fact joins, not reference predictions.
  sar.push({ ...row(62261), OBJECT_NAME: 'SENTINEL-1C — generated response double', OBJECT_ID: '2024-235A' });
  sar.push({ ...row(66315), OBJECT_NAME: 'SENTINEL-1D — generated response double', OBJECT_ID: '2025-251A' });
  resource.push(row(123456789));
  resource[78] = { ...resource[78]!, MEAN_MOTION: -1 }; // identity remains; invalid orbit is explicit
  resource[79] = { ...resource[79]!, EPOCH: new Date(Date.parse(at) - 72 * 60 * 60 * 1000).toISOString() };
  const root = orbitalRoot(config); mkdirSync(root, { recursive: true, mode: 0o700 });
  const entries = ([['sar', sar], ['resource', resource]] as const).map(([group, rows]) => {
    const bytes = Buffer.from(JSON.stringify(rows)), source = parseSourceBytes(group, bytes, at), rawFilename = `${source.responseHash}.json`;
    writeFileSync(join(root, rawFilename), bytes, { mode: 0o600 }); return { source, rawFilename };
  });
  const db = openDatabase(config);
  try {
    ingestSources(db, entries, at);
    // Prevent any test click from contacting the real provider. Refresh transport behavior
    // is separately verified with injected, newly authored responses in API tests.
    transaction(db, () => {
      for (const group of ['sar', 'resource']) db.prepare('UPDATE orbital_source_state SET attempted_at=?,next_allowed_at=? WHERE source_key=?')
        .run(at, new Date(Date.parse(at) + 2 * 60 * 60 * 1000).toISOString(), group);
    });
  } finally { db.close(); }
}
