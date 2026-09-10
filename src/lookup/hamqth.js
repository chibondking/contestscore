// HamQTH XML API client (https://www.hamqth.com/developers.php).
//
// Two endpoints, both on xml.php:
//   auth   -> ?u=<user>&p=<pass>            -> <session><session_id>..</>
//   lookup -> ?id=<sid>&callsign=<c>&prg=<> -> <search>..</search>
// Errors for BOTH come back as <session><error>..</error></session>:
//   "Wrong user name or password"        (auth)
//   "Callsign not found"                 (lookup -> not a failure: found:false)
//   "Session does not exist or expired"  (lookup -> re-auth and retry once)
//
// A session id is good for one hour; we cache it and refresh a little early.
// The client is deliberately dumb about rate limiting / retries beyond the
// one session refresh -- src/lookup/index.js owns the queue, pacing and
// backoff.

const xml2js = require('xml2js');

const HAMQTH_XML = 'https://www.hamqth.com/xml.php';
const PARSE_OPTS = { explicitArray: false, trim: true };
const SESSION_TTL_MS = 55 * 60 * 1000;

async function parseHamqthXml(text) {
  const result = await xml2js.parseStringPromise(text, PARSE_OPTS);
  const root = result && result.HamQTH;
  if (!root) throw new Error('HamQTH: unrecognised response');
  return root;
}

// <session><session_id>..</> -> the id; <session><error>..</> -> throw.
function readSession(root) {
  const s = root.session || {};
  if (s.session_id) return s.session_id;
  throw new Error(`HamQTH auth failed: ${s.error || 'no session_id in response'}`);
}

// <search> -> { ...fields, found:true }
// <session><error>Callsign not found</>   -> { call, found:false }
// <session><error>..session..</>          -> throw with .code = 'HAMQTH_SESSION'
function readSearch(root, call) {
  if (root.search) return { ...normaliseSearch(root.search), found: true };
  const err = (root.session && root.session.error) || '';
  if (/not found/i.test(err)) return { call, found: false };
  if (/session/i.test(err)) {
    const e = new Error(`HamQTH: ${err}`);
    e.code = 'HAMQTH_SESSION';
    throw e;
  }
  throw new Error(`HamQTH: ${err || 'unrecognised search response'}`);
}

// Map HamQTH's <search> fields onto the same shape src/parsers/lookup.js
// produces for N1MM's own <lookupinfo>, so every `lookup:result` consumer
// sees one record shape regardless of source.
function normaliseSearch(s) {
  return {
    call: String(s.callsign || '').toUpperCase(),
    name: s.nick || s.adr_name || '',
    country: s.country || '',
    grid: s.grid || '',
    state: s.us_state || '',
    county: s.us_county || '',
    cqzone: s.cq || '',
    ituzone: s.itu || '',
    dxcc: s.adif || '',
    continent: s.continent || '',
  };
}

function createHamqthClient({
  username, password, prg = 'contestscore', fetchImpl, now = Date.now,
} = {}) {
  if (!username || !password) throw new Error('HamQTH client needs a username and password');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('HamQTH client: no fetch implementation available');

  let sessionId = null;
  let sessionAt = 0;

  async function authenticate() {
    const url = `${HAMQTH_XML}?u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`HamQTH auth: HTTP ${res.status}`);
    sessionId = readSession(await parseHamqthXml(await res.text()));
    sessionAt = now();
    return sessionId;
  }

  async function ensureSession() {
    if (sessionId && now() - sessionAt < SESSION_TTL_MS) return sessionId;
    return authenticate();
  }

  async function queryOnce(cs) {
    const url = `${HAMQTH_XML}?id=${encodeURIComponent(sessionId)}`
      + `&callsign=${encodeURIComponent(cs)}&prg=${encodeURIComponent(prg)}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`HamQTH lookup: HTTP ${res.status}`);
    return readSearch(await parseHamqthXml(await res.text()), cs);
  }

  async function lookup(call) {
    const cs = String(call || '').trim().toUpperCase();
    if (!cs) throw new Error('HamQTH lookup: empty callsign');
    await ensureSession();
    try {
      return await queryOnce(cs);
    } catch (err) {
      if (err.code !== 'HAMQTH_SESSION') throw err;
      await authenticate(); // session died inside the hour -- one retry
      return queryOnce(cs);
    }
  }

  return { lookup, _peek: () => ({ sessionId, sessionAt }) };
}

module.exports = {
  createHamqthClient, parseHamqthXml, readSession, readSearch, normaliseSearch, SESSION_TTL_MS,
};
