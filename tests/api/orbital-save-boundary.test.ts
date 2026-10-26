import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { apiFixture } from './support.js';
import { parseSourceBytes } from '../../server/orbital/catalog.js';
import { captureCatalog, ingestSources } from '../../server/orbital/repository.js';
import { interpretNeed } from '../../shared/discovery.js';
import { areaSignature, createEmptyBrief } from '../../shared/validation.js';
import { revisionToInput } from '../../shared/workflow.js';

function installDictionaryDouble(db: ReturnType<typeof import('../../server/db/database.js').openDatabase>) {
  // Fresh provider-response double for dictionary/version boundaries, not real numerical evidence.
  const source = parseSourceBytes('sar', Buffer.from(JSON.stringify([{
    NORAD_CAT_ID: 62261, OBJECT_ID: '2024-235A', OBJECT_NAME: 'Sentinel-1C — dictionary response double',
    EPOCH: '2026-10-21T11:00:00.123456', MEAN_MOTION: 14.6, ECCENTRICITY: .001,
    INCLINATION: 68, RA_OF_ASC_NODE: 30, ARG_OF_PERICENTER: 40, MEAN_ANOMALY: 50,
    BSTAR: 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0,
  }])), '2026-10-21T12:00:00.000Z');
  ingestSources(db, [{ source, rawFilename: `${source.responseHash}.json` }], '2026-10-21T12:00:00.000Z');
  return captureCatalog(db)!;
}
function basicBrief() {
  const area = { latitude: 0, longitude: 0, radiusKm: 25, method: 'coordinates' as const, generation: 1 };
  return { ...createEmptyBrief(), purpose: 'SAR imagery; operator: ESA.', sensor: 'SAR',
    latitude: '0', longitude: '0', areaChoice: area, areaConfirmation: areaSignature(area),
    baselineDate: '2026-10-01', recentDate: '2026-10-02', acknowledged: true,
    contact: { name: 'Original generated requester', email: 'intake@coruscant.example', organization: 'Original test team' } };
}

test('empty real shortlist uses its exact source dictionary and retains catalog context across review/save/revision input', async () => {
  const f = await apiFixture();
  try {
    const capture = installDictionaryDouble(f.app.coruscant.db), brief = basicBrief();
    const reading = interpretNeed({ text: brief.purpose, generation: 1, dictionary: capture.dictionary });
    assert.equal(reading.effective.operator, 'European Space Agency');
    const raw = { ...brief, discovery: { rulesVersion: reading.rulesVersion, generation: reading.generation, originalText: reading.originalText, manual: reading.manual },
      catalogContext: { sourceKind: 'PUBLIC_REAL' as const, snapshotVersion: capture.snapshotVersion, factVersion: capture.factVersion } };
    const command = { target: { organizationId: 'org-a' }, expected: {}, payload: { brief: raw } };
    const review = await f.owner.post('/api/command-reviews/submitRequest', command); assert.equal(review.statusCode, 200, review.body);
    assert.deepEqual(review.json().brief.selectedEvidence, []); assert.deepEqual(review.json().brief.catalogContext, raw.catalogContext);
    const saved = await f.owner.post('/api/commands/submitRequest', { ...command, commandId: randomUUID(), reviewToken: review.json().reviewToken });
    assert.equal(saved.statusCode, 201, saved.body);
    const request = await f.owner.state(saved.json().requestId);
    assert.deepEqual(request.evidence, []); assert.equal(request.brief.discovery?.effective.operator, 'European Space Agency');
    assert.deepEqual(revisionToInput(request.brief).catalogContext, raw.catalogContext);
    assert.deepEqual((await f.staff.state(request.id)).brief.catalogContext, raw.catalogContext);
  } finally { await f.close(); }
});

