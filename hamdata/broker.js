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

const BETWEEN_MS = 350;                       // same spacing as src/lookup/
const FOUND_TTL_MS = 30 * 24 * 3600 * 1000;   // a found record: 30 days
const NOT_FOUND_TTL_MS = 24 * 3600 * 1000;    // not found: retry after a day

const SOURCE = 'hamqth';

// callsign_cache.cached_at is datetime('now')-shaped UTC with no zone marker.
function cachedAtMs(row) {
  return new Date(String(row.cached_at).replace(' ', 'T') + 'Z').getTime();
}

function createLookupBroker({
  client, getCached, cache, now = Date.now, sleep, betweenMs = BETWEEN_MS,
  foundTtlMs = FOUND_TTL_MS, notFoundTtlMs = NOT_FOUND_TTL_MS,
} = {}) {
  const wait = sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const inFlight = new Map();
  let chain = Promise.resolve();
  let lastUpstreamAt = 0;
  let paused = false;
  const stats = { hits: 0, upstream: 0, errors: 0 };

  function fresh(call) {
    let row = null;
    try { row = getCached(call); } catch { return null; }
    if (!row || row.source !== SOURCE) return null;
    let data;
    try { data = JSON.parse(row.data); } catch { return null; }
    const ttl = data.found ? foundTtlMs : notFoundTtlMs;
    return now() - cachedAtMs(row) < ttl ? data : null;
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
    if (paused) throw Object.assign(new Error('lookup paused'), { status: 503 });

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
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    getStatus: () => ({
      provider: client ? SOURCE : 'none', enabled: Boolean(client), paused: Boolean(client) && paused,
      in_flight: inFlight.size, ...stats,
    }),
  };
}

module.exports = { createLookupBroker, FOUND_TTL_MS, NOT_FOUND_TTL_MS };
