// Uses an in-memory SQLite DB so no files are created.
process.env.DB_PATH = ':memory:';

const http = require('node:http');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements, insertScoreBreakdown, upsertRadio } = require('../../src/db/queries');

let server;
let baseUrl;

before(async () => {
  initDb();
  // Fresh require so CONTESTSCORE_API_TOKEN changes between tests take
  // effect (the router reads it per-request, but app.js is only wired once).
  const app = require('../../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  resetStatements();
  closeDb();
});

beforeEach(() => { delete process.env.CONTESTSCORE_API_TOKEN; });
afterEach(() => { delete process.env.CONTESTSCORE_API_TOKEN; });

describe('DELETE /api/db', () => {
  it('with no token configured, X-Confirm alone is sufficient (LAN-only behavior)', async () => {
    const res = await fetch(`${baseUrl}/api/db`, {
      method: 'DELETE',
      headers: { 'X-Confirm': 'yes' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.cleared, true);
  });

  it('with no token configured, missing X-Confirm is still rejected', async () => {
    const res = await fetch(`${baseUrl}/api/db`, { method: 'DELETE' });
    assert.equal(res.status, 400);
  });

  it('with a token configured, a request without it is rejected before X-Confirm is even checked', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/db`, {
      method: 'DELETE',
      // Deliberately omit X-Confirm too, to prove auth is checked first.
    });
    assert.equal(res.status, 401);
  });

  it('with a token configured, the wrong token is rejected', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/db`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer wrong', 'X-Confirm': 'yes' },
    });
    assert.equal(res.status, 401);
  });

  it('with a token configured, the right token plus X-Confirm succeeds', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/db`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer secret123', 'X-Confirm': 'yes' },
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/score', () => {
  it('aliases the raw score_total column as `total`, matching the socket score:update payload shape', async () => {
    insertScoreBreakdown({
      contest: 'CQ-WW-CW', call: 'WT2P', grid6: 'EN81LM', score_total: 1600,
      breakdown: [{ band: 'ALL', mode: 'ALL', qsos: 40, points: 40, mults: 40, is_total: 1 }],
    });
    const res = await fetch(`${baseUrl}/api/score`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1600);
    assert.equal(body.score_total, 1600);
    assert.equal(body.grid6, 'EN81LM');
  });
});

describe('GET /api/radios', () => {
  it('never returns the exact freq/tx_freq -- only the derived band', async () => {
    upsertRadio({
      station_name: 'WT2P-1', radio_nr: 1, freq: '14025000', tx_freq: '14025000',
      mode: 'CW', op_call: 'WT2P', is_running: 1,
      focus_entry: null, antenna: '', rotator: '', focus_radio: null,
    });
    const res = await fetch(`${baseUrl}/api/radios`);
    assert.equal(res.status, 200);
    const [radio] = await res.json();
    assert.equal(radio.freq, undefined);
    assert.equal(radio.tx_freq, undefined);
    assert.equal(radio.band, '20m');
  });
});

describe('GET /api/version', () => {
  it('is public (no token required) and returns a deployedAt timestamp', async () => {
    const res = await fetch(`${baseUrl}/api/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.deployedAt);
    assert.ok(!Number.isNaN(Date.parse(body.deployedAt)));
  });
});
