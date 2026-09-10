// Uses an in-memory SQLite DB so no files are created.
process.env.DB_PATH = ':memory:';

const http = require('node:http');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const {
  resetStatements, insertScoreBreakdown, upsertRadio, upsertQso, cacheCallsign, clearQsos,
  insertSolarSnapshot,
} = require('../../src/db/queries');

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

describe('GET /api/features', () => {
  afterEach(() => {
    delete process.env.LOOKUP_PROVIDER;
    delete process.env.HAMQTH_USERNAME;
    delete process.env.HAMQTH_PASSWORD;
  });

  it('reports lookup disabled by default, solar enabled', async () => {
    const res = await fetch(`${baseUrl}/api/features`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.lookup, { provider: 'none', enabled: false });
    assert.deepEqual(body.solar, { enabled: true });
  });

  it('reflects SOLAR_ENABLED=false', async () => {
    process.env.SOLAR_ENABLED = 'false';
    const body = await (await fetch(`${baseUrl}/api/features`)).json();
    assert.deepEqual(body.solar, { enabled: false });
    delete process.env.SOLAR_ENABLED;
  });

  it('reports hamqth once a provider + credentials are configured', async () => {
    process.env.LOOKUP_PROVIDER = 'hamqth';
    process.env.HAMQTH_USERNAME = 'W1AW';
    process.env.HAMQTH_PASSWORD = 'x';
    const body = await (await fetch(`${baseUrl}/api/features`)).json();
    assert.deepEqual(body.lookup, { provider: 'hamqth', enabled: true });
  });

  it('a provider without credentials stays disabled', async () => {
    process.env.LOOKUP_PROVIDER = 'hamqth';
    const body = await (await fetch(`${baseUrl}/api/features`)).json();
    assert.deepEqual(body.lookup, { provider: 'none', enabled: false });
  });
});

describe('GET /api/busts', () => {
  const enableLookup = () => {
    process.env.LOOKUP_PROVIDER = 'hamqth';
    process.env.HAMQTH_USERNAME = 'W1AW';
    process.env.HAMQTH_PASSWORD = 'x';
  };

  beforeEach(() => { clearQsos(); });
  afterEach(() => {
    clearQsos();
    delete process.env.LOOKUP_PROVIDER;
    delete process.env.HAMQTH_USERNAME;
    delete process.env.HAMQTH_PASSWORD;
  });

  it('is disabled (and empty) when lookup is off', async () => {
    const body = await (await fetch(`${baseUrl}/api/busts`)).json();
    assert.deepEqual(body, { enabled: false, busts: [] });
  });

  it('lists logged QSOs whose base call HamQTH did not find', async () => {
    enableLookup();
    cacheCallsign('WT2ZZZ', { call: 'WT2ZZZ', source: 'hamqth', found: false }, 'hamqth');
    cacheCallsign('W1AW', { call: 'W1AW', source: 'hamqth', found: true }, 'hamqth');
    upsertQso({ ext_id: 'a', call: 'WT2ZZZ', band: '20', mode: 'CW', operator: 'WT2P' });
    upsertQso({ ext_id: 'b', call: 'W1AW', band: '20', mode: 'CW', operator: 'WT2P' });   // found -> not a bust
    upsertQso({ ext_id: 'c', call: 'K3LR', band: '15', mode: 'CW', operator: 'WT2P' });   // uncached -> not a bust

    const body = await (await fetch(`${baseUrl}/api/busts`)).json();
    assert.equal(body.enabled, true);
    assert.equal(body.busts.length, 1);
    assert.equal(body.busts[0].call, 'WT2ZZZ');
    assert.equal(body.busts[0].band, '20');
    assert.equal(body.busts[0].operator, 'WT2P');
  });

  it('matches a portable call against its suffix-stripped cache entry', async () => {
    enableLookup();
    cacheCallsign('N0XXX', { call: 'N0XXX', source: 'hamqth', found: false }, 'hamqth');
    upsertQso({ ext_id: 'd', call: 'N0XXX/7', band: '40', mode: 'SSB', operator: 'K1ABC' });

    const body = await (await fetch(`${baseUrl}/api/busts`)).json();
    assert.deepEqual(body.busts.map((b) => b.call), ['N0XXX/7']);
  });

  it('returns an empty list when lookup is on but nothing is flagged', async () => {
    enableLookup();
    upsertQso({ ext_id: 'e', call: 'W1AW', band: '20', mode: 'CW', operator: 'WT2P' });
    const body = await (await fetch(`${baseUrl}/api/busts`)).json();
    assert.deepEqual(body, { enabled: true, busts: [] });
  });
});

describe('GET /api/solar', () => {
  it('is { updated: null } before any reading', async () => {
    clearQsos(); // does not touch solar_snapshots
    const body = await (await fetch(`${baseUrl}/api/solar`)).json();
    assert.equal(body.updated, null);
  });

  it('returns the newest stored reading', async () => {
    insertSolarSnapshot({ sfi: 140, a: 5, k: 2, sunspots: 88, xray: 'C1.0', geomag: 'QUIET' });
    const body = await (await fetch(`${baseUrl}/api/solar`)).json();
    assert.equal(body.sfi, 140);
    assert.equal(body.a, 5);
    assert.equal(body.k, 2);
    assert.equal(body.sunspots, 88);
    assert.ok(body.updated); // fetched_at default
  });

  it('survives clearQsos() -- solar is ambient, not contest data', async () => {
    clearQsos();
    const body = await (await fetch(`${baseUrl}/api/solar`)).json();
    assert.equal(body.sfi, 140);
  });
});
