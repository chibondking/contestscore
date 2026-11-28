// Cache sync between boxes: /lookup/export pages the shared cache after a
// (cached_at, call) cursor, /lookup/import merges another box's rows
// (newer cached_at wins). Real SQLite (in memory), real HTTP.
process.env.DB_PATH = ':memory:';

const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb, getDb } = require('../../src/db/index');
const { resetStatements, getCachedCallsign } = require('../../src/db/queries');
const { createApp, validImportRow } = require('../../hamdata/app');

let server;
let base;
const NOW = Date.parse('2026-11-28T03:00:00Z');
const env = { HAMDATA_TOKEN: 'sekrit' };
const broker = { getStatus: () => ({}) };

function put(call, data, cachedAt, source = 'hamqth') {
  getDb().prepare('INSERT OR REPLACE INTO callsign_cache (call, data, source, cached_at) VALUES (?, ?, ?, ?)')
    .run(call, JSON.stringify(data), source, cachedAt);
}

async function importRows(rows, token = 'sekrit') {
  const res = await fetch(`${base}/lookup/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ rows }),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  initDb();
  server = http.createServer(createApp({ broker, solar: null, env, now: () => NOW }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  resetStatements();
  closeDb();
});

describe('hamdata cache export', () => {
  it('pages oldest-first and resumes after the cursor, even inside one second', async () => {
    put('K9CT', { found: true, grid: 'EN50' }, '2026-11-27 10:00:00');
    put('AA1AA', { found: true }, '2026-11-27 11:00:00');
    put('BB1BB', { found: false }, '2026-11-27 11:00:00');
    put('CC1CC', { found: true }, '2026-11-27 12:00:00');

    const p1 = await (await fetch(`${base}/lookup/export?limit=2`)).json();
    assert.deepEqual(p1.rows.map((r) => r.call), ['K9CT', 'AA1AA']);
    assert.equal(p1.more, true);
    assert.deepEqual(p1.next, { ts: '2026-11-27 11:00:00', call: 'AA1AA' });
    assert.equal(p1.cache.total, 4);

    const q = new URLSearchParams({ after_ts: p1.next.ts, after_call: p1.next.call, limit: '2' });
    const p2 = await (await fetch(`${base}/lookup/export?${q}`)).json();
    assert.deepEqual(p2.rows.map((r) => r.call), ['BB1BB', 'CC1CC']);
    assert.equal(p2.more, false);
    assert.equal(p2.rows[0].data, JSON.stringify({ found: false }));

    const q3 = new URLSearchParams({ after_ts: p2.next.ts, after_call: p2.next.call });
    assert.deepEqual((await (await fetch(`${base}/lookup/export?${q3}`)).json()).rows, []);
  });

  it('rejects a malformed cursor', async () => {
    assert.equal((await fetch(`${base}/lookup/export?after_ts=yesterday`)).status, 400);
    assert.equal((await fetch(`${base}/lookup/export?after_ts=2026-11-27%2010:00:00&after_call=a;b`)).status, 400);
  });
});

describe('hamdata cache import', () => {
  it('needs the token', async () => {
    assert.equal((await importRows([], 'nope')).status, 401);
  });

  it('newer wins, older loses, keeps the original cached_at', async () => {
    const r = await importRows([
      { call: 'K9CT', source: 'hamqth', cached_at: '2026-11-27 13:00:00', data: JSON.stringify({ found: true, grid: 'EN52' }) },
      { call: 'CC1CC', source: 'hamqth', cached_at: '2026-11-01 00:00:00', data: JSON.stringify({ found: false }) },
      { call: 'DD1DD', source: 'hamqth', cached_at: '2026-11-20 08:00:00', data: JSON.stringify({ found: true }) },
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.received, r.body.applied, r.body.rejected], [3, 2, 0]);
    assert.equal(JSON.parse(getCachedCallsign('K9CT').data).grid, 'EN52');
    assert.equal(getCachedCallsign('K9CT').cached_at, '2026-11-27 13:00:00');
    assert.equal(JSON.parse(getCachedCallsign('CC1CC').data).found, true); // older import lost
    assert.equal(getCachedCallsign('DD1DD').cached_at, '2026-11-20 08:00:00'); // TTL stays honest
  });

  it('same age: found beats not-found, never the other way', async () => {
    const r = await importRows([
      { call: 'BB1BB', source: 'hamqth', cached_at: '2026-11-27 11:00:00', data: JSON.stringify({ found: true }) },
      { call: 'AA1AA', source: 'hamqth', cached_at: '2026-11-27 11:00:00', data: JSON.stringify({ found: false }) },
    ]);
    assert.equal(r.body.applied, 1);
    assert.equal(JSON.parse(getCachedCallsign('BB1BB').data).found, true);
    assert.equal(JSON.parse(getCachedCallsign('AA1AA').data).found, true);
  });

  it('re-importing the same rows changes nothing', async () => {
    const rows = [{ call: 'DD1DD', source: 'hamqth', cached_at: '2026-11-20 08:00:00', data: JSON.stringify({ found: true }) }];
    assert.equal((await importRows(rows)).body.applied, 0);
  });

  it('skips rows that are not ones hamdata would write', async () => {
    const r = await importRows([
      { call: 'k9ct', source: 'hamqth', cached_at: '2026-11-27 14:00:00', data: '{}' },
      { call: 'EE1EE', source: 'Ham QTH', cached_at: '2026-11-27 14:00:00', data: '{}' },
      { call: 'EE1EE', source: 'hamqth', cached_at: '2026-11-29 00:00:00', data: '{}' }, // future
      { call: 'EE1EE', source: 'hamqth', cached_at: '2026-11-27T14:00:00Z', data: '{}' },
      { call: 'EE1EE', source: 'hamqth', cached_at: '2026-11-27 14:00:00', data: '[1]' },
      { call: 'EE1EE', source: 'hamqth', cached_at: '2026-11-27 14:00:00', data: 'x'.repeat(5000) },
      null,
    ]);
    assert.deepEqual([r.body.applied, r.body.rejected], [0, 7]);
    assert.equal(getCachedCallsign('EE1EE'), undefined);
  });

  it('caps one import', async () => {
    const rows = Array.from({ length: 1001 }, () => ({}));
    assert.equal((await importRows(rows)).status, 413);
  });

  it('validImportRow allows a small clock skew, not a big one', () => {
    const row = (ts) => ({ call: 'K9CT', source: 'hamqth', cached_at: ts, data: '{}' });
    assert.ok(validImportRow(row('2026-11-28 03:05:00'), NOW));
    assert.equal(validImportRow(row('2026-11-28 03:30:00'), NOW), null);
  });
});
