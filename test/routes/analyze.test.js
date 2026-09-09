// In-memory DB so no files are created.
process.env.DB_PATH = ':memory:';

const http = require('node:http');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements, upsertQso, insertScoreBreakdown } = require('../../src/db/queries');

let server;
let baseUrl;

const CABRILLO = `START-OF-LOG: 3.0
CALLSIGN: WT2P
CONTEST: CQ-WPX-CW
QSO: 14042 CW 2025-05-24 1200 WT2P 599 0001 K3LR 599 0044
QSO:  7025 CW 2025-05-24 1305 WT2P 599 0003 JA1ABC 599 0555
X-QSO: 14042 CW 2025-05-24 1200 WT2P 599 0001 N0DUP 599 0044
END-OF-LOG:
`;

const ADIF = `<EOH>
<CALL:4>K3LR<QSO_DATE:8>20250524<TIME_ON:6>120000<BAND:3>20m<MODE:2>CW<OPERATOR:4>WT2P<APP_N1MM_POINTS:1>2<APP_N1MM_ISMULTIPLIER1:1>1<EOR>
`;

before(async () => {
  initDb();
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

function post(body, headers = {}) {
  return fetch(`${baseUrl}/api/analyze`, { method: 'POST', headers, body });
}

describe('POST /api/analyze', () => {
  it('503s when no token is configured (fail closed)', async () => {
    const res = await post(CABRILLO, { 'Content-Type': 'text/plain' });
    assert.equal(res.status, 503);
  });

  it('401s with a wrong token', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const res = await post(CABRILLO, { Authorization: 'Bearer nope', 'Content-Type': 'text/plain' });
    assert.equal(res.status, 401);
  });

  it('422s on an unrecognised format', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const res = await post('not a log at all', {
      Authorization: 'Bearer sekret', 'Content-Type': 'text/plain',
    });
    assert.equal(res.status, 422);
  });

  it('stores a Cabrillo upload and returns an id + meta', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const res = await post(CABRILLO, {
      Authorization: 'Bearer sekret', 'Content-Type': 'text/plain',
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.id, /^[A-Za-z0-9]{10}$/);
    assert.equal(body.meta.format, 'cabrillo');
    assert.equal(body.meta.qso_count, 2);
    assert.equal(body.meta.excluded_count, 1);
    assert.equal(body.meta.has_points, false);
    assert.equal(body.meta.contest_key, 'CQ-WPX');
    assert.equal(body.meta.exchange_parsed, true);

    // contest fields + the X-QSO list round-trip through storage to the GET
    const fetched = await fetch(`${baseUrl}/api/analyze/${body.id}`).then((r) => r.json());
    assert.equal(fetched.meta.contest_key, 'CQ-WPX');
    assert.equal(fetched.meta.exchange_parsed, true);
    assert.equal(fetched.excluded.length, 1);
    assert.equal(fetched.excluded[0].call, 'N0DUP');
    assert.ok(fetched.qsos.every((q) => q.call !== 'N0DUP'));
  });
});

