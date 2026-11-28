// contestonlinescore.com (COSB) for one scoreboard (CJ, 2026-11-28):
//
//  - Standings: where this station stands in its COSB category -- rank,
//    the leaders, the stations just above and below, the gap in points.
//    Opt-in per board (CJ, 2026-11-28): off until switched on from the
//    Admin page (settings.cosb_standings). Then polled every POLL_MS while
//    a contest is live (a Score broadcast in the last ACTIVE_MS), through
//    hamdata when HAMDATA_URL is set (one COSB request per contest per
//    box), else straight from COSB. COSB_ENABLED=false in the environment
//    turns the whole feature off for the instance; COSB_CONTEST_ID pins the
//    contest when the logger's name doesn't map.
//
//  - Publishing: forward the station's own Score broadcast (N1MM/DXLog's
//    <dynamicresults> -- byte for byte the XML COSB's gateway takes) to
//    COSB, at most once per PUBLISH_MIN_MS, with the club's COSB login.
//    Off until switched on from the Admin page (or COSB_USER /
//    COSB_PASSWORD in the environment). The password is stored in this
//    instance's settings table and never sent back to a browser.
//
// Nothing here touches the realtime pipeline: every failure is logged,
// kept as status, and the next cycle tries again.

const { getLatestScore, getSetting, setSetting } = require('../db/queries');
const { createCosbSource, COSB_BASE } = require('./source');
const { createHamdataClient, resolveHamdataUrl } = require('../hamdata/client');
const { isScope, scopeLabel, createLocator, scopeBoard, scopeChoices } = require('./scope');
const config = require('../../config/default.json');

const POLL_MS = 2 * 60000;
const ACTIVE_MS = 30 * 60000;
const PUBLISH_MIN_MS = 2 * 60000;
const POST_TIMEOUT_MS = 20000;
const TOP_N = 3;
const AROUND = 2;

const KEYS = {
  standings: 'cosb_standings', publish: 'cosb_publish', user: 'cosb_user', password: 'cosb_password',
  follow: 'cosb_follow', // JSON array: up to FOLLOW_MAX calls to compare against
};
const FOLLOW_MAX = 3;

function resolveCosbConfig(env = process.env) {
  const id = parseInt(env.COSB_CONTEST_ID || '', 10);
  return {
    enabled: String(env.COSB_ENABLED || '').toLowerCase() !== 'false',
    contestId: Number.isFinite(id) && id > 0 ? id : null,
    hamdataUrl: resolveHamdataUrl(env, config),
  };
}

// A score's captured_at -> ms. insertScoreBreakdown() stamps an ISO string
// ("2026-11-28T07:10:19.816Z"); an older SQLite datetime('now') value
// ("2026-11-28 07:10:19", UTC, no zone marker) is read as UTC too.
function sqliteMs(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(str.slice(10))) return new Date(str).getTime();
  return new Date(str.replace(' ', 'T') + 'Z').getTime();
}

// One call anywhere on the board -> { sec, row } or null.
function findStation(st, call) {
  for (const sec of (st && st.sections) || []) {
    const row = sec.rows.find((r) => r.call === call);
    if (row) return { sec, row };
  }
  return null;
}

// The stations the board follows (Admin, CJ 2026-11-28), each found
// wherever it is on COSB -- any category, not only ours -- with its gap to
// us in points (positive = ahead of us). Not on the board: found: false.
function followRows(st, call, follow) {
  const mine = findStation(st, String(call || '').toUpperCase());
  const myScore = mine && mine.row.score != null ? mine.row.score : null;
  return (follow || []).map((c) => {
    const hit = findStation(st, c);
    if (!hit) return { call: c, found: false };
    const { sec, row } = hit;
    return {
      call: c, found: true, op: row.op, section: sec.label, rank: row.rank, count: sec.rows.length,
      score: row.score, qsos: row.qsos, mult: row.mult, last: row.last,
      gap: row.score != null && myScore != null ? row.score - myScore : null,
    };
  });
}

