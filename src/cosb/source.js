// Reads contestonlinescore.com (COSB): which contest is on air, and its
// scoreboard. One source per process -- hamdata on a tenant box (so four
// scoreboards in the same contest cost COSB one request, not four), or the
// instance itself on a standalone install.
//
// Politeness (agreed with COSB's operator for RTC, CJ 2026-11-28): a
// contest's scoreboard is fetched at most once per SCOREBOARD_TTL_MS, the
// on-air list once per LIST_TTL_MS, the supported-contests table once a
// day. Concurrent asks share one in-flight request. Nothing here runs on a
// timer -- it fetches only when someone asks, so a box with no contest
// running never touches COSB.
//
// The contest list (ids + on-air status) and the supported table are also
// kept in `store` (hamdata's settings table, CJ 2026-11-28), so a restart
// starts from the last known list instead of an empty one, and a COSB
// outage right after a restart still knows which contest is on air.

const { parseContestList, parseSupported, parseScoreboard, resolveContest, findContest } = require('./parse');

const COSB_BASE = 'https://contestonlinescore.com';
const SCOREBOARD_TTL_MS = 2 * 60000;
const LIST_TTL_MS = 10 * 60000;
const SUPPORTED_TTL_MS = 24 * 3600000;
const TIMEOUT_MS = 20000;
const USER_AGENT = 'contestscore';

const STORED = { list: 'cosb_contests', supported: 'cosb_supported' };

function createCosbSource({ fetchImpl, now = Date.now, base = COSB_BASE, store = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const cache = new Map(); // key -> { at, value }
  const inflight = new Map(); // key -> Promise

  // Seed from the store: { at, value } as JSON. A bad row is just ignored.
  if (store) {
    for (const [key, setting] of Object.entries(STORED)) {
      try {
        const row = JSON.parse(store.getSetting(setting) || 'null');
        if (row && Number.isFinite(row.at) && Array.isArray(row.value)) cache.set(key, row);
      } catch { /* start empty */ }
    }
  }
  function persist(key, entry) {
    if (!store || !STORED[key]) return;
    try { store.setSetting(STORED[key], JSON.stringify(entry)); } catch (err) { console.error(`cosb: store ${key}: ${err.message}`); }
  }

  async function getText(path) {
    const res = await doFetch(`${base}${path}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`COSB ${path.split('?')[0]}: HTTP ${res.status}`);
    return res.text();
  }

  // Cached + collapsed. A failed refresh keeps serving the last good value
  // until it is 3x its TTL old, so a COSB blip doesn't blank the panel.
  async function cached(key, ttl, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const value = await load();
        const entry = { at: now(), value };
        cache.set(key, entry);
        persist(key, entry);
        return value;
      } catch (err) {
        // A stored list (hamdata's settings) is served however old: it's
        // the last thing COSB said, better than nothing while it's down.
        if (hit && (STORED[key] || now() - hit.at < 3 * ttl)) return hit.value;
        throw err;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  const contestList = () => cached('list', LIST_TTL_MS, async () => parseContestList(await getText('/contest/')));
  const supported = () => cached('supported', SUPPORTED_TTL_MS, async () => parseSupported(await getText('/settings/')));

  async function scoreboard(id) {
    return cached(`sb:${id}`, SCOREBOARD_TTL_MS, async () => ({
      ...parseScoreboard(await getText(`/scoreboard/?contest_id=${id}`)),
      fetched_at: new Date(now()).toISOString(),
    }));
  }

  // -> { contest: { id, name, url }, updated, fetched_at, sections } or
  //    { contest: null } when nothing on air matches the logger's contest.
  // contestId (a number) skips the matching -- a per-tenant override for a
  // contest whose logger name COSB doesn't map.
  async function standings({ contest, contestId } = {}) {
    let c;
    if (contestId) {
      const list = await contestList().catch(() => []);
      c = list.find((x) => x.id === contestId) || { id: contestId, name: null, status: null };
    } else {
      const [list, sup] = await Promise.all([contestList(), supported()]);
      c = resolveContest(contest, list, sup);
    }
    if (!c) return { contest: null };
    const sb = await scoreboard(c.id);
    return {
      contest: { id: c.id, name: c.name, url: `${base}/scoreboard/?contest_id=${c.id}` },
      updated: sb.updated,
      fetched_at: sb.fetched_at,
      sections: sb.sections,
    };
  }

  // -> { contest: { id, name, status, url } | null, fetched_at } -- the COSB
  // contest a logger contest maps to and whether it's on air, for the
  // publisher (COSB rejects posts to a contest that isn't).
  async function contestStatus({ contest, contestId } = {}) {
    const list = await contestList();
    let c;
    if (contestId) c = list.find((x) => x.id === contestId) || null;
    else c = findContest(contest, list, await supported());
    const at = cache.get('list');
    return {
      contest: c ? { id: c.id, name: c.name, status: c.status, url: `${base}/scoreboard/?contest_id=${c.id}` } : null,
      fetched_at: at ? new Date(at.at).toISOString() : null,
    };
  }

  // The whole picker, as last fetched: { fetched_at, contests: [...] }.
  async function contests() {
    const list = await contestList();
    const at = cache.get('list');
    return { fetched_at: at ? new Date(at.at).toISOString() : null, contests: list };
  }

  return { standings, contestList, supported, scoreboard, contestStatus, contests };
}

module.exports = { createCosbSource, COSB_BASE, SCOREBOARD_TTL_MS };
