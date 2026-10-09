process.env.DB_PATH = ':memory:';

const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements, insertSolarSnapshot } = require('../../src/db/queries');
const { createApp } = require('../../hamdata/app');
const { createLookupBroker } = require('../../hamdata/broker');
const { createHamdataClient } = require('../../src/hamdata/client');

let server;
let base;
const env = { HAMDATA_TOKEN: 'sekrit' };
const upstream = [];

before(async () => {
  initDb();
  const rows = new Map();
  const broker = createLookupBroker({
    client: { lookup: async (c) => { upstream.push(c); return { call: c, found: c !== 'X1XX', grid: 'EN52' }; } },
    getCached: (c) => rows.get(c),
    cache: (c, d, s) => rows.set(c, { call: c, data: JSON.stringify(d), source: s, cached_at: '2999-01-01 00:00:00' }),
    betweenMs: 0,
  });
  insertSolarSnapshot({ sfi: 100, a: 5, k: 1, sunspots: 50, xray: 'B1', geomag: 'QUIET', fetched_at: '2026-10-01 00:00:00' });
  insertSolarSnapshot({ sfi: 110, a: 7, k: 2, sunspots: 60, xray: 'B2', geomag: 'QUIET', fetched_at: '2026-10-01 02:00:00' });
  server = http.createServer(createApp({ broker, solar: { enabled: true }, env }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  resetStatements();
  closeDb();
});

describe('hamdata API', () => {
  it('GET /health reports ok with lookup + solar blocks', async () => {
    const body = await (await fetch(`${base}/health`)).json();
    assert.equal(body.status, 'ok');
    assert.equal(body.lookup.enabled, true);
    assert.equal(body.solar.updated, '2026-10-01 02:00:00');
  });

  it('GET /solar/since pages full rows oldest-first after a timestamp', async () => {
    const all = await (await fetch(`${base}/solar/since?after=`)).json();
    assert.deepEqual(all.map((r) => r.sfi), [100, 110]);
    assert.equal(all[0].xray, 'B1');
    const newer = await (await fetch(`${base}/solar/since?after=2026-10-01%2000:00:00`)).json();
    assert.deepEqual(newer.map((r) => r.sfi), [110]);
  });

  it('GET /lookup/:call strips portable suffixes and rejects junk', async () => {
    const rec = await (await fetch(`${base}/lookup/k9ct%2Fp`)).json();
    assert.equal(rec.call, 'K9CT');
    assert.equal(rec.source, 'hamqth');
    assert.equal((await fetch(`${base}/lookup/a%3Bb`)).status, 400);
  });

  it('pause/resume need the token and fail closed without one', async () => {
    assert.equal((await fetch(`${base}/lookup/pause`, { method: 'POST' })).status, 401);
    const ok = await fetch(`${base}/lookup/pause`, { method: 'POST', headers: { Authorization: 'Bearer sekrit' } });
    assert.equal((await ok.json()).paused, true);
    assert.equal((await fetch(`${base}/lookup/NEW1CALL`)).status, 503);
    await fetch(`${base}/lookup/resume`, { method: 'POST', headers: { Authorization: 'Bearer sekrit' } });

    delete env.HAMDATA_TOKEN;
    assert.equal((await fetch(`${base}/lookup/pause`, { method: 'POST' })).status, 503);
    env.HAMDATA_TOKEN = 'sekrit';
  });

  it('works end to end through the contestscore-side client', async () => {
    const client = createHamdataClient({ url: base });
    const rec = await client.lookup('X1XX');
    assert.equal(rec.found, false);
    assert.equal(rec.source, 'hamqth');
    assert.equal((await client.solarSince('')).length, 2);
  });
});