// The panel's view of one COSB scoreboard for one station: its category,
// the top TOP_N and the AROUND stations either side of it, each with its
// gap to us in points (positive = ahead of us). `break` marks a row that
// doesn't follow on from the one before (a "..." in the table).
function buildView(st, call, follow = []) {
  if (!st || !st.contest) return { status: 'no_contest' };
  const me = String(call || '').toUpperCase();
  const base = {
    contest: st.contest, updated: st.updated || null, fetched_at: st.fetched_at || null,
    follow: followRows(st, me, follow),
  };
  for (const sec of st.sections || []) {
    const i = sec.rows.findIndex((r) => r.call === me);
    if (i < 0) continue;
    const mine = sec.rows[i];
    const pick = new Set();
    for (let k = 0; k < Math.min(TOP_N, sec.rows.length); k++) pick.add(k);
    for (let k = Math.max(0, i - AROUND); k <= Math.min(sec.rows.length - 1, i + AROUND); k++) pick.add(k);
    const idx = [...pick].sort((a, b) => a - b);
    const rows = idx.map((k, n) => {
      const r = sec.rows[k];
      return {
        ...r,
        me: k === i,
        gap: r.score != null && mine.score != null ? r.score - mine.score : null,
        break: n > 0 && k !== idx[n - 1] + 1,
      };
    });
    // Scoped boards (scope.js) can carry us as an `outside` row: shown,
    // not counted, not ranked.
    const lead = sec.rows.find((r) => !r.outside) || sec.rows[0];
    return {
      ...base,
      status: 'ok',
      section: sec.label,
      count: sec.rows.filter((r) => !r.outside).length,
      rank: mine.rank,
      outside: Boolean(mine.outside),
      leader_gap: lead.score != null && mine.score != null ? lead.score - mine.score : null,
      rows,
    };
  }
  return { ...base, status: 'not_listed', call: me };
}

// The <dynamicresults> document out of a Score packet -- N1MM can wrap it
// in <rtc> (see src/parsers/score.js); COSB wants the bare root.
function dynamicResultsXml(buf) {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
  const m = s.match(/<dynamicresults\b[\s\S]*<\/dynamicresults>/i);
  return m ? `<?xml version="1.0"?>\n${m[0]}` : null;
}

