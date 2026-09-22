#!/usr/bin/env node
/**
 * Turn a submitted Cabrillo log into a snapshot.json that replay.js can
 * play back as live multi-op N1MM traffic -- for rehearsing a real
 * multi-op deployment (ContestPulse, multiple stations, the busts panel,
 * etc.) against a whole real contest's worth of pacing, not just a
 * hand-picked demo snippet.
 *
 * A submitted Cabrillo log is single-station history: no operator
 * attribution, no run/S&P flag, no points, no multiplier flags -- a
 * multi-op reality got flattened into one line per QSO on the way to
 * submission. This script puts a *plausible* version of that back:
 *
 *   - operator:     randomly assigned from the log's OPERATORS: line, in
 *                    blocks of 15-60 consecutive QSOs per radio (a shift,
 *                    not a coin flip every QSO -- an operator doesn't
 *                    change mid-run in real life).
 *   - radio_nr:      read back from the log's own trailing transmitter-ID
 *                     column (multi-transmitter Cabrillo categories carry
 *                     this) -- real per-radio split, not fabricated.
 *   - is_run_qso:    derived from the log's own real timing: consecutive
 *                     QSOs on the same radio within RUN_GAP_MS of each
 *                     other are a run; a bigger gap (band change, hunting
 *                     around) breaks it. Grounded in the actual pacing
 *                     that's already in the log, not randomness.
 *   - points/mults:  an approximate WPX-shaped QSO-point rule (1/2/3 for
 *                     same country / same continent / different
 *                     continent) and a real prefix-multiplier pass (first
 *                     occurrence of each WPX prefix, in chronological
 *                     order, counts once). This is NOT official scoring --
 *                     it exists to give the replay a score that climbs and
 *                     a mult count that occasionally ticks, not to be
 *                     contest-log-checker accurate. See docs/ANALYZER.md
 *                     for why the analyzer itself doesn't attempt real
 *                     Cabrillo scoring.
 *
 * Usage:
 *   node tools/demo/cabrillo-to-snapshot.js <log.txt> [options]
 *
 *   --out <file>       Output path. Default: snapshot-<stamp>.json next to
 *                       this script (same naming replay.js already picks
 *                       up as "newest snapshot" with no argument).
 *   --seed <n>          RNG seed, for a reproducible operator assignment
 *                        across runs. Default: a random seed (printed, so
 *                        you can pass it back in to reproduce a run).
 *   --run-gap <ms>      Gap threshold for the run/S&P heuristic. Default: 90000.
 *   --station-prefix <s> Prefix for synthesized StationName ("<call>-1",
 *                        "<call>-2" by default -- one per radio).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { analyzeLog } = require('../../src/analyze');
const { resolveCall } = require('../../src/analyze/geo');

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const logPath = argv.find((a) => !a.startsWith('--') && (argv.indexOf(a) === 0 || !argv[argv.indexOf(a) - 1].startsWith('--')));
if (!logPath) {
  console.error('Usage: node tools/demo/cabrillo-to-snapshot.js <log.txt> [options]');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const OUT = opt('out', path.join(__dirname, `snapshot-${stamp}.json`));
const RUN_GAP_MS = Number(opt('run-gap', 90000));
const SEED = opt('seed') != null ? Number(opt('seed')) : Math.floor(Math.random() * 2 ** 31);
const STATION_PREFIX = opt('station-prefix', null);

// mulberry32 -- tiny, seedable, no dependency. Deterministic given SEED, so
// --seed <n> reproduces the exact same operator assignment on a re-run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

// ---------------------------------------------------------------------
// Parse the Cabrillo log through the real analyzer -- same geo/exchange
// enrichment (continent, countryprefix, cqzone, rcv/snt) a real upload
// would get. What it can't give us (operator, radio, run flag, points,
// WPX prefix mults) gets synthesized below.
// ---------------------------------------------------------------------
const text = fs.readFileSync(logPath, 'utf8');
const filename = path.basename(logPath);
const { meta, qsos } = analyzeLog(text, filename);

if (!qsos.length) {
  console.error(`No QSOs parsed from ${logPath}`);
  process.exit(1);
}
if (meta.format !== 'cabrillo') {
  console.error(`Expected a Cabrillo log, got format "${meta.format}" (ADIF already carries real operator/run/points data -- feed it straight to a live snapshot instead, or write it to /api/analyze).`);
  process.exit(1);
}

const operators = meta.operators.split(/\s+/).filter(Boolean);
if (!operators.length) {
  console.error(`${logPath} has no OPERATORS: line -- nothing to assign. Add one, or pass real operator names in some other way.`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Recover each QSO's real transmitter-ID (0/1) from the raw text -- the
// analyzer's parser strips it (see cabrillo.js's pickWorkedCall) since it
// only needs it to avoid misreading it as part of the exchange, and never
// stores it. Re-derived here with the identical detection rule, walking
// the same QSO:/X-QSO: lines in the same order, so it zips 1:1 onto the
// analyzer's own (already-filtered, already-ordered) qsos array.
// ---------------------------------------------------------------------
function extractTransmitterIds(rawText) {
  const ids = [];
  for (const raw of rawText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const tag = line.slice(0, colon).toUpperCase();
    if (tag !== 'QSO' && tag !== 'X-QSO') continue;
    if (tag === 'X-QSO') continue; // analyzeLog drops these too -- keep the two lists aligned
    const toks = line.slice(colon + 1).trim().split(/\s+/).filter(Boolean);
    const rest = toks.slice(5); // past freq/mode/date/time/mycall
    const last = rest[rest.length - 1];
    ids.push(rest.length % 2 === 0 && /^[01]$/.test(last) ? Number(last) : 0);
  }
  return ids;
}
const transmitterIds = extractTransmitterIds(text);
if (transmitterIds.length !== qsos.length) {
  console.error(
    `Transmitter-ID extraction (${transmitterIds.length}) doesn't match the analyzer's QSO count `
    + `(${qsos.length}) -- this log's shape isn't one this script's raw-line pass handles safely. `
    + `Bailing out rather than risk silently mismatched radio assignment.`,
  );
  process.exit(1);
}
qsos.forEach((q, i) => { q.radio_nr = transmitterIds[i] + 1; });

// ---------------------------------------------------------------------
// Sort chronologically -- everything below (run/S&P, prefix-mult
// first-occurrence) depends on real time order, which a Cabrillo file is
// usually but not guaranteedly already in.
// ---------------------------------------------------------------------
const qTime = (q) => new Date(String(q.n1mm_timestamp).replace(' ', 'T') + 'Z').getTime();
qsos.sort((a, b) => qTime(a) - qTime(b));

// ---------------------------------------------------------------------
// Operator shifts, per radio: walk each radio's own chronological
// subsequence and assign the same operator to a random 15-60 QSO block
// before rotating to another (with replacement -- an operator can come
// back later, same as a real shift schedule).
// ---------------------------------------------------------------------
const byRadio = new Map();
for (const q of qsos) {
  if (!byRadio.has(q.radio_nr)) byRadio.set(q.radio_nr, []);
  byRadio.get(q.radio_nr).push(q);
}
for (const list of byRadio.values()) {
  let i = 0;
  while (i < list.length) {
    const op = operators[Math.floor(rng() * operators.length)];
    const blockLen = 15 + Math.floor(rng() * 46);
    for (let j = i; j < Math.min(list.length, i + blockLen); j += 1) list[j].operator = op;
    i += blockLen;
  }
}

// ---------------------------------------------------------------------
// Run vs. S&P, per radio: a short gap from the previous QSO on the same
// radio reads as still-running the frequency; a longer one reads as
// having moved (band change, tuning around for a mult). Grounded in the
// log's own real inter-QSO timing.
// ---------------------------------------------------------------------
for (const list of byRadio.values()) {
  let prevT = null;
  for (const q of list) {
    const t = qTime(q);
    q.is_run_qso = prevT != null && (t - prevT) <= RUN_GAP_MS ? 1 : 0;
    prevT = t;
  }
}

// ---------------------------------------------------------------------
// StationName / freq unit fix. rx_freq/tx_freq from cabrillo.js are the
// raw Cabrillo kHz string (e.g. "21315") -- replay.js's tensOfHz() expects
// Hz (matching what a real live-captured snapshot's DB row holds, per
// N1MM's own tens-of-Hz wire convention -- see CLAUDE.md's Freq/TXFreq
// note). Converting here, once, rather than teaching replay.js two
// possible input units.
// ---------------------------------------------------------------------
const stationCall = meta.station_call || qsos[0].mycall;
for (const q of qsos) {
  const hz = Number(q.rx_freq) * 1000;
  q.rx_freq = hz;
  q.tx_freq = hz;
  q.station_name = `${STATION_PREFIX || stationCall}-${q.radio_nr}`;
  q.netbios_name = q.station_name;
  q.contestname = meta.contest;
  q.contestnr = '1';
  q.comp_nr = q.radio_nr;
}

// ---------------------------------------------------------------------
// Points (approximate WPX-shaped) + prefix multiplier (real WPX rule:
// first occurrence of a prefix, anywhere in the contest, counts once).
// ---------------------------------------------------------------------
function wpxPrefixOf(rawCall) {
  let call = String(rawCall || '').toUpperCase().trim();
  if (!call) return '';
  if (call.includes('/')) {
    const parts = call.split('/').filter(Boolean);
    const SUFFIXES = new Set(['P', 'M', 'MM', 'AM', 'A', 'R', 'QRP', 'LH']);
    const cands = parts.filter((p) => !SUFFIXES.has(p) && p.length >= 2);
    call = cands.sort((a, b) => b.length - a.length)[0] || parts[0];
  }
  let i = 0;
  while (i < call.length && /\d/.test(call[i])) i += 1; // leading country digit(s), e.g. "3D2AG"
  while (i < call.length && /[A-Z]/.test(call[i])) i += 1; // leading letters
  while (i < call.length && /\d/.test(call[i])) i += 1; // call-area numeral(s)
  const prefix = call.slice(0, i);
  return /\d/.test(prefix) ? prefix : `${prefix}0`;
}

const my = resolveCall(stationCall) || {};
const seenPrefixes = new Set();
for (let i = 0; i < qsos.length; i += 1) {
  const q = qsos[i];
  const hit = resolveCall(q.call) || {};
  const sameCountry = hit.entity && my.entity && hit.entity === my.entity;
  const sameContinent = !sameCountry && hit.continent && my.continent && hit.continent === my.continent;
  // Not official WPX scoring -- see this file's header comment.
  q.points = sameCountry ? 1 : sameContinent ? 2 : 3;

  const prefix = wpxPrefixOf(q.call);
  q.wpxprefix = prefix;
  if (prefix && !seenPrefixes.has(prefix)) {
    seenPrefixes.add(prefix);
    q.is_mult1 = 1;
  } else {
    q.is_mult1 = 0;
  }

  q.ext_id = `REPLAY-${i}`;
}

// ---------------------------------------------------------------------
// Write out in the exact shape replay.js already reads from a real
// snapshot.json (see snapshot.js) -- score history is left empty on
// purpose; replay.js re-derives the running score from the QSOs
// themselves and falls back cleanly to qsos[0]'s own fields for the
// dynamicresults header when there's no captured history to read
// category/qth metadata from.
// ---------------------------------------------------------------------
const out = {
  capturedAt: new Date().toISOString(),
  source: `cabrillo:${filename}`,
  '/api/qsos': qsos,
  '/api/score/history': [],
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

const totalMult = seenPrefixes.size;
const totalPoints = qsos.reduce((s, q) => s + q.points, 0);
console.log(`saved ${OUT}`);
console.log(`  seed:      ${SEED}  (pass --seed ${SEED} to reproduce this exact operator assignment)`);
console.log(`  contest:   ${meta.contest}  ·  ${stationCall}`);
console.log(`  QSOs:      ${qsos.length}  ·  radios: ${[...byRadio.keys()].sort().join(', ')}`);
console.log(`  operators: ${operators.join(', ')}`);
console.log(`  points:    ${totalPoints.toLocaleString()} (approximate -- see header comment)`);
console.log(`  mults:     ${totalMult} unique WPX prefixes`);
console.log(`  span:      ${qsos[0].n1mm_timestamp} -> ${qsos[qsos.length - 1].n1mm_timestamp}`);
console.log(`\nNext: node tools/demo/replay.js ${path.relative(process.cwd(), OUT)} --help`);