test('source-unavailable manual brief remains usable, while forged or mixed catalog context is refused without a request', async () => {
  const f = await apiFixture();
  try {
    const brief = { ...basicBrief(), purpose: 'SAR comparison for this deliberately chosen area.',
      catalogContext: { sourceKind: 'PUBLIC_REAL' as const, snapshotVersion: null, factVersion: null } };
    const command = { target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
    const review = await f.owner.post('/api/command-reviews/submitRequest', command); assert.equal(review.statusCode, 200, review.body);
    const bad = await f.owner.post('/api/command-reviews/submitRequest', { ...command, payload: { brief: { ...brief, selectedEvidence: [{ itemId: 'demo-sar-03', evidenceVersion: 'demo-evidence-v1' }] } } });
    assert.equal(bad.statusCode, 422, bad.body);
    const unknown = await f.owner.post('/api/command-reviews/submitRequest', { ...command, payload: { brief: { ...brief, catalogContext: { sourceKind: 'PUBLIC_REAL', snapshotVersion: 'a'.repeat(64), factVersion: 'unknown-fact' } } } });
    assert.equal(unknown.statusCode, 409, unknown.body);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as {n:number}).n, 0);
    const saved = await f.owner.post('/api/commands/submitRequest', { ...command, commandId: randomUUID(), reviewToken: review.json().reviewToken });
    assert.equal(saved.statusCode, 201, saved.body);
    const request = await f.owner.state(saved.json().requestId);
    assert.equal(request.matchingState, 'Automatic check unavailable'); assert.deepEqual(request.evidence, []);
    assert.equal(request.brief.purpose, brief.purpose); assert.equal(request.brief.area.latitude, 0);
  } finally { await f.close(); }
});

for (const mode of ['explicit demonstration', 'legacy absent context'] as const) {
  test(`${mode} cannot save a known real reference as verified provenance`, async () => {
    const f = await apiFixture();
    try {
      const capture = installDictionaryDouble(f.app.coruscant.db), item = capture.items[0]!;
      const brief = { ...basicBrief(), selectedEvidence: [{ itemId: item.id, evidenceVersion: item.evidenceVersion }],
        ...(mode === 'explicit demonstration' ? { catalogContext: { sourceKind: 'DEMONSTRATION' as const } } : {}) };
      const command = { target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
      const review = await f.owner.post('/api/command-reviews/submitRequest', command);
      assert.equal(review.statusCode, 422, review.body);
      assert.ok(review.json().fieldErrors?.selectedEvidence || review.json().fieldErrors?.catalogContext, review.body);
      // Exercise the mutation endpoint too: a fabricated token cannot bypass source validation.
      const save = await f.owner.post('/api/commands/submitRequest', { ...command, commandId: randomUUID(), reviewToken: 'not-a-reviewed-token' });
      assert.equal(save.statusCode, 422, save.body);
      for (const table of ['service_requests', 'brief_revisions', 'action_receipts']) {
        assert.equal((f.app.coruscant.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0,
          `${table}: rejected mixed-source input must create no request, saved evidence or success receipt`);
      }
      // Public immutable evidence remains available; refusal is about the brief's source boundary.
      assert.equal(captureCatalog(f.app.coruscant.db)!.items[0]!.evidenceVersion, item.evidenceVersion);
    } finally { await f.close(); }
  });
}

test('authorized unchanged real submission recovers its receipt before expired review or another evidence check', async () => {
  let checks = 0;
  const f = await apiFixture({ preliminaryCheck() { checks++; } });
  try {
    const capture = installDictionaryDouble(f.app.coruscant.db), item = capture.items[0]!;
    const brief = { ...basicBrief(), selectedEvidence: [{ itemId: item.id, evidenceVersion: item.evidenceVersion }],
      catalogContext: { sourceKind: 'PUBLIC_REAL' as const, snapshotVersion: capture.snapshotVersion, factVersion: capture.factVersion } };
    const command = { target: { organizationId: 'org-a' }, expected: {}, payload: { brief } };
    const review = await f.owner.post('/api/command-reviews/submitRequest', command); assert.equal(review.statusCode, 200, review.body);
    const envelope = { ...command, commandId: randomUUID(), reviewToken: review.json().reviewToken };
    const saved = await f.owner.post('/api/commands/submitRequest', envelope); assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(checks, 1);
    f.advance(10 * 60 * 1000); // The five-minute confirmation is now expired.
    const empty = parseSourceBytes('sar', Buffer.from('[]'), f.clock().toISOString());
    ingestSources(f.app.coruscant.db, [{ source: empty, rawFilename: `${empty.responseHash}.json` }], f.clock().toISOString());
    const replay = await f.owner.post('/api/commands/submitRequest', envelope);
    assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().outcome, 'replayed');
    assert.equal(replay.json().requestId, saved.json().requestId); assert.equal(checks, 1);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as { n: number }).n, 1);
    // Receipt recovery still requires current membership, even with the correct old action identity.
    f.app.coruscant.db.prepare('UPDATE memberships SET active=0 WHERE actor_id=? AND organization_id=?').run('a-owner', 'org-a');
    const denied = await f.owner.post('/api/commands/submitRequest', envelope);
    assert.ok([403, 404].includes(denied.statusCode), denied.body); assert.equal(checks, 1);
  } finally { await f.close(); }
});
