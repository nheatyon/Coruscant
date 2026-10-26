import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWorkspace } from '../../scripts/smoke-workspace.js';
import { apiFixture } from './support.js';

test('workspace smoke distinguishes healthy protected routes, stale server and missing geometry without creating workflow or access', async () => {
  const f = await apiFixture();
  try {
    let missingMissions = false, missingReal = false, missingPlace = false, missingPlanning = false, missingRecheck = false;
    const read = (async (input, init) => {
      assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
      const url = new URL(String(input));
      if (missingPlace && url.pathname === '/api/place-lookups') return Response.json({code:'UNAVAILABLE'},{status:404});
      if (missingPlanning && url.pathname === '/api/orbital-assessments') return Response.json({code:'UNAVAILABLE'},{status:404});
      if (missingRecheck && url.pathname === '/api/orbital-assessments/recheck') return Response.json({code:'UNAVAILABLE'},{status:404});
      if (missingReal && url.pathname === '/api/public/real-catalog') return new Response(JSON.stringify({code:'UNAVAILABLE'}), {status:404,headers:{'content-type':'application/json'}});
      if (missingMissions && url.pathname.endsWith('/missions')) return new Response(JSON.stringify({ code: 'UNAVAILABLE' }), { status: 404, headers: { 'content-type': 'application/json' } });
      const reply = await f.app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: url.pathname, headers: { host: f.config.allowedHost, ...(init?.method === 'POST' ? {origin:f.config.origin,'content-type':'application/json'} : {}) }, ...(init?.method === 'POST' ? {payload:JSON.parse(String(init.body))} : {}) });
      assert.equal(reply.headers['set-cookie'], undefined);
      return new Response(reply.body, { status: reply.statusCode, headers: { 'content-type': String(reply.headers['content-type']) } });
    }) as typeof fetch;
    const before = (f.app.coruscant.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
    const healthy = await checkWorkspace(f.config.origin, read);
    assert.equal(healthy.authoredTracks, 3); assert.equal(healthy.d0, f.clock().toISOString());
    assert.equal(healthy.realCatalog.availability, 'UNAVAILABLE');
    missingPlace = true; await assert.rejects(checkWorkspace(f.config.origin, read), /place-lookups: expected an access-protected registered action; received 404/); missingPlace = false;
    missingPlanning = true; await assert.rejects(checkWorkspace(f.config.origin, read), /orbital-assessments: expected an access-protected registered action; received 404/); missingPlanning = false;
    missingRecheck = true; await assert.rejects(checkWorkspace(f.config.origin, read), /orbital-assessments\/recheck: expected an access-protected registered action; received 404/); missingRecheck = false;
    missingReal = true; await assert.rejects(checkWorkspace(f.config.origin, read), /real-catalog: expected 200, received 404/); missingReal = false;
    missingMissions = true; await assert.rejects(checkWorkspace(f.config.origin, read), /missions: expected 401, received 404.*Stop the existing listener/);
    missingMissions = false;
    f.app.coruscant.db.exec("DELETE FROM demo_metadata WHERE key='geometry_epoch'");
    await assert.rejects(checkWorkspace(f.config.origin, read), /geometry: expected 200, received 503/);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM service_requests').get() as { n: number }).n, 0);
    assert.equal((f.app.coruscant.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, before);
    let requested = false;
    await assert.rejects(checkWorkspace('https://example.com', (async () => { requested = true; throw new Error('must not fetch'); }) as typeof fetch), /configured http/);
    assert.equal(requested, false);
  } finally { await f.close(); }
});