describe('GET /api/analyze/:id', () => {
  let id;
  before(async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const res = await post(ADIF, { Authorization: 'Bearer sekret', 'Content-Type': 'text/plain' });
    id = (await res.json()).id;
    delete process.env.CONTESTSCORE_API_TOKEN;
  });

  it('is public and returns { meta, qsos }', async () => {
    const res = await fetch(`${baseUrl}/api/analyze/${id}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.format, 'adif');
    assert.equal(body.meta.has_points, true);
    assert.equal(body.qsos.length, 1);
    assert.equal(body.qsos[0].call, 'K3LR');
    assert.equal(body.qsos[0].points, 2);
    assert.equal(body.qsos[0].continent, 'NA');
  });

  it('404s an unknown id', async () => {
    const res = await fetch(`${baseUrl}/api/analyze/doesnotexist`);
    assert.equal(res.status, 404);
  });
});

describe('POST /api/analyze/from-live', () => {
  it('503 without a token, 422 when the live DB is empty, 201 with QSOs', async () => {
    const noAuth = await fetch(`${baseUrl}/api/analyze/from-live`, { method: 'POST' });
    assert.equal(noAuth.status, 503);

    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const empty = await fetch(`${baseUrl}/api/analyze/from-live`, {
      method: 'POST', headers: { Authorization: 'Bearer sekret' },
    });
    assert.equal(empty.status, 422); // no QSOs ingested in this test file

    upsertQso({
      ext_id: 'live-1', call: 'K3LR', band: '14', mode: 'CW', operator: 'WT2P',
      mycall: 'WT2P', contestname: 'CQ-WPX-CW', contestnr: '1',
      countryprefix: 'K', continent: 'NA', zone: '5',
      is_mult1: 1, points: 3, is_run_qso: 1,
      n1mm_timestamp: '2026-09-06 12:00:00',
    });
    upsertQso({
      ext_id: 'live-2', call: 'DL1XYZ', band: '7', mode: 'CW', operator: 'WT2P',
      mycall: 'WT2P', contestname: 'CQ-WPX-CW', contestnr: '1',
      countryprefix: 'DL', continent: 'EU', zone: '14',
      points: 6, n1mm_timestamp: '2026-09-06 12:05:00',
    });
    insertScoreBreakdown({
      contest: 'CQ-WPX-CW', call: 'WT2P', score_total: 987654,
      breakdown: [{ band: 'ALL', mode: 'ALL', qsos: 2, points: 9, mults: 2, is_total: 1 }],
    });

    const res = await fetch(`${baseUrl}/api/analyze/from-live`, {
      method: 'POST', headers: { Authorization: 'Bearer sekret' },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.id, /^[A-Za-z0-9]{10}$/);
    assert.equal(body.meta.format, 'live');
    assert.equal(body.meta.qso_count, 2);
    assert.equal(body.meta.has_points, true);
    assert.equal(body.meta.claimed_score, 987654);
    assert.equal(body.meta.contest_key, 'CQ-WPX');

    delete process.env.CONTESTSCORE_API_TOKEN;
    const fetched = await fetch(`${baseUrl}/api/analyze/${body.id}`).then((r) => r.json());
    assert.equal(fetched.qsos.length, 2);
    assert.equal(fetched.qsos[0].points, 3);
    assert.equal(fetched.qsos[1].continent, 'EU');
  });
});

describe('GET /api/analyze (saved list)', () => {
  it('needs the token and returns { items, retention }', async () => {
    const noAuth = await fetch(`${baseUrl}/api/analyze`);
    assert.equal(noAuth.status, 503); // token not configured in this test

    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const bad = await fetch(`${baseUrl}/api/analyze`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);

    const res = await fetch(`${baseUrl}/api/analyze`, { headers: { Authorization: 'Bearer sekret' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 1);
    assert.ok('created_at' in body.items[0]);
    assert.equal(typeof body.retention.keep, 'number');
    assert.equal(typeof body.retention.ttl_days, 'number');
    delete process.env.CONTESTSCORE_API_TOKEN;
  });
});

describe('DELETE /api/analyze/:id', () => {
  it('requires the token and removes the row', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    const created = await post(CABRILLO, {
      Authorization: 'Bearer sekret', 'Content-Type': 'text/plain',
    });
    const { id } = await created.json();

    const noAuth = await fetch(`${baseUrl}/api/analyze/${id}`, { method: 'DELETE' });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`${baseUrl}/api/analyze/${id}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer sekret' },
    });
    assert.equal(ok.status, 200);

    delete process.env.CONTESTSCORE_API_TOKEN;
    const gone = await fetch(`${baseUrl}/api/analyze/${id}`);
    assert.equal(gone.status, 404);
  });
});

describe('retention', () => {
  it('prunes to ANALYZE_KEEP most recent', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'sekret';
    process.env.ANALYZE_KEEP = '3';
    // The router reads ANALYZE_KEEP at module load, so re-require a fresh
    // copy of the app with the new limit.
    delete require.cache[require.resolve('../../src/routes/analyze')];
    delete require.cache[require.resolve('../../src/app')];
    const app2 = require('../../src/app');
    const srv = http.createServer(app2);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;

    const ids = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`${url}/api/analyze`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sekret', 'Content-Type': 'text/plain' },
        body: CABRILLO,
      });
      ids.push((await res.json()).id);
    }

    const first = await fetch(`${url}/api/analyze/${ids[0]}`);
    const last = await fetch(`${url}/api/analyze/${ids[5]}`);
    assert.equal(first.status, 404, 'oldest pruned');
    assert.equal(last.status, 200, 'newest kept');

    await new Promise((r) => srv.close(r));
    delete process.env.ANALYZE_KEEP;
    delete process.env.CONTESTSCORE_API_TOKEN;
    delete require.cache[require.resolve('../../src/routes/analyze')];
    delete require.cache[require.resolve('../../src/app')];
  });
});
