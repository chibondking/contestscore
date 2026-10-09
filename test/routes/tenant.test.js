process.env.DB_PATH = ':memory:';

const http = require('node:http');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements } = require('../../src/db/queries');
const { getTenant } = require('../../src/tenant');
const { insertSolarSnapshot, cacheCallsign, getCachedCallsign } = require('../../src/db/queries');
const { getDb } = require('../../src/db/index');

let server;
let base;

before(async () => {
  initDb();
  const app = require('../../src/app');
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  resetStatements();
  closeDb();
});

afterEach(() => {
  delete process.env.CONTESTSCORE_TENANT;
  delete process.env.CONTESTSCORE_TENANT_NAME;
  delete process.env.CONTESTSCORE_API_TOKEN;
});

describe('getTenant', () => {
  it('is null when unset', () => assert.equal(getTenant({}), null));
  it('upper-cases the call and defaults the name to it', () => {
    assert.deepEqual(getTenant({ CONTESTSCORE_TENANT: 'k9ct' }), { call: 'K9CT', name: 'K9CT' });
  });
  it('uses CONTESTSCORE_TENANT_NAME when given', () => {
    assert.equal(getTenant({ CONTESTSCORE_TENANT: 'nw8s', CONTESTSCORE_TENANT_NAME: ' NW8S Club ' }).name, 'NW8S Club');
  });
  it('rejects anything that is not 3-10 letters/digits', () => {
    for (const bad of ['k9', 'k9ct/p', '../etc', 'a'.repeat(11)]) {
      assert.throws(() => getTenant({ CONTESTSCORE_TENANT: bad }), /callsign-like/);
    }
  });
});

describe('tenant mode routes', () => {
  const auth = { Authorization: 'Bearer club-token', 'X-Confirm': 'yes' };

  it('the Admin page is available to a hosted club', async () => {
    process.env.CONTESTSCORE_TENANT = 'k9ct';
    process.env.CONTESTSCORE_API_TOKEN = 'club-token';
    assert.equal((await fetch(`${base}/admin.html`)).status, 200);
    assert.equal((await fetch(`${base}/js/admin.js`)).status, 200);
  });

  it('every admin action needs the club token', async () => {
    process.env.CONTESTSCORE_TENANT = 'k9ct';
    process.env.CONTESTSCORE_API_TOKEN = 'club-token';
    for (const [method, p] of [['DELETE', '/api/db'], ['POST', '/api/lookup/pause'], ['POST', '/api/lookup/resume'], ['DELETE', '/api/lookup/cache']]) {
      const res = await fetch(`${base}${p}`, { method, headers: { 'X-Confirm': 'yes' } });
      assert.equal(res.status, 401, `${method} ${p} without token`);
    }
    assert.equal((await fetch(`${base}/api/db`, { method: 'DELETE', headers: auth })).status, 200);
  });

  it('a reset and a cache clear never touch solar data; the reset keeps the cache', async () => {
    process.env.CONTESTSCORE_TENANT = 'k9ct';
    process.env.CONTESTSCORE_API_TOKEN = 'club-token';
    insertSolarSnapshot({ sfi: 111, a: 4, k: 1 });
    cacheCallsign('W1AW', { call: 'W1AW', found: true }, 'hamqth');
    const solar = () => getDb().prepare('SELECT COUNT(*) c FROM solar_snapshots').get().c;
    const before = solar();
    await fetch(`${base}/api/db`, { method: 'DELETE', headers: auth });
    assert.ok(getCachedCallsign('W1AW'), 'reset cleared the callsign cache');
    const res = await fetch(`${base}/api/lookup/cache`, { method: 'DELETE', headers: auth });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).cleared >= 1);
    assert.equal(getCachedCallsign('W1AW'), undefined);
    assert.equal(solar(), before);
  });

  it('clearing the cache needs X-Confirm', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'club-token';
    const res = await fetch(`${base}/api/lookup/cache`, { method: 'DELETE', headers: { Authorization: 'Bearer club-token' } });
    assert.equal(res.status, 400);
  });

  it('read routes and pages are unchanged', async () => {
    process.env.CONTESTSCORE_TENANT = 'k9ct';
    for (const p of ['/', '/stats.html', '/charts.html', '/api/qsos', '/api/score', '/api/solar', '/api/health', '/api/lookup/status']) {
      const res = await fetch(`${base}${p}`);
      assert.ok(res.status === 200 || res.status === 503, `${p} -> ${res.status}`);
    }
  });

  it('the analyzer stays on, gated by the tenant token', async () => {
    process.env.CONTESTSCORE_TENANT = 'k9ct';
    process.env.CONTESTSCORE_API_TOKEN = 'club-token';
    const res = await fetch(`${base}/api/analyze`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 401);
  });

  it('/api/features names the tenant, and is null standalone', async () => {
    assert.equal((await (await fetch(`${base}/api/features`)).json()).tenant, null);
    process.env.CONTESTSCORE_TENANT = 'nw8s';
    process.env.CONTESTSCORE_TENANT_NAME = 'NW8S Club';
    assert.deepEqual((await (await fetch(`${base}/api/features`)).json()).tenant, { call: 'NW8S', name: 'NW8S Club' });
  });
});

describe('server startup in tenant mode', () => {
  const run = (env) => spawnSync(process.execPath, [path.join(__dirname, '../../src/server.js')], {
    env: { PATH: process.env.PATH, DB_PATH: ':memory:', HTTP_PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 5000,
  });

  it('refuses to start without a token (it guards the admin actions)', () => {
    const r = run({ CONTESTSCORE_TENANT: 'k9ct', HAMDATA_URL: 'http://127.0.0.1:1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /CONTESTSCORE_API_TOKEN is required/);
  });

  it('refuses to start without HAMDATA_URL', () => {
    const r = run({ CONTESTSCORE_TENANT: 'k9ct', CONTESTSCORE_API_TOKEN: 't' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /HAMDATA_URL is required/);
  });

  it('refuses a malformed tenant id', () => {
    const r = run({ CONTESTSCORE_TENANT: '../x', HAMDATA_URL: 'http://127.0.0.1:1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /callsign-like/);
  });
});
