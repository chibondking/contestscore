#!/usr/bin/env node
'use strict';

// contestscore TUI -- a terminal front end for the live results dashboard
// (public/index.html), for watching a contest over SSH on a headless box
// with no browser in the way.
//
// It is a *client only*: nothing in src/ knows this file exists. Everything
// here comes off the same public read-only surface the browser page uses --
// GET /api/{qsos,score,score/history,radios,rate,bridges,solar} for the
// initial load, then the socket.io events for live updates. No DB access,
// no imports out of src/, so it runs just as happily against a remote
// instance (CONTESTSCORE_URL=https://scoreboard.example.com) as against
// localhost.
//
// The derivations below (scoreStale, operatorStats, continentCounts,
// radioLabel, the mult-bell rules, bandLabel) are deliberately COPIED from
// public/js/dashboard.js rather than shared with it. They live inside
// dashboard()'s closure in a classic browser script with no module system
// (see CLAUDE.md on why no page script is type="module"), so sharing them
// would mean refactoring the page this is only meant to mirror -- same
// reasoning report.js/compare.js already use for their own copies of
// bandLabel. If the dashboard's version of one of these changes, change it
// here too.
//
// Deliberately NOT here: the Admin page (DELETE /api/db and the lookup kill
// switch -- a destructive, token-gated surface with no business behind a
// single keystroke in a terminal), the world map, and Possible Busts.
//
// Keys: q quit · b toggle mult bell · r force refresh

const { io } = require('socket.io-client');

// --- config ---------------------------------------------------------------

const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}
const BASE = (argVal('--url') || process.env.CONTESTSCORE_URL || 'http://localhost:3000')
  .replace(/\/+$/, '');
// A one-shot plain-text snapshot instead of a live screen: --once, or any
// time stdout isn't a terminal (`node tui/index.js | cat`, a cron check).
const ONCE = argv.includes('--once') || !process.stdout.isTTY;

// --- terminal primitives --------------------------------------------------

const COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const sgr = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = sgr('1');
const dim = sgr('2');
const red = sgr('31');
const green = sgr('32');
const yellow = sgr('33');
const cyan = sgr('36');
const magenta = sgr('35');

// Every pad/clip below measures *visible* width, so a cell can already be
// colored when it gets laid out -- otherwise the escape bytes count toward
// the column width and every table after the first color drifts.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const vlen = (s) => String(s).replace(ANSI_RE, '').length;

