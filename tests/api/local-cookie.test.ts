import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoCookieName } from '../../server/security.js';
import { apiFixture } from './support.js';

test('isolated test ports cannot replace or consume the recording browser cookie', async () => {
  assert.equal(demoCookieName({ mode: 'demo', port: 3000 }), 'coruscant_demo');
  assert.equal(demoCookieName({ mode: 'test', port: 3100 }), 'coruscant_demo_test_3100');
  assert.notEqual(demoCookieName({ mode: 'test', port: 3100 }), demoCookieName({ mode: 'test', port: 3101 }));
  const f = await apiFixture();
  try {
    assert.match(f.owner.cookie, /^coruscant_demo_test_3103=/);
    const value = f.owner.cookie.slice(f.owner.cookie.indexOf('=') + 1);
    const ignored = await f.app.inject({ method: 'GET', url: '/api/context', headers: { host: f.config.allowedHost, cookie: `coruscant_demo=${value}` } });
    assert.equal(ignored.json().audience, 'PUBLIC');
    const together = await f.app.inject({ method: 'GET', url: '/api/context', headers: { host: f.config.allowedHost, cookie: `coruscant_demo=untouched-recording-context; ${f.owner.cookie}` } });
    assert.equal(together.json().actor.id, 'a-owner');
    const headers = f.owner.headers();
    const left = await f.owner.post('/api/demo/leave', {});
    assert.equal(left.statusCode, 200); assert.match(left.headers['set-cookie'] as string, /^coruscant_demo_test_3103=; .*Max-Age=0/);
    assert.ok(!String(left.headers['set-cookie']).startsWith('coruscant_demo='));
    const duplicate = await f.app.inject({ method: 'GET', url: '/api/context', headers: { ...headers, cookie: `${f.staff.cookie}; ${f.staff.cookie}` } });
    assert.equal(duplicate.json().audience, 'PUBLIC');
  } finally { await f.close(); }
});