function createCosbService({ io = null, emitter = null, env = process.env, deps = {} } = {}) {
  const cfg = resolveCosbConfig(env);
  const now = deps.now || Date.now;
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const latestScore = deps.getLatestScore || getLatestScore;
  const get = deps.getSetting || getSetting;
  const set = deps.setSetting || setSetting;
  const postUrl = deps.postUrl || `${COSB_BASE}/post/`;

  // Continent / CQ zone of a call, for scoped standings (scope.js).
  const locate = deps.locate || (() => {
    const { resolveCall } = require('../analyze/geo');
    const { getCachedLocation } = require('../db/queries');
    return createLocator({ resolveCall, getCachedLocation, now });
  })();

  let source = deps.source || null;
  if (!source) {
    if (cfg.hamdataUrl) {
      const hd = createHamdataClient({ url: cfg.hamdataUrl, fetchImpl: deps.fetchImpl });
      source = { standings: (q) => hd.cosbStandings(q), contestStatus: (q) => hd.cosbContestStatus(q) };
    } else {
      source = createCosbSource({ fetchImpl: deps.fetchImpl, now });
    }
  }

  let view = { status: cfg.enabled ? 'off' : 'disabled' };
  let timer = null;
  let polling = false;

  const standingsOn = () => get(KEYS.standings) === '1';

  // The followed calls, as stored (Admin). Bad JSON reads as none.
  function getFollow() {
    try {
      const v = JSON.parse(get(KEYS.follow) || '[]');
      return Array.isArray(v) ? v.slice(0, FOLLOW_MAX) : [];
    } catch { return []; }
  }

  // The last board and call, so a change to the follow list shows at once
  // instead of on the next poll.
  let lastSt = null;
  let lastCall = null;

  async function poll() {
    if (!cfg.enabled || polling) return view;
    if (!standingsOn()) {
      if (view.status !== 'off') { view = { status: 'off' }; emit(); }
      return view;
    }
    const score = latestScore();
    if (!score || !(now() - sqliteMs(score.captured_at) < ACTIVE_MS) || !score.call) {
      if (view.status !== 'idle') { view = { status: 'idle' }; emit(); }
      return view;
    }
    polling = true;
    try {
      const st = await source.standings({ contest: score.contest, contestId: cfg.contestId });
      lastSt = st;
      lastCall = score.call;
      view = { ...buildView(st, score.call, getFollow()), logger_contest: score.contest };
      if (view.status === 'ok') {
        const sec = st.sections.find((s) => s.label === view.section);
        view = { ...view, scope: 'world', scope_label: 'World', scopes: scopeChoices(sec, locate) };
      }
    } catch (err) {
      // Keep the last good table, flagged, rather than blanking the panel.
      view = { ...view, error: err.message, error_at: new Date(now()).toISOString() };
      console.error(`cosb: standings: ${err.message}`);
    } finally {
      polling = false;
    }
    if (view.status === 'ok' && !view.error) delete view.error;
    emit();
    return view;
  }

  function emit() { if (io) io.emit('cosb:update', getView()); }
  // The view, or (scope: "cont:EU", "zone:5" -- scope.js) the same view
  // built from the board cut down to that scope. The followed stations stay
  // as on the whole board.
  function getView(scope) {
    if (!scope || scope === 'world' || !isScope(scope) || !lastSt || view.status !== 'ok') return view;
    const me = String(lastCall || '').toUpperCase();
    const scoped = buildView(scopeBoard(lastSt, scope, locate, me), me, []);
    return {
      ...scoped,
      follow: view.follow,
      logger_contest: view.logger_contest,
      scope,
      scope_label: scopeLabel(scope),
      scopes: view.scopes,
      ...(view.error ? { error: view.error, error_at: view.error_at } : {}),
    };
  }

  // Admin page switch for the standings card.
  async function setStandings(on) {
    set(KEYS.standings, on ? '1' : '0');
    if (!on) { view = { status: 'off' }; emit(); return view; }
    view = { status: 'idle' };
    return poll();
  }

  // Admin: the calls to follow. `calls` is already validated (routes/api.js);
  // stored uppercase, deduped, at most FOLLOW_MAX.
  function setFollow(calls) {
    const list = [...new Set((calls || []).map((c) => String(c).trim().toUpperCase()).filter(Boolean))].slice(0, FOLLOW_MAX);
    set(KEYS.follow, JSON.stringify(list));
    if (lastSt && view.contest) {
      view = { ...view, follow: followRows(lastSt, lastCall, list) };
      emit();
    }
    return list;
  }

  // ---- publishing ------------------------------------------------------

  function publishConfig() {
    const envUser = env.COSB_USER || '';
    const envPass = env.COSB_PASSWORD || '';
    if (envUser && envPass) {
      return { enabled: true, user: envUser, password: envPass, from_env: true };
    }
    return {
      enabled: get(KEYS.publish) === '1',
      user: get(KEYS.user) || '',
      password: get(KEYS.password) || '',
      from_env: false,
    };
  }

  let pending = null; // newest XML not yet sent
  let contestState = null; // last { contest, fetched_at } from contestStatus
  let lastPostAt = 0;
  let pubTimer = null;
  let posting = false;
  let lastResult = null;

  function onScore(_data, buf) {
    const pc = publishConfig();
    if (!pc.enabled || !pc.user || !pc.password || !buf) return;
    const xml = dynamicResultsXml(buf);
    if (!xml) return;
    pending = xml;
    schedule();
  }

  function schedule() {
    if (pubTimer || posting || !pending) return;
    const wait = Math.max(0, lastPostAt + PUBLISH_MIN_MS - now());
    pubTimer = setTimeout(() => { pubTimer = null; flush(); }, wait);
    if (pubTimer.unref) pubTimer.unref();
  }

  async function flush() {
    const pc = publishConfig();
    if (!pending || !pc.enabled || !pc.user || !pc.password) { pending = null; return lastResult; }
    const body = pending;
    pending = null;
    posting = true;
    lastPostAt = now();
    const at = new Date(lastPostAt).toISOString();
    // COSB takes posts only while the contest is on air (CJ, 2026-11-28):
    // ask first, and skip -- not fail -- when it isn't. If the status can't
    // be had (COSB or hamdata down), post anyway and let COSB decide.
    const loggerContest = (body.match(/<contest>([^<]*)<\/contest>/i) || [])[1] || '';
    if (source.contestStatus) {
      try {
        contestState = await source.contestStatus({ contest: loggerContest, contestId: cfg.contestId });
        const c = contestState && contestState.contest;
        if (!c || c.status !== 'on_air') {
          const why = c ? `${c.name} is ${c.status === 'coming' ? 'not on air yet' : 'closed'} on COSB` : `COSB has no contest for ${loggerContest || 'this log'}`;
          lastResult = { at, ok: false, skipped: true, status: 'not_on_air', message: why };
          posting = false;
          schedule();
          return lastResult;
        }
      } catch (err) {
        console.error(`cosb: contest status: ${err.message}`);
      }
    }
    try {
      const res = await doFetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Authorization: `Basic ${Buffer.from(`${pc.user}:${pc.password}`).toString('base64')}`,
          'User-Agent': 'contestscore',
        },
        body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      const raw = await res.text();
      let msg = raw.trim().slice(0, 200);
      let status = res.status;
      try {
        const j = JSON.parse(raw);
        if (j && j.status != null) status = Number(j.status) || status;
        if (j && j.status_message) msg = String(j.status_message).slice(0, 200);
      } catch { /* not JSON */ }
      const ok = res.ok && status === 200;
      lastResult = { at, ok, status, message: msg };
      if (!ok) console.error(`cosb: publish: ${status} ${msg}`);
    } catch (err) {
      lastResult = { at, ok: false, status: null, message: err.message };
      console.error(`cosb: publish: ${err.message}`);
    } finally {
      posting = false;
    }
    schedule(); // anything that arrived while posting goes out next window
    return lastResult;
  }

  function getPublishStatus() {
    const pc = publishConfig();
    return {
      enabled: pc.enabled,
      user: pc.user,
      has_password: Boolean(pc.password),
      from_env: pc.from_env,
      min_interval_sec: PUBLISH_MIN_MS / 1000,
      last: lastResult,
      contest: contestState ? contestState.contest : null,
    };
  }

  // Admin page save. `password` omitted/empty keeps the stored one.
  function setPublish({ enabled, user, password }) {
    if (user != null) set(KEYS.user, String(user).trim().toUpperCase());
    if (password) set(KEYS.password, String(password));
    if (enabled != null) set(KEYS.publish, enabled ? '1' : '0');
    if (enabled === false) pending = null;
    return getPublishStatus();
  }

  function start() {
    if (emitter) emitter.on('score:update', onScore);
    if (!cfg.enabled) return api;
    // First look shortly after boot (the DB already knows the contest).
    const first = setTimeout(() => poll().catch(() => {}), 5000);
    if (first.unref) first.unref();
    timer = setInterval(() => poll().catch(() => {}), POLL_MS);
    if (timer.unref) timer.unref();
    return api;
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (pubTimer) clearTimeout(pubTimer);
    if (emitter) emitter.off('score:update', onScore);
  }

  function getStandingsStatus() {
    return { available: cfg.enabled, enabled: cfg.enabled && standingsOn() };
  }

  const api = {
    start, stop, poll, getView, getStandingsStatus, setStandings, getFollow, setFollow,
    getPublishStatus, setPublish, onScore, flush, config: cfg,
  };
  return api;
}

module.exports = { createCosbService, resolveCosbConfig, buildView, followRows, dynamicResultsXml, sqliteMs, KEYS, FOLLOW_MAX };