function padEnd(s, n) {
  const gap = n - vlen(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
function padStart(s, n) {
  const gap = n - vlen(s);
  return gap > 0 ? ' '.repeat(gap) + s : s;
}
// Truncate to n visible columns, stepping over escape sequences rather than
// through them (a clip landing mid-sequence would leak "[32m" onto screen).
function clip(s, n) {
  const str = String(s);
  if (vlen(str) <= n) return str;
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < str.length && vis < n) {
    if (str[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(str.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += str[i];
    i += 1;
    vis += 1;
  }
  return out + (COLOR ? '\x1b[0m' : '');
}

function rule(title, width) {
  const label = title ? ` ${bold(title)} ` : '';
  return clip(dim('─') + label + dim('─'.repeat(Math.max(0, width - vlen(label) - 1))), width);
}

// Two columns from two arrays of pre-built lines; the shorter side just runs
// out. Used for Score|Rate, the one place where a wide terminal is worth the
// extra layout code.
function twoCol(left, right, leftWidth, width, gap = 3) {
  const rightWidth = Math.max(0, width - leftWidth - gap);
  const out = [];
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = clip(left[i] || '', leftWidth);
    if (rightWidth <= 8) { out.push(l); continue; } // too narrow to split
    out.push(padEnd(l, leftWidth) + ' '.repeat(gap) + clip(right[i] || '', rightWidth));
  }
  return out;
}

const SPARKS = '▁▂▃▄▅▆▇█';
// Bucket-average down to `width` columns so a 48-hour series still fits a
// card-sized strip, same spirit as the browser's Chart.js sparklines.
function sparkline(values, width) {
  const v = values.map(Number).filter(Number.isFinite);
  if (v.length < 2 || width < 2) return '';
  const w = Math.min(width, v.length);
  const pts = [];
  for (let i = 0; i < w; i += 1) {
    const from = Math.floor((i * v.length) / w);
    const to = Math.max(from + 1, Math.floor(((i + 1) * v.length) / w));
    const slice = v.slice(from, to);
    pts.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo;
  return pts
    .map((p) => SPARKS[span === 0 ? 0 : Math.min(7, Math.floor(((p - lo) / span) * 8))])
    .join('');
}

const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '—');

// --- copied from public/js/dashboard.js (see header comment) --------------

function bandLabel(band) {
  const n = parseFloat(band);
  if (Number.isNaN(n)) return band || '—';
  const ranges = [
    [1.7, 2.1, '160m'], [3.4, 4.1, '80m'], [5.2, 5.5, '60m'], [6.9, 7.4, '40m'],
    [10.0, 10.2, '30m'], [13.9, 14.5, '20m'], [18.0, 18.2, '17m'], [20.9, 21.5, '15m'],
    [24.8, 25.1, '12m'], [27.9, 29.8, '10m'], [49, 55, '6m'], [69, 75, '4m'],
    [143, 149, '2m'], [218, 226, '1.25m'], [419, 451, '70cm'],
  ];
  const hit = ranges.find(([lo, hi]) => n >= lo && n < hi);
  return hit ? hit[2] : String(band);
}

// An X-QSO (N1MM's IsClaimedQso 0) stays in the log, marked, but counts
// toward nothing: no totals, rates, operator stats or continents.
const isCountedQso = (q) => q.is_claimed_qso == null || Number(q.is_claimed_qso) !== 0;
// WAE QTCs ride in exchange1 as "SQTC"/"RQTC" -- relayed traffic, not a
// contact, so never a mult however the packet is flagged.
const isQtc = (q) => /QTC/i.test(q.exchange1 || '');
const isMult = (q) => !isQtc(q) && !!(q.is_mult1 || q.is_mult2 || q.is_mult3);
// DXLog sends Score on its online-scoreboard timer, not per QSO.
const isDelayedScoreSource = (soft) => /^dxlog/i.test(String(soft || ''));
const DXLOG_MIN_GAP_MS = 90 * 1000;
const DXLOG_MAX_GAP_MS = 45 * 60 * 1000;

const MULTBELL_COOLDOWN_MS = 2000;
const MULTBELL_MAX_AGE_MS = 15 * 60 * 1000;

function multBellShouldRing({ settings, isNew, isMult: mult, counted, multCount, n1mmAgeMs, msSinceLastDing }) {
  if (!settings || !settings.enabled) return false;
  if (!isNew || !mult || !counted) return false;
  if (!(multCount > settings.after)) return false;
  if (n1mmAgeMs != null && n1mmAgeMs > MULTBELL_MAX_AGE_MS) return false;
  if (msSinceLastDing != null && msSinceLastDing < MULTBELL_COOLDOWN_MS) return false;
  return true;
}

// N1MM's "2026-09-16 14:23:05" (UTC) -> epoch ms, or null.
function n1mmTimestampMs(ts) {
  if (!ts) return null;
  const t = new Date(String(ts).trim().replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? null : t;
}
const loggedAtMs = (q) => (q.logged_at ? n1mmTimestampMs(q.logged_at) : null);

// --- state ----------------------------------------------------------------

const state = {
  connected: false,
  score: {},
  scoreHistory: [],
  radios: [],
  qsos: [],
  rate: [],
  bridges: [],
  solar: { updated: null },
  lastUpdateAt: Date.now(),
  error: null,
};

// Mult bell: off unless asked for, same default as the browser's. Toggled
// live with `b`; CONTESTSCORE_TUI_BELL / _BELL_AFTER set the startup value
// (no localStorage equivalent here, and a dotfile felt like more state than
// a view-only tool should own).
const bell = {
  enabled: /^(1|true|on|yes)$/i.test(process.env.CONTESTSCORE_TUI_BELL || ''),
  after: Math.max(0, Math.floor(Number(process.env.CONTESTSCORE_TUI_BELL_AFTER)) || 0),
};
let lastDingAt = null;

const countedQsos = () => state.qsos.filter(isCountedQso);

// --- derivations (copied; see header comment) -----------------------------

// The call the station is transmitting under -- mycall, never operator/ops.
// qsos is newest-first, so the first row with a mycall follows a mid-contest
// change; score.call covers a start before any QSO is logged.
function stationCall() {
  const q = state.qsos.find((row) => row.mycall);
  return (q && q.mycall) || state.score.call || '';
}

const scoreIsDelayed = () => isDelayedScoreSource(state.score.soft);

// NOT a count comparison (qsos.length > score.qsos): a genuine dupe is a
// real row in the live log that N1MM's own qso tally excludes, which pins
// such a check "stale" forever. Compare timestamps -- a QSO landed after
// the score's captured_at, and long enough ago that a fresh snapshot (~10s
// cadence) should have caught up.
function scoreStale() {
  if (scoreIsDelayed()) return false;
  if (!state.score.captured_at || state.qsos.length === 0) return false;
  const capturedAt = new Date(state.score.captured_at).getTime();
  const lastQsoAt = loggedAtMs(state.qsos[0]);
  if (lastQsoAt == null) return false;
  return lastQsoAt > capturedAt && Date.now() - capturedAt > 30000;
}

// Median of DXLog's recent Score gaps, in whole minutes. Its timer runs
// 2-30 min, so a sub-90s gap is a manual push and a 45-min-plus one is a
// pause or restart; both ignored.
function scoreIntervalMinutes() {
  const times = state.scoreHistory
    .filter((r) => isDelayedScoreSource(r.soft))
    .map((r) => new Date(r.captured_at).getTime())
    .filter((t) => !Number.isNaN(t));
  const gaps = times.slice(1).map((t, i) => t - times[i])
    .filter((g) => g >= DXLOG_MIN_GAP_MS && g <= DXLOG_MAX_GAP_MS)
    .slice(-6)
    .sort((a, b) => a - b);
  if (gaps.length < 2) return null;
  return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / 60000));
}

function continentCounts() {
  const counts = {};
  for (const q of countedQsos()) {
    const c = (q.continent || '').trim().toUpperCase();
    if (c) counts[c] = (counts[c] || 0) + 1;
  }
  return counts;
}

// Peak rate keys off a 60-minute bucket (N1MM's own hourly-rate convention);
// a 60-minute bucket's count already *is* the rate/hr, unlike the 10-minute
// column, which is extrapolated and noisier on purpose.
function operatorStats() {
  const byOp = new Map();
  for (const q of countedQsos()) {
    const op = q.operator || '—';
    if (!byOp.has(op)) byOp.set(op, { operator: op, qsos: 0, points: 0, b60: new Map(), b10: new Map() });
    const entry = byOp.get(op);
    entry.qsos += 1;
    entry.points += Number(q.points) || 0;
    const t = loggedAtMs(q);
    if (t != null) {
      const k60 = Math.floor(t / 3600000) * 3600000;
      entry.b60.set(k60, (entry.b60.get(k60) || 0) + 1);
      const k10 = Math.floor(t / 600000) * 600000;
      entry.b10.set(k10, (entry.b10.get(k10) || 0) + 1);
    }
  }
  return [...byOp.values()]
    .map((e) => ({
      operator: e.operator,
      qsos: e.qsos,
      points: e.points,
      peakRate60: Math.max(0, ...e.b60.values()),
      peakRate10: Math.round(Math.max(0, ...e.b10.values()) * 6),
    }))
    .sort((a, b) => b.qsos - a.qsos);
}

function autoBucketMinutes() {
  const times = countedQsos().map(loggedAtMs).filter((t) => t != null);
  if (times.length < 2) return 15;
  const spanMinutes = (Math.max(...times) - Math.min(...times)) / 60000;
  const sizes = [5, 10, 15, 30, 60, 120];
  return sizes.find((m) => spanMinutes / m <= 30) || 120;
}

function rateOverTime() {
  const bucketMinutes = autoBucketMinutes();
  const bucketMs = bucketMinutes * 60000;
  const counts = new Map();
  for (const q of countedQsos()) {
    const t = loggedAtMs(q);
    if (t == null) continue;
    const bucket = Math.floor(t / bucketMs) * bucketMs;
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  const perHour = 60 / bucketMinutes;
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => Math.round(n * perHour));
}

// "R1" for the ordinary single-station case; prefixed with the station name
// once more than one station reports, since N1MM's RadioNr is only unique
// within one PC's own config.
function radioLabel(r) {
  if (r.radio_nr == null) return '—';
  const stations = new Set(state.radios.map((x) => x.station_name || ''));
  return stations.size > 1 && r.station_name ? `${r.station_name} R${r.radio_nr}` : `R${r.radio_nr}`;
}

// N1MM's own mult total or the flagged QSOs in the live log, whichever is
// higher -- the Score snapshot lags, and a logger with no <mult> breakdown
// leaves score.mults null.
function multCount() {
  const logged = state.qsos.filter((q) => isCountedQso(q) && isMult(q)).length;
  const reported = Number(state.score.mults);
  return Math.max(logged, Number.isFinite(reported) ? reported : 0);
}

// --- data -----------------------------------------------------------------

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function loadAll() {
  const want = [
    ['/api/qsos', 'qsos', []],
    ['/api/score', 'score', {}],
    ['/api/score/history', 'scoreHistory', []],
    ['/api/radios', 'radios', []],
    ['/api/rate', 'rate', []],
    ['/api/bridges', 'bridges', []],
    ['/api/solar', 'solar', { updated: null }],
  ];
  const results = await Promise.all(want.map(([path]) => getJson(path).catch((err) => err)));
  let failed = null;
  results.forEach((value, i) => {
    const [, key, fallback] = want[i];
    if (value instanceof Error) { failed = value; state[key] = state[key] ?? fallback; return; }
    state[key] = value;
  });
  state.error = failed ? failed.message : null;
  touch();
}

// The rate windows decay with wall-clock time alone, so they need re-fetching
// on a timer even when nothing is happening -- and a burst of contact:new
// shouldn't fire one request each.
let rateTimer = null;
function refreshRateSoon() {
  if (rateTimer) return;
  rateTimer = setTimeout(async () => {
    rateTimer = null;
    try { state.rate = await getJson('/api/rate'); touch(); } catch { /* keep last */ }
  }, 1500);
}

// Only feeds the Score sparkline, and the table grows a row every ~10s all
// contest, so this is throttled well below the browser's refetch-on-every-
// score:update.
let historyAt = 0;
async function refreshHistorySoon() {
  if (Date.now() - historyAt < 30000) return;
  historyAt = Date.now();
  try { state.scoreHistory = await getJson('/api/score/history'); touch(); } catch { /* keep last */ }
}

function maybeRingBell(q, isNew) {
  const now = Date.now();
  const t = n1mmTimestampMs(q.n1mm_timestamp);
  const ok = multBellShouldRing({
    settings: bell,
    isNew,
    isMult: isMult(q),
    counted: isCountedQso(q),
    multCount: multCount(),
    n1mmAgeMs: t == null ? null : now - t,
    msSinceLastDing: lastDingAt == null ? null : now - lastDingAt,
  });
  if (!ok) return;
  lastDingAt = now;
  process.stdout.write('\x07'); // the terminal's own bell -- no Web Audio to mimic
}

function wireSocket() {
  const socket = io(BASE, { transports: ['websocket', 'polling'], reconnectionDelayMax: 10000 });

  // A reconnect re-syncs from REST: whatever happened during the gap arrived
  // as events nobody was listening for. The first connect doesn't, since
  // main() has just loaded everything.
  let connects = 0;
  socket.on('connect', () => {
    state.connected = true;
    state.error = null;
    connects += 1;
    if (connects > 1) loadAll();
    touch();
  });
  socket.on('disconnect', () => { state.connected = false; touch(); });
  socket.on('connect_error', (err) => { state.connected = false; state.error = err.message; touch(); });

  socket.on('radio:update', (data) => {
    const idx = state.radios.findIndex((r) => (
      (r.station_name || '') === (data.station_name || '') && r.radio_nr === data.radio_nr
    ));
    if (idx >= 0) state.radios[idx] = data;
    else state.radios.push(data);
    touch();
  });

  socket.on('contact:new', (data) => {
    // A contactreplace edit re-emits contact:new with the same ext_id --
    // update in place rather than prepending a second copy.
    const idx = data.ext_id ? state.qsos.findIndex((q) => q.ext_id === data.ext_id) : -1;
    if (idx >= 0) state.qsos[idx] = data;
    else state.qsos.unshift(data);
    maybeRingBell(data, idx < 0); // after the update, so multCount() counts this one
    refreshRateSoon();
    touch();
  });

  socket.on('contact:delete', (data) => {
    state.qsos = state.qsos.filter((q) => (
      data.ext_id ? q.ext_id !== data.ext_id : !(q.call === data.call && q.band === data.band)
    ));
    refreshRateSoon();
    touch();
  });

  socket.on('score:update', (data) => { state.score = data; refreshHistorySoon(); touch(); });
  socket.on('solar:update', (data) => { if (data) state.solar = data; touch(); });

  socket.on('bridge:status', (data) => {
    const idx = state.bridges.findIndex((b) => b.station_id === data.station_id);
    if (idx >= 0) state.bridges[idx] = data;
    else state.bridges.push(data);
    touch();
  });

  socket.on('db:cleared', () => {
    state.qsos = [];
    state.score = {};
    state.scoreHistory = [];
    state.radios = [];
    refreshRateSoon(); // the trailing windows should drop to zero, not linger
    touch();
  });

  return socket;
}

// --- render ---------------------------------------------------------------

const CONTINENTS = ['NA', 'EU', 'AS', 'AF', 'OC', 'SA', 'AN'];

function qsoTime(q) {
  const m = /(\d{2}):(\d{2})/.exec(String(q.n1mm_timestamp || q.logged_at || '').slice(10));
  return m ? `${m[1]}:${m[2]}` : '--:--';
}

function bridgeChip(b) {
  const paint = b.status === 'realtime' ? green : b.status === 'stale' ? yellow : red;
  return paint(`${b.station_id}:${b.status}`);
}

function headerLine(width) {
  const left = [bold(new Date().toISOString().slice(11, 19) + 'Z')];
  const call = stationCall();
  if (call) left.push(bold(cyan(call)));
  if (state.score.contest) left.push(state.score.contest);
  if (state.score.grid6) left.push(dim(state.score.grid6));
  if (state.solar.updated) {
    const s = state.solar;
    left.push(dim(`SFI ${s.sfi ?? '—'} A ${s.a ?? '—'} K ${s.k ?? '—'}`));
  }

  const right = [];
  for (const b of state.bridges) right.push(bridgeChip(b));
  right.push(dim(`upd ${Math.max(0, Math.round((Date.now() - state.lastUpdateAt) / 1000))}s`));
  right.push(ONCE ? dim('snapshot') : state.connected ? green('live') : red('offline'));
  right.push(bell.enabled ? yellow(`bell>${bell.after}`) : dim('bell off'));

  // Status sits on the right and stays put; the left group is what gets
  // clipped on a narrow terminal, since the clock/contest matter least.
  const r = right.join('  ');
  const room = width - vlen(r) - 2;
  return padEnd(clip(left.join('  '), Math.max(0, room)), Math.max(0, room)) + '  ' + r;
}

function scoreLines(width) {
  const metrics = [
    `${dim('QSOs')} ${bold(fmt(state.score.qsos))}`,
    `${dim('Mults')} ${bold(fmt(state.score.mults))}`,
    `${dim('Total')} ${bold(green(fmt(state.score.total)))}`,
  ].join('   ');
  return [
    scoreStale() ? `${metrics}  ${yellow('catching up')}` : metrics,
    dim(sparkline(state.scoreHistory.map((r) => r.score_total), Math.min(width, 48))),
  ];
}

function rateLines(width) {
  const metrics = state.rate.length
    ? state.rate.map((r) => `${dim(`${r.minutes}m`)} ${bold(fmt(r.rate_per_hour))}${dim('/hr')}`).join('   ')
    : dim('no rate data yet');
  return [metrics, dim(sparkline(rateOverTime(), Math.min(width, 48)))];
}

function radioLines(width, max) {
  if (!state.radios.length) return [dim('no radio data yet')];
  return state.radios.slice(0, max).map((r) => {
    // Band only, never the exact frequency -- the server strips freq/tx_freq
    // before they reach any viewer (src/routes/api.js), so there is nothing
    // finer to show here even if we wanted it.
    const tx = r.is_transmitting ? red('●') : green('○');
    const row = [
      padEnd(bold(radioLabel(r)), 8),
      padEnd(r.band || '—', 6),
      padEnd(r.mode || '—', 5),
      tx,
      padEnd(r.op_call || '—', 9),
      r.is_running ? cyan('RUN') : '   ',
      // N1MM never clears FunctionKeyCaption between transmissions, so it is
      // only meaningful while actually keying.
      r.is_transmitting && r.function_key_caption ? dim(r.function_key_caption) : '',
    ].join(' ');
    return clip(row, width);
  });
}

function continentLine(width) {
  const counts = continentCounts();
  const parts = CONTINENTS.filter((c) => counts[c]).map((c) => `${dim(c)} ${bold(fmt(counts[c]))}`);
  return clip(parts.length ? parts.join('   ') : dim('no continent data yet'), width);
}

function operatorLines(width, max) {
  const ops = operatorStats();
  if (!ops.length) return [dim('no QSOs logged yet')];
  const head = dim(padEnd('OPERATOR', 12) + padStart('QSOS', 6) + padStart('PTS', 8) + padStart('60m/hr', 9) + padStart('10m/hr', 9));
  const rows = ops.slice(0, max).map((op) => clip(
    padEnd(bold(op.operator), 12) + padStart(fmt(op.qsos), 6) + padStart(fmt(op.points), 8)
    + padStart(fmt(op.peakRate60), 9) + padStart(fmt(op.peakRate10), 9),
    width,
  ));
  return [head, ...rows];
}

function qsoLines(width, max) {
  if (!state.qsos.length) return [dim('no QSOs logged yet')];
  const head = dim(padEnd('TIME', 7) + padEnd('CALL', 12) + padEnd('BAND', 6) + padEnd('MODE', 5) + padEnd('OP', 10) + padStart('PTS', 4) + '  FLAGS');
  const rows = state.qsos.slice(0, Math.max(0, max)).map((q) => {
    const flags = [];
    if (!isCountedQso(q)) flags.push(red('X-QSO'));
    if (isQtc(q)) flags.push(dim('QTC'));
    if (isMult(q)) flags.push(magenta('MULT'));
    const call = isCountedQso(q) ? bold(q.call || '—') : dim(q.call || '—');
    return clip(
      padEnd(dim(qsoTime(q)), 7) + padEnd(call, 12) + padEnd(bandLabel(q.band), 6)
      + padEnd(q.mode || '—', 5) + padEnd(q.operator || '—', 10)
      + padStart(fmt(q.points), 4) + '  ' + flags.join(' '),
      width,
    );
  });
  return [head, ...rows];
}

function scoreTitle() {
  if (!scoreIsDelayed()) return 'SCORE';
  const m = scoreIntervalMinutes();
  return m ? `SCORE (DXLog · every ~${m} min)` : 'SCORE (DXLog · delayed)';
}

function buildLines(width, height) {
  const leftWidth = Math.floor((width - 3) * 0.52);
  const lines = [headerLine(width)];

  lines.push(...twoCol([rule(scoreTitle(), leftWidth)], [rule('RATE', width - leftWidth - 3)], leftWidth, width));
  lines.push(...twoCol(scoreLines(leftWidth), rateLines(width - leftWidth - 3), leftWidth, width));

  lines.push(rule('RADIOS', width));
  lines.push(...radioLines(width, 6));

  lines.push(rule('BY CONTINENT', width));
  lines.push(continentLine(width));

  lines.push(rule('OPERATORS', width));
  lines.push(...operatorLines(width, 6));

  lines.push(rule('RECENT QSOS', width));
  // Whatever vertical space is left after the fixed sections and the footer.
  const room = height - lines.length - 2;
  lines.push(...qsoLines(width, Math.max(1, room)));

  const footer = state.error
    ? red(`! ${state.error}`)
    : dim(`${BASE}   q quit · b bell · r refresh`);
  while (lines.length < height - 1) lines.push('');
  return [...lines.slice(0, height - 1), clip(footer, width)];
}

let dirty = true;
function touch() {
  state.lastUpdateAt = Date.now();
  dirty = true;
}

function render() {
  const width = Math.max(40, process.stdout.columns || 80);
  const height = Math.max(12, process.stdout.rows || 24);
  // Home the cursor and clear each line as it is rewritten, rather than
  // clearing the screen first -- a full clear flickers visibly on a slow SSH
  // link, which is exactly where this gets used.
  const body = buildLines(width, height).map((l) => clip(l, width) + '\x1b[K').join('\n');
  process.stdout.write('\x1b[H' + body + '\x1b[J');
}

// --- lifecycle ------------------------------------------------------------

function enterTui() {
  process.stdout.write('\x1b[?1049h\x1b[?25l'); // alternate screen, hide cursor
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
  }
}

let exited = false;
function exitTui(code = 0) {
  if (exited) return;
  exited = true;
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.exit(code);
}

async function main() {
  if (ONCE) {
    // No escape codes, no socket: one plain snapshot for a pipe or a quick
    // look, then out.
    await loadAll();
    const lines = buildLines(Math.max(40, process.stdout.columns || 100), 40);
    const footer = lines[lines.length - 1];
    while (lines.length > 1 && lines[lines.length - 2].trim() === '') lines.splice(lines.length - 2, 1);
    console.log(lines.slice(0, -1).concat(footer).join('\n'));
    process.exit(state.error ? 1 : 0);
  }

  enterTui();
  process.on('SIGINT', () => exitTui(0));
  process.on('SIGTERM', () => exitTui(0));
  process.stdout.on('resize', () => { dirty = true; });

  process.stdin.on('data', (key) => {
    if (key === 'q' || key === '\u0003' || key === '\u001a') exitTui(0);
    else if (key === 'b') { bell.enabled = !bell.enabled; dirty = true; }
    else if (key === 'r') loadAll();
  });

  render();
  await loadAll();
  wireSocket();

  setInterval(() => { dirty = true; }, 1000);          // the "upd Ns" ticker and clock
  setInterval(() => { if (dirty) { dirty = false; render(); } }, 150);
  setInterval(refreshRateSoon, 30000);
}

main().catch((err) => {
  exited = true;
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(`contestscore-tui: ${err.message}`);
  process.exit(1);
});
