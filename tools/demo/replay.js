#!/usr/bin/env node
/**
 * Demo replay: re-emit a captured contest as live N1MM UDP traffic.
 *
 * Reads a snapshot taken from a running contestscore (see snapshot.js) and
 * replays every QSO as a <contactinfo> packet, with a <dynamicresults>
 * score broadcast after each and a <RadioInfo> whenever the active radio's
 * band/mode/op changes -- exactly the shapes the real ContestPulse relays.
 * A local contestscore instance ingests them and its dashboard fills in
 * "live" while you narrate.
 *
 * The real contest's inter-QSO gaps are preserved but compressed: --speed
 * divides every gap, and each wait is clamped to [--min-gap, --max-gap] so
 * a 20-minute band-change lull becomes a beat and a pileup still has a
 * visible rhythm. --duration picks the speed for you. --interval ignores
 * the real timing entirely and uses a flat delay.
 *
 * Usage:
 *   node tools/demo/replay.js [snapshot.json] [options]
 *
 *   snapshot.json      Path to a snapshot. Default: newest snapshot-*.json
 *                      next to this script.
 *
 *   --api <url>        contestscore base URL for --reset. Default:
 *                      http://localhost:3000
 *   --token <t>        Bearer token, if the target sets CONTESTSCORE_API_TOKEN.
 *   --host <addr>      UDP destination. Default: 127.0.0.1
 *   --radio-port <n>   Default 12060
 *   --contact-port <n> Default 12061
 *   --score-port <n>   Default 12062
 *
 *   --reset            DELETE /api/db before starting (clean slate).
 *   --loop             After finishing, --reset and replay again forever.
 *   --speed <n>        Compress real time by this factor. Default: 8
 *   --duration <min>   Ignore --speed; pick the speed so the whole replay
 *                      runs in about this many minutes.
 *   --interval <ms>    Flat delay between QSOs; ignores the real timestamps.
 *   --min-gap <ms>     Lower clamp on each wait. Default: 250
 *   --max-gap <ms>     Upper clamp on each wait. Default: 5000
 *   --from <n>         Start at the nth QSO (1-based). Default: 1
 *   --max <n>          Replay at most this many QSOs.
 *   --score-formula <points|points*mults>
 *                      How to fill <score>. Default: auto-detected from the
 *                      snapshot's score history.
 *   --no-score         Don't emit score packets.
 *   --no-radio         Don't emit RadioInfo packets.
 *   --quiet            One line per ~10 QSOs instead of every QSO.
 */

'use strict';

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

// --------------------------------------------------------------------------
// args
// --------------------------------------------------------------------------
const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  return fallback;
}
const flag = (name) => argv.includes(`--${name}`);

