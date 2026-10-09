// How long a cached callsign lookup is trusted -- shared by every cache that
// holds HamQTH results: each contestscore instance's callsign_cache
// (src/lookup/index.js) and hamdata's shared one (hamdata/broker.js), so the
// two can't disagree about what's fresh.
//
// Callsigns rarely change (CJ, 2026-10-09): a found record is good for
// ~6 months. A NOT-found result is rechecked after a day -- it's usually a
// miscopy (that's what the busts panel is for), but it can be a brand-new
// licensee, and flagging a real call as a bust for half a year is worse
// than one extra lookup.

const DAY_MS = 24 * 3600 * 1000;
const FOUND_TTL_MS = 182 * DAY_MS;
const NOT_FOUND_TTL_MS = DAY_MS;

// callsign_cache.cached_at is datetime('now')-shaped UTC with no zone marker.
function cachedAtMs(row) {
  return new Date(String(row.cached_at).replace(' ', 'T') + 'Z').getTime();
}

function parseData(row) {
  try { return JSON.parse(row.data); } catch { return null; }
}

// row: a callsign_cache row ({ data, source, cached_at }). A record with no
// `found` field (N1MM's own lookupinfo) counts as found.
function isFresh(row, now = Date.now()) {
  if (!row || !row.cached_at) return false;
  const data = parseData(row);
  if (!data) return false;
  const ttl = data.found === false ? NOT_FOUND_TTL_MS : FOUND_TTL_MS;
  return now - cachedAtMs(row) < ttl;
}

module.exports = { isFresh, parseData, cachedAtMs, FOUND_TTL_MS, NOT_FOUND_TTL_MS };
