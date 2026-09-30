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
const { gridToLatLon, resolveCall, usCallAreaLatLon } = require('../../src/analyze/geo');

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

// World map: GET /api/qsos rows carry a computed lat/lon (see
// src/analyze/geo.js's resolveLatLon), never written to the qsos table.
describe('GET /api/qsos (world map lat/lon)', () => {
  beforeEach(() => { clearQsos(); });
  after(() => { clearQsos(); });

  it('prefers a real grid square over the country-file entity center', async () => {
    upsertQso({ ext_id: 'g1', call: 'W1AW', band: '20', mode: 'CW', gridsquare: 'FN31' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    assert.deepEqual({ lat: q.lat, lon: q.lon }, gridToLatLon('FN31'));
  });

  it('falls back to the country file when there is no grid square', async () => {
    // Non-US: W1AW would now go through the call-area refinement below
    // instead of the bare country-file entity center.
    upsertQso({ ext_id: 'g2', call: 'DL1XYZ', band: '20', mode: 'CW' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    const k = resolveCall('DL1XYZ');
    assert.equal(q.lat, k.lat);
    assert.equal(q.lon, k.lon);
  });

  it('a mainland US call is refined to its call area, not cty.csv\'s single entity center', async () => {
    // Confirmed live 2026-09: W6SX/AA7V (West Coast) plotted in Missouri
    // before this refinement existed.
    upsertQso({ ext_id: 'g5', call: 'W6SX', band: '20', mode: 'CW' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    const genericEntity = resolveCall('W6SX');
    assert.notEqual(q.lat, genericEntity.lat);
    assert.notEqual(q.lon, genericEntity.lon);
    assert.deepEqual({ lat: q.lat, lon: q.lon }, usCallAreaLatLon('W6SX'));
  });

  it('omits lat/lon rather than sending null for an unresolvable call', async () => {
    upsertQso({ ext_id: 'g3', call: '12345', band: '20', mode: 'CW' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    assert.equal('lat' in q, false);
    assert.equal('lon' in q, false);
  });

  it('is computed at response time, not persisted -- refetching after a plain upsert stays consistent', async () => {
    upsertQso({ ext_id: 'g4', call: 'DL1XYZ', band: '20', mode: 'CW' });
    const first = await (await fetch(`${baseUrl}/api/qsos`)).json();
    const second = await (await fetch(`${baseUrl}/api/qsos`)).json();
    assert.deepEqual(
      { lat: first[0].lat, lon: first[0].lon },
      { lat: second[0].lat, lon: second[0].lon },
    );
  });

  it('uses a HamQTH-cached grid over the call-area/entity guess when the exchange has none', async () => {
    cacheCallsign('K9WX', { call: 'K9WX', grid: 'EM69', found: true }, 'hamqth');
    upsertQso({ ext_id: 'g6', call: 'K9WX', band: '40', mode: 'RTTY' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    assert.deepEqual({ lat: q.lat, lon: q.lon }, gridToLatLon('EM69'));
    assert.equal(q.locSource, 'hamqth');
  });

  it('still prefers the exchange\'s own reported grid over a cached lookup grid', async () => {
    cacheCallsign('W1AW', { call: 'W1AW', grid: 'EM69', found: true }, 'hamqth');
    upsertQso({ ext_id: 'g7', call: 'W1AW', band: '20', mode: 'CW', gridsquare: 'FN31' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    assert.deepEqual({ lat: q.lat, lon: q.lon }, gridToLatLon('FN31'));
    assert.equal(q.locSource, 'exchange');
  });

  it('falls back to the old call-area/entity estimate when the lookup came back not-found', async () => {
    cacheCallsign('W6SX', { call: 'W6SX', found: false }, 'hamqth');
    upsertQso({ ext_id: 'g8', call: 'W6SX', band: '20', mode: 'CW' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    assert.deepEqual({ lat: q.lat, lon: q.lon }, usCallAreaLatLon('W6SX'));
    assert.equal(q.locSource, 'estimate');
  });

  it('falls back to the old estimate the same way when no provider is enabled at all (nothing cached)', async () => {
    upsertQso({ ext_id: 'g9', call: 'W6SX', band: '20', mode: 'CW' });
    const res = await fetch(`${baseUrl}/api/qsos`);
    const [q] = await res.json();
    assert.deepEqual({ lat: q.lat, lon: q.lon }, usCallAreaLatLon('W6SX'));
    assert.equal(q.locSource, 'estimate');
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

describe('GET /api/health', () => {
  it('is public, 200, status ok when the DB is reachable and no UDP listeners are tracked', async () => {
    // This test harness never calls startListeners() (see the before()
    // hook above), so getUdpListeners() is null here -- exactly the
    // "not applicable" case the route treats as not failing the check.
    // The real UDP-bind behavior is exercised by udp/*Listener.js's own
    // socket, not re-tested here.
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.db.ok, true);
    assert.deepEqual(body.checks.udp_listeners, { radio: null, contact: null, score: null });
    assert.ok(Array.isArray(body.bridges));
    assert.ok('lookup' in body);
    assert.ok('solar' in body);
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

  it('skips an X-QSO -- the operator already struck it out', async () => {
    enableLookup();
    cacheCallsign('WT2ZZZ', { call: 'WT2ZZZ', source: 'hamqth', found: false }, 'hamqth');
    upsertQso({ ext_id: 'x1', call: 'WT2ZZZ', band: '20', mode: 'CW', operator: 'WT2P', is_claimed_qso: 0 });
    const body = await (await fetch(`${baseUrl}/api/busts`)).json();
    assert.equal(body.busts.length, 0);
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

// This test harness never calls startListeners() (see the `before()` hook
// above), so getLookupService() is null here -- these only exercise the
// "no live service" fallback and the token gate. The actual pause/resume
// queue behavior is covered by test/lookup/index.test.js against a real
// service instance.
describe('GET/POST /api/lookup/*', () => {
  it('status is a quiet "off" with no live lookup service', async () => {
    const body = await (await fetch(`${baseUrl}/api/lookup/status`)).json();
    assert.deepEqual(body, { provider: 'none', enabled: false, paused: false });
  });

  it('pause/resume are a no-op 200 with no live service, and no token required', async () => {
    const pause = await fetch(`${baseUrl}/api/lookup/pause`, { method: 'POST' });
    assert.equal(pause.status, 200);
    const resume = await fetch(`${baseUrl}/api/lookup/resume`, { method: 'POST' });
    assert.equal(resume.status, 200);
  });

  it('requires the bearer token when CONTESTSCORE_API_TOKEN is set', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const noAuth = await fetch(`${baseUrl}/api/lookup/pause`, { method: 'POST' });
    assert.equal(noAuth.status, 401);

    const withAuth = await fetch(`${baseUrl}/api/lookup/pause`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret123' },
    });
    assert.equal(withAuth.status, 200);
  });
});

describe('GET /api/solar/history', () => {
  it('400s without both from and to', async () => {
    const r = await fetch(`${baseUrl}/api/solar/history?from=2026-01-01 00:00:00`);
    assert.equal(r.status, 400);
  });

  it('returns readings within the range, ordered by time', async () => {
    insertSolarSnapshot({ sfi: 100, a: 4, k: 1, sunspots: 50 });
    const body = await (await fetch(
      `${baseUrl}/api/solar/history?from=${encodeURIComponent('2000-01-01 00:00:00')}&to=${encodeURIComponent('2100-01-01 00:00:00')}`,
    )).json();
    assert.ok(Array.isArray(body));
    assert.ok(body.some((r) => r.sfi === 100));
  });

  it('leads with the reading already in effect at `from`, but not a stale one', async () => {
    insertSolarSnapshot({ sfi: 70, a: 30, k: 5, sunspots: 10, fetched_at: '2025-03-01 00:00:00' });
    insertSolarSnapshot({ sfi: 150, a: 3, k: 1, sunspots: 160, fetched_at: '2025-03-02 11:00:00' });
    insertSolarSnapshot({ sfi: 152, a: 4, k: 1, sunspots: 161, fetched_at: '2025-03-02 13:00:00' });
    const body = await (await fetch(
      `${baseUrl}/api/solar/history?from=${encodeURIComponent('2025-03-02 12:00:00')}&to=${encodeURIComponent('2025-03-02 14:00:00')}`,
    )).json();
    assert.deepEqual(body.map((r) => r.sfi), [150, 152]);

    // Nothing within 6h before `from`: the day-old reading isn't "in effect".
    const stale = await (await fetch(
      `${baseUrl}/api/solar/history?from=${encodeURIComponent('2025-03-01 12:00:00')}&to=${encodeURIComponent('2025-03-01 13:00:00')}`,
    )).json();
    assert.deepEqual(stale, []);
  });

  it('excludes readings outside the range', async () => {
    const body = await (await fetch(
      `${baseUrl}/api/solar/history?from=${encodeURIComponent('1990-01-01 00:00:00')}&to=${encodeURIComponent('1990-01-02 00:00:00')}`,
    )).json();
    assert.deepEqual(body, []);
  });
});