if (flag('help') || flag('h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const positional = argv.find((a) => !a.startsWith('--')
  && (argv.indexOf(a) === 0 || argv[argv.indexOf(a) - 1] === undefined || !argv[argv.indexOf(a) - 1].startsWith('--')
      || ['snapshot'].includes(argv[argv.indexOf(a) - 1])));

const CFG = {
  api: opt('api', 'http://localhost:3000').replace(/\/$/, ''),
  token: opt('token', process.env.CONTESTSCORE_API_TOKEN || ''),
  host: opt('host', '127.0.0.1'),
  radioPort: Number(opt('radio-port', 12060)),
  contactPort: Number(opt('contact-port', 12061)),
  scorePort: Number(opt('score-port', 12062)),
  reset: flag('reset'),
  loop: flag('loop'),
  speed: Number(opt('speed', 8)),
  duration: opt('duration') ? Number(opt('duration')) : null,
  interval: opt('interval') ? Number(opt('interval')) : null,
  minGap: Number(opt('min-gap', 250)),
  maxGap: Number(opt('max-gap', 5000)),
  from: Math.max(1, Number(opt('from', 1))),
  max: opt('max') ? Number(opt('max')) : Infinity,
  scoreFormula: opt('score-formula', 'auto'),
  emitScore: !flag('no-score'),
  emitRadio: !flag('no-radio'),
  quiet: flag('quiet'),
};

// --------------------------------------------------------------------------
// snapshot
// --------------------------------------------------------------------------
function resolveSnapshot() {
  if (positional) return positional;
  const dir = __dirname;
  const files = fs.readdirSync(dir)
    .filter((f) => /^snapshot-.*\.json$/.test(f))
    .sort();
  if (!files.length) {
    console.error(`No snapshot given and no snapshot-*.json in ${dir}. Run: node tools/demo/snapshot.js`);
    process.exit(1);
  }
  return path.join(dir, files[files.length - 1]);
}

const snapPath = resolveSnapshot();
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const allQsos = (snap['/api/qsos'] || []).slice()
  .sort((a, b) => String(a.n1mm_timestamp || a.logged_at).localeCompare(String(b.n1mm_timestamp || b.logged_at)));
const scoreHistory = snap['/api/score/history'] || [];

if (!allQsos.length) {
  console.error(`Snapshot ${snapPath} has no /api/qsos rows.`);
  process.exit(1);
}

// Which score formula matches the captured history? CWT-style contests
// score points*mults; many others just sum points.
function detectFormula() {
  if (CFG.scoreFormula !== 'auto') return CFG.scoreFormula;
  const rows = scoreHistory.filter((r) => r.is_total && r.score_total > 0 && r.points > 0);
  if (!rows.length) return 'points';
  const mult = rows.every((r) => Math.abs(r.score_total - r.points * (r.mults || 0)) <= 1 && r.mults);
  const pts = rows.every((r) => Math.abs(r.score_total - r.points) <= 1);
  if (mult && !pts) return 'points*mults';
  return 'points';
}
const FORMULA = detectFormula();

// --------------------------------------------------------------------------
// timeline
// --------------------------------------------------------------------------
const qsos = allQsos.slice(CFG.from - 1, CFG.from - 1 + CFG.max);
const tOf = (q) => new Date(String(q.n1mm_timestamp || q.logged_at).replace(' ', 'T') + 'Z').getTime();
const spanMs = tOf(qsos[qsos.length - 1]) - tOf(qsos[0]);

let speed = CFG.speed;
if (CFG.duration && spanMs > 0) speed = Math.max(1, spanMs / (CFG.duration * 60000));

function waitBefore(i) {
  if (i === 0) return 0;
  if (CFG.interval != null) return CFG.interval;
  const gap = tOf(qsos[i]) - tOf(qsos[i - 1]);
  return Math.min(CFG.maxGap, Math.max(CFG.minGap, Math.round(gap / speed)));
}

const plannedMs = qsos.reduce((acc, _, i) => acc + waitBefore(i), 0);

// --------------------------------------------------------------------------
// packet builders  (shapes per scripts/sendTestPacket.js / the real parsers)
// --------------------------------------------------------------------------
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tensOfHz = (hz) => (hz ? Math.round(Number(hz) / 10) : 0);
const boolX = (v) => (v ? 'True' : 'False');

function contactPacket(q) {
  return `<?xml version="1.0" encoding="utf-8"?>
<contactinfo>
  <app>ContestPulse-Replay</app>
  <contestname>${esc(q.contestname)}</contestname>
  <contestnr>${esc(q.contestnr || '1')}</contestnr>
  <timestamp>${esc(q.n1mm_timestamp || q.logged_at)}</timestamp>
  <mycall>${esc(q.mycall)}</mycall>
  <band>${esc(q.band)}</band>
  <rxfreq>${tensOfHz(q.rx_freq)}</rxfreq>
  <txfreq>${tensOfHz(q.tx_freq || q.rx_freq)}</txfreq>
  <operator>${esc(q.operator)}</operator>
  <mode>${esc(q.mode)}</mode>
  <call>${esc(q.call)}</call>
  <countryprefix>${esc(q.countryprefix)}</countryprefix>
  <wpxprefix>${esc(q.wpxprefix)}</wpxprefix>
  <stationprefix>${esc(q.stationprefix)}</stationprefix>
  <continent>${esc(q.continent)}</continent>
  <snt>${esc(q.snt)}</snt>
  <sntnr>${esc(q.snt_nr)}</sntnr>
  <rcv>${esc(q.rcv)}</rcv>
  <rcvnr>${esc(q.rcv_nr)}</rcvnr>
  <gridsquare>${esc(q.gridsquare)}</gridsquare>
  <exchange1>${esc(q.exchange1)}</exchange1>
  <section>${esc(q.section)}</section>
  <name>${esc(q.op_name)}</name>
  <power>${esc(q.power)}</power>
  <zone>${esc(q.zone)}</zone>
  <ismultiplier1>${q.is_mult1 ? 1 : 0}</ismultiplier1>
  <ismultiplier2>${q.is_mult2 ? 1 : 0}</ismultiplier2>
  <ismultiplier3>${q.is_mult3 ? 1 : 0}</ismultiplier3>
  <points>${Number(q.points) || 0}</points>
  <radionr>${q.radio_nr == null ? 1 : q.radio_nr}</radionr>
  <NetworkedCompNr>${q.comp_nr == null ? 0 : q.comp_nr}</NetworkedCompNr>
  <IsOriginal>${boolX(q.is_original == null ? 1 : q.is_original)}</IsOriginal>
  <NetBiosName>${esc(q.netbios_name)}</NetBiosName>
  <IsRunQSO>${q.is_run_qso ? 1 : 0}</IsRunQSO>
  <StationName>${esc(q.station_name || q.netbios_name)}</StationName>
  <ID>${esc(q.ext_id || '')}</ID>
  <IsClaimedQso>${q.is_claimed_qso == null ? 1 : (q.is_claimed_qso ? 1 : 0)}</IsClaimedQso>
</contactinfo>`;
}

function radioPacket(r) {
  return `<?xml version="1.0" encoding="utf-8"?>
<RadioInfo>
  <StationName>${esc(r.station_name)}</StationName>
  <RadioNr>${r.radio_nr}</RadioNr>
  <Freq>${tensOfHz(r.freq)}</Freq>
  <TXFreq>${tensOfHz(r.freq)}</TXFreq>
  <Mode>${esc(r.mode)}</Mode>
  <OpCall>${esc(r.op_call)}</OpCall>
  <IsRunning>${boolX(r.is_running)}</IsRunning>
  <IsTransmitting>${boolX(r.is_transmitting)}</IsTransmitting>
  <FocusEntry>1</FocusEntry>
  <Antenna>1</Antenna>
  <FocusRadioNr>${r.radio_nr}</FocusRadioNr>
  <ActiveRadioNr>${r.radio_nr}</ActiveRadioNr>
</RadioInfo>`;
}

function scorePacket(agg, headerRow) {
  const h = headerRow || {};
  const rows = [];
  for (const [key, v] of agg.byBandMode) {
    const [band, mode] = key.split('|');
    rows.push(`    <qso band="${esc(band)}" mode="${esc(mode)}">${v.qsos}</qso>`);
    rows.push(`    <point band="${esc(band)}" mode="${esc(mode)}">${v.points}</point>`);
  }
  rows.push(`    <qso band="total" mode="ALL">${agg.qsos}</qso>`);
  rows.push(`    <point band="total" mode="ALL">${agg.points}</point>`);
  rows.push(`    <mult band="total" mode="ALL" type="mult">${agg.mults}</mult>`);
  const score = FORMULA === 'points*mults' ? agg.points * agg.mults : agg.points;
  return `<?xml version="1.0"?>
<dynamicresults>
  <contest>${esc(h.contest || qsos[0].contestname)}</contest>
  <call>${esc(h.call || qsos[0].mycall)}</call>
  <class power="${esc(h.power || 'LOW')}" assisted="${h.assisted ? 'ASSISTED' : 'NON-ASSISTED'}" transmitter="${esc(h.transmitter || 'ONE')}" ops="${esc(h.category_ops || 'SINGLE-OP')}" bands="${esc(h.category_bands || 'ALL')}" mode="${esc(h.category_mode || 'CW')}" overlay="${esc(h.overlay || 'N/A')}"></class>
  <qth>
    <cqzone>${esc(h.cq_zone)}</cqzone>
    <iaruzone>${esc(h.iaru_zone)}</iaruzone>
    <arrlsection>${esc(h.arrl_section)}</arrlsection>
    <stprvoth>${esc(h.st_prov_oth)}</stprvoth>
    <grid6>${esc(h.grid6)}</grid6>
  </qth>
  <breakdown>
${rows.join('\n')}
  </breakdown>
  <score>${score}</score>
  <timestamp>${new Date().toISOString().replace('T', ' ').slice(0, 19)}</timestamp>
</dynamicresults>`;
}

// --------------------------------------------------------------------------
// transport
// --------------------------------------------------------------------------
const sock = dgram.createSocket('udp4');
function send(xml, port) {
  return new Promise((resolve) => {
    const buf = Buffer.from(xml);
    sock.send(buf, 0, buf.length, port, CFG.host, () => resolve());
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resetDb() {
  const headers = { 'X-Confirm': 'yes' };
  if (CFG.token) headers.Authorization = `Bearer ${CFG.token}`;
  const res = await fetch(`${CFG.api}/api/db`, { method: 'DELETE', headers });
  if (!res.ok) throw new Error(`reset failed: HTTP ${res.status} ${await res.text()}`);
}

// --------------------------------------------------------------------------
// run
// --------------------------------------------------------------------------
let stopped = false;
process.on('SIGINT', () => { stopped = true; console.log('\n\n· stopping ·'); });

const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

function scoreHeaderAt(wallStartMs, elapsedMs) {
  // Walk the captured is_total history to the row whose captured_at maps
  // nearest-past the current replay position -- only used for the packet's
  // category/qth header fields, never its counts (those are re-derived).
  if (!scoreHistory.length) return null;
  const t0 = tOf(qsos[0]);
  const target = t0 + (elapsedMs * speed);
  let best = scoreHistory[0];
  for (const r of scoreHistory) {
    if (!r.is_total) continue;
    if (new Date(r.captured_at).getTime() <= target) best = r;
  }
  return best;
}

async function replayOnce() {
  const agg = { qsos: 0, points: 0, mults: 0, byBandMode: new Map() };
  const radioState = new Map(); // radio_nr -> { band, mode, op }
  const startWall = Date.now();

  console.log(`\n▶ ${path.basename(snapPath)}  ·  ${qsos.length} QSOs  ·  `
    + `real span ${fmtDur(spanMs)}  →  replay ~${fmtDur(plannedMs)} `
    + `(${CFG.interval != null ? `flat ${CFG.interval}ms` : `${speed.toFixed(0)}× speed`})  ·  score = ${FORMULA}\n`);

  for (let i = 0; i < qsos.length && !stopped; i++) {
    await sleep(waitBefore(i));
    if (stopped) break;
    const q = qsos[i];

    // RadioInfo on first sight of a radio, or when its band/mode/op moved.
    if (CFG.emitRadio) {
      const rn = q.radio_nr == null ? 1 : q.radio_nr;
      const prev = radioState.get(rn);
      const cur = { band: q.band, mode: q.mode, op: q.operator };
      if (!prev || prev.band !== cur.band || prev.mode !== cur.mode || prev.op !== cur.op) {
        radioState.set(rn, cur);
        await send(radioPacket({
          station_name: q.station_name || q.netbios_name || q.mycall,
          radio_nr: rn,
          freq: q.rx_freq,
          mode: q.mode,
          op_call: q.operator,
          is_running: q.is_run_qso ? 1 : 0,
          is_transmitting: 0,
        }), CFG.radioPort);
      }
    }

    await send(contactPacket(q), CFG.contactPort);

    agg.qsos += 1;
    agg.points += Number(q.points) || 0;
    agg.mults += (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0);
    const key = `${q.band}|${q.mode}`;
    const bm = agg.byBandMode.get(key) || { qsos: 0, points: 0 };
    bm.qsos += 1;
    bm.points += Number(q.points) || 0;
    agg.byBandMode.set(key, bm);

    if (CFG.emitScore) {
      await send(scorePacket(agg, scoreHeaderAt(startWall, Date.now() - startWall)), CFG.scorePort);
    }

    const score = FORMULA === 'points*mults' ? agg.points * agg.mults : agg.points;
    if (!CFG.quiet || (i + 1) % 10 === 0 || i === qsos.length - 1) {
      const clock = String(q.n1mm_timestamp || q.logged_at).slice(11, 19);
      console.log(
        `  [${String(i + 1).padStart(3)}/${qsos.length}] ${clock}  `
        + `${String(q.band).padStart(5)} ${String(q.mode).padEnd(3)}  `
        + `${String(q.call).padEnd(10)} ${String(q.operator).padEnd(7)} `
        + `${q.is_mult1 || q.is_mult2 || q.is_mult3 ? 'MULT' : '    '}  `
        + `│ ${agg.qsos} Q  ${score.toLocaleString()} pts`,
      );
    }
  }

  console.log(stopped ? '\n· stopped ·\n' : `\n✔ done — ${agg.qsos} QSOs, `
    + `${(FORMULA === 'points*mults' ? agg.points * agg.mults : agg.points).toLocaleString()} points`
    + ` in ${fmtDur(Date.now() - startWall)}\n`);
}

(async () => {
  try {
    do {
      if (CFG.reset || CFG.loop) {
        process.stdout.write(`· reset ${CFG.api}/api/db … `);
        await resetDb();
        console.log('ok');
      }
      await replayOnce();
      if (CFG.loop && !stopped) {
        console.log('· loop: restarting in 5s (Ctrl-C to stop) ·');
        await sleep(5000);
      }
    } while (CFG.loop && !stopped);
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  } finally {
    sock.close();
  }
})();
