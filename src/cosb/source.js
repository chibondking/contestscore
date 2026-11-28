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

const { parseContestList, parseSupported, parseScoreboard, resolveContest } = require('./parse');

const COSB_BASE = 'https://contestonlinescore.com';
const SCOREBOARD_TTL_MS = 2 * 60000;
const LIST_TTL_MS = 10 * 60000;
const SUPPORTED_TTL_MS = 24 * 3600000;
const TIMEOUT_MS = 20000;
const USER_AGENT = 'contestscore';

function createCosbSource({ fetchImpl, now = Date.now, base = COSB_BASE } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const cache = new Map(); // key -> { at, value }
  const inflight = new Map(); // key -> Promise

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
        cache.set(key, { at: now(), value });
        return value;
      } catch (err) {
        if (hit && now() - hit.at < 3 * ttl) return hit.value;
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

  return { standings, contestList, supported, scoreboard };
}

module.exports = { createCosbSource, COSB_BASE, SCOREBOARD_TTL_MS };
