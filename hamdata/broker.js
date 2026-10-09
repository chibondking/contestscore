// Callsign lookups for every contestscore instance on the box, behind one
// set of HamQTH credentials and one shared cache.
//
// Unlike src/lookup/index.js (a fire-and-forget queue that emits results),
// this answers a request: a contestscore instance in hamdata mode already
// runs that queue -- pacing, backoff, pause -- and its hamdata client just
// needs each call answered. What lives here is what only makes sense once,
// for everybody: the shared cache, collapsing duplicate in-flight requests
// (two tenants working the same DX at once), and spacing calls to HamQTH
// so N tenants never add up to N times the request rate.

const { isFresh, parseData } = require('../src/lookup/ttl');

const BETWEEN_MS = 350; // same spacing as src/lookup/
const SOURCE = 'hamqth';
const PAUSED_KEY = 'lookup_paused';

// Paused = the box operator stopped all OUTGOING lookups to HamQTH (their
// account; CJ, 2026-10-09). Cache hits are still answered -- only misses
// get a 503 { code: 'paused' }. Persisted in hamdata's settings table, so a
// restart or deploy never silently turns lookups back on.
function createLookupBroker({
  client, getCached, cache, getSetting, setSetting, now = Date.now, sleep, betweenMs = BETWEEN_MS,
} = {}) {
  const wait = sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const inFlight = new Map();
  let chain = Promise.resolve();
  let lastUpstreamAt = 0;
  let paused = false;
  try { paused = Boolean(getSetting) && getSetting(PAUSED_KEY) === '1'; } catch { paused = false; }
  function persist(v) {
    if (!setSetting) return;
    try { setSetting(PAUSED_KEY, v ? '1' : '0'); } catch (e) { console.error(`hamdata: couldn't save paused state: ${e.message}`); }
  }
  const stats = { hits: 0, upstream: 0, errors: 0 };

  // TTL rules shared with every instance's own cache: src/lookup/ttl.js.
  function fresh(call) {
    let row = null;
    try { row = getCached(call); } catch { return null; }
    if (!row || row.source !== SOURCE || !isFresh(row, now())) return null;
    return parseData(row);
  }

  // One upstream request at a time, at least betweenMs apart.
  function upstream(call) {
    const job = chain.then(async () => {
      const gap = lastUpstreamAt + betweenMs - now();
      if (gap > 0) await wait(gap);
      try {
        return await client.lookup(call);
      } finally {
        lastUpstreamAt = now();
      }
    });
    chain = job.catch(() => {});
    return job;
  }

  // -> { ...record, call, found, source }. Throws err.status 503 when
  // disabled or paused (the caller's queue backs off and retries later).
  async function get(call) {
    const hit = fresh(call);
    if (hit) { stats.hits += 1; return { ...hit, call, source: SOURCE }; }

    if (!client) throw Object.assign(new Error('lookup not configured'), { status: 503 });
    if (paused) throw Object.assign(new Error('lookups stopped by the server operator (cached calls only)'), { status: 503, code: 'paused' });

    if (inFlight.has(call)) return inFlight.get(call);
    const p = (async () => {
      try {
        const rec = await upstream(call);
        stats.upstream += 1;
        const out = { ...rec, call, found: Boolean(rec.found) };
        try { cache(call, out, SOURCE); } catch (e) { console.error(`hamdata cache ${call}: ${e.message}`); }
        return { ...out, source: SOURCE };
      } catch (err) {
        stats.errors += 1;
        throw Object.assign(err, { status: err.status || 502 });
      } finally {
        inFlight.delete(call);
      }
    })();
    inFlight.set(call, p);
    return p;
  }

  return {
    get,
    pause: () => { paused = true; persist(true); },
    resume: () => { paused = false; persist(false); },
    getStatus: () => ({
      provider: client ? SOURCE : 'none', enabled: Boolean(client), paused: Boolean(client) && paused,
      in_flight: inFlight.size, ...stats,
    }),
  };
}

module.exports = { createLookupBroker };
