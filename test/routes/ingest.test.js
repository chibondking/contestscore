// Uses an in-memory SQLite DB and dedicated high test ports so it can run
// alongside a real contestscore instance (or test/udp/pipeline.test.js)
// without colliding. Same real-format fixtures as pipeline.test.js -- these
// routes run the exact same parse/DB/emit code the UDP listeners use, just
// fed via HTTP instead of a dgram socket (see src/routes/ingest.js). Calls
// startListeners() itself (like pipeline.test.js does) because that's what
// actually registers the DB-write handlers on the shared emitter -- app.js
// alone does not, since in production that only happens once, from
// server.js, before the HTTP server starts accepting requests.
process.env.DB_PATH = ':memory:';
process.env.UDP_RADIO_PORT = '15070';
process.env.UDP_CONTACT_PORT = '15071';
process.env.UDP_SCORE_PORT = '15072';

const http = require('node:http');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements, getRadios } = require('../../src/db/queries');
const { startListeners } = require('../../src/udp');
const bridgeStatus = require('../../src/state/bridgeStatus');

let httpServer;
let udpSockets;
let baseUrl;

before(async () => {
  initDb();
  udpSockets = startListeners({ emit() {} }); // fake io: DB writes are what we're testing
  const app = require('../../src/app');
  httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  for (const s of udpSockets) s.close();
  await new Promise((resolve) => httpServer.close(resolve));
  resetStatements();
  closeDb();
});

beforeEach(() => { delete process.env.CONTESTSCORE_API_TOKEN; bridgeStatus.resetForTests(); });
afterEach(() => { delete process.env.CONTESTSCORE_API_TOKEN; });

function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('waitFor: condition not met before timeout'));
      setTimeout(poll, interval);
    })();
  });
}

describe('POST /api/ingest/* auth', () => {
  it('is disabled (503) when CONTESTSCORE_API_TOKEN is not set -- fails closed, not open', async () => {
    const res = await fetch(`${baseUrl}/api/ingest/radio`, { method: 'POST', body: '<RadioInfo/>' });
    assert.equal(res.status, 503);
  });

  it('rejects a request with no token once one is configured', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/ingest/radio`, { method: 'POST', body: '<RadioInfo/>' });
    assert.equal(res.status, 401);
  });

  it('rejects the wrong token', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/ingest/radio`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: '<RadioInfo/>',
    });
    assert.equal(res.status, 401);
  });
});

describe('POST /api/ingest/radio', () => {
  it('with the right token, relays the raw bytes through the same parser/DB path as UDP', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<RadioInfo>
  <StationName>K1TTT-1</StationName>
  <RadioNr>1</RadioNr>
  <Freq>14025000</Freq>
  <Mode>CW</Mode>
  <OpCall>K1TTT</OpCall>
  <IsRunning>True</IsRunning>
</RadioInfo>`;
    const res = await fetch(`${baseUrl}/api/ingest/radio`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret123' },
      body: xml,
    });
    assert.equal(res.status, 202);

    await waitFor(() => getRadios().some((r) => r.op_call === 'K1TTT'));
    const radio = getRadios().find((r) => r.op_call === 'K1TTT');
    assert.equal(radio.freq, '14025000');
  });

  it('a malformed body is accepted (202) but logged and dropped, not a 500', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/ingest/radio`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret123' },
      body: 'not xml at all',
    });
    assert.equal(res.status, 202);
  });
});

describe('POST /api/ingest/heartbeat', () => {
  it('requires the same bearer token as the other ingest routes', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/ingest/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station_id: 'shack1' }),
    });
    assert.equal(res.status, 401);
  });

  it('with the right token, records the heartbeat and reports it as realtime', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/ingest/heartbeat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret123', 'Content-Type': 'application/json' },
      body: JSON.stringify({ station_id: 'shack1' }),
    });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.station_id, 'shack1');
    assert.equal(body.status, 'realtime');

    // Reflected immediately in GET /api/bridges too.
    const listRes = await fetch(`${baseUrl}/api/bridges`);
    const list = await listRes.json();
    assert.ok(list.some((s) => s.station_id === 'shack1' && s.status === 'realtime'));
  });

  it('rejects a heartbeat with no station_id', async () => {
    process.env.CONTESTSCORE_API_TOKEN = 'secret123';
    const res = await fetch(`${baseUrl}/api/ingest/heartbeat`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret123', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});
