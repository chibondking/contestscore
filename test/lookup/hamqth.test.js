const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createHamqthClient, parseHamqthXml, readSession, readSearch, normaliseSearch,
} = require('../../src/lookup/hamqth');

const SESSION_OK = `<?xml version="1.0"?>
<HamQTH version="2.7" xmlns="https://www.hamqth.com">
<session><session_id>SID-ABC</session_id></session></HamQTH>`;

const SESSION_BAD = `<?xml version="1.0"?>
<HamQTH version="2.7" xmlns="https://www.hamqth.com">
<session><error>Wrong user name or password</error></session></HamQTH>`;

const SESSION_EXPIRED = `<?xml version="1.0"?>
<HamQTH version="2.7" xmlns="https://www.hamqth.com">
<session><error>Session does not exist or expired</error></session></HamQTH>`;

const NOT_FOUND = `<?xml version="1.0"?>
<HamQTH version="2.7" xmlns="https://www.hamqth.com">
<session><error>Callsign not found</error></session></HamQTH>`;

const SEARCH_OK = `<?xml version="1.0"?>
<HamQTH version="2.7" xmlns="https://www.hamqth.com">
<search>
<callsign>ok2cqr</callsign><nick>Petr</nick><country>Czech Republic</country>
<adif>503</adif><itu>28</itu><cq>15</cq><grid>jo70gg</grid><continent>EU</continent>
</search></HamQTH>`;

// A fake fetch that hands back a queued list of body strings in order.
function fakeFetch(bodies) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = bodies.shift();
    if (body === undefined) throw new Error(`fakeFetch: no more responses (url ${url})`);
    return { ok: true, status: 200, text: async () => body };
  };
  fn.calls = calls;
  return fn;
}

describe('hamqth parse helpers', () => {
  it('reads a session id', async () => {
    assert.equal(readSession(await parseHamqthXml(SESSION_OK)), 'SID-ABC');
  });

  it('throws on a bad-credentials session response', async () => {
    const root = await parseHamqthXml(SESSION_BAD);
    assert.throws(() => readSession(root), /Wrong user name or password/);
  });

  it('normalises a <search> block onto the lookupinfo shape', () => {
    const r = normaliseSearch({
      callsign: 'ok2cqr', nick: 'Petr', country: 'Czech Republic',
      adif: '503', itu: '28', cq: '15', grid: 'jo70gg', continent: 'EU',
    });
    assert.deepEqual(r, {
      call: 'OK2CQR', name: 'Petr', country: 'Czech Republic', grid: 'jo70gg',
      state: '', county: '', cqzone: '15', ituzone: '28', dxcc: '503', continent: 'EU',
    });
  });

  it('treats "Callsign not found" as a result, not an error', async () => {
    assert.deepEqual(readSearch(await parseHamqthXml(NOT_FOUND), 'W1XYZ'), { call: 'W1XYZ', found: false });
  });

  it('flags a session error with a retry code', async () => {
    const root = await parseHamqthXml(SESSION_EXPIRED);
    assert.throws(() => readSearch(root, 'W1AW'), (e) => e.code === 'HAMQTH_SESSION');
  });
});

describe('createHamqthClient', () => {
  const creds = { username: 'W1AW', password: 'secret' };

  it('authenticates once, then looks up a found callsign', async () => {
    const fetchImpl = fakeFetch([SESSION_OK, SEARCH_OK]);
    const client = createHamqthClient({ ...creds, prg: 'contestscore', fetchImpl });

    const rec = await client.lookup('ok2cqr');
    assert.equal(rec.found, true);
    assert.equal(rec.call, 'OK2CQR');
    assert.equal(rec.cqzone, '15');
    assert.equal(fetchImpl.calls.length, 2);
    assert.match(fetchImpl.calls[0], /\?u=W1AW&p=secret$/);
    assert.match(fetchImpl.calls[1], /id=SID-ABC&callsign=OK2CQR&prg=contestscore/);
  });

  it('reuses the cached session for a second lookup', async () => {
    const fetchImpl = fakeFetch([SESSION_OK, SEARCH_OK, NOT_FOUND]);
    const client = createHamqthClient({ ...creds, fetchImpl });

    await client.lookup('ok2cqr');
    const miss = await client.lookup('w1xyz');
    assert.deepEqual(miss, { call: 'W1XYZ', found: false });
    assert.equal(fetchImpl.calls.length, 3); // 1 auth + 2 lookups
  });

  it('re-authenticates once when the session expires mid-run', async () => {
    const fetchImpl = fakeFetch([SESSION_OK, SESSION_EXPIRED, SESSION_OK, SEARCH_OK]);
    const client = createHamqthClient({ ...creds, fetchImpl });

    const rec = await client.lookup('ok2cqr');
    assert.equal(rec.found, true);
    assert.equal(fetchImpl.calls.length, 4);
  });

  it('refreshes the session once its TTL passes', async () => {
    let t = 0;
    const fetchImpl = fakeFetch([SESSION_OK, SEARCH_OK, SESSION_OK, SEARCH_OK]);
    const client = createHamqthClient({ ...creds, fetchImpl, now: () => t });

    await client.lookup('ok2cqr');
    t = 56 * 60 * 1000; // past SESSION_TTL_MS
    await client.lookup('ok2cqr');
    assert.equal(fetchImpl.calls.length, 4); // auth + lookup, twice
  });

  it('rejects when credentials are wrong', async () => {
    const client = createHamqthClient({ ...creds, fetchImpl: fakeFetch([SESSION_BAD]) });
    await assert.rejects(() => client.lookup('ok2cqr'), /Wrong user name or password/);
  });

  it('rejects on a non-200 from the API', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => '' });
    const client = createHamqthClient({ ...creds, fetchImpl });
    await assert.rejects(() => client.lookup('ok2cqr'), /HTTP 503/);
  });
});
