// Cabrillo -> { meta, qsos, flags }. Pure function, no DOM, no Node
// built-ins -- runs server-side on upload today and could run in-browser
// later unchanged (see docs/ANALYZER.md).
//
// A submitted Cabrillo log carries far less than a live N1MM feed: no
// per-QSO points, no multiplier status, no operator attribution, no
// run/S&P flag. What every QSO: line does carry reliably is frequency,
// mode, date/time, the sender's call, and the worked call -- enough for
// band/mode/time/rate/dupes/call-length, and (once run through the cty
// resolver in src/analyze/index.js) continent / DXCC / zone. Everything
// else is left blank and the flags below tell the result page which
// sections to hide.
//
// The QSO: line grammar past the four fixed leading tokens is
// contest-specific:
//
//   QSO: <freq> <mode> <date> <time> <mycall> <sent-exch...> <call> <rcvd-exch...> [txid]
//
// We assume the sent and received exchanges have equal token counts (true
// for the common RST / RST+zone / RST+serial / RST+state / RST+section
// designs) and take the middle token as the worked call, validating it
// against a callsign shape and falling back to a single-candidate scan.
// Unusual exchanges (Sweepstakes) may misattribute the call; the QSO still
// counts correctly for everything that doesn't need it.

const { canonicalBand } = require('./bands');

const MODE_MAP = {
  CW: 'CW',
  PH: 'SSB', SSB: 'SSB', USB: 'SSB', LSB: 'SSB', FM: 'FM', AM: 'AM',
  RY: 'RTTY', RTTY: 'RTTY', DG: 'DIGITAL', DIGITAL: 'DIGITAL',
  PSK: 'PSK', FT8: 'FT8', FT4: 'FT4', MFSK: 'MFSK',
};

const CALL_RE = /^[A-Z0-9]{0,3}\d[A-Z0-9]*[A-Z](?:\/[A-Z0-9]+)*$/;

function normMode(raw) {
  const u = String(raw || '').toUpperCase();
  return MODE_MAP[u] || u || '';
}

// Cabrillo frequency is kHz on HF ("14042", "7025"); VHF+ logs use a plain
// MHz band token ("50", "144", "432", "1296") or a literal like "LIGHT".
// Snap to a canonical band string (see bands.js) so every 20m QSO buckets
// together regardless of the exact kHz, and so the value matches what the
// ADIF parser and the live N1MM feed produce.
function freqToBand(raw) {
  const n = parseFloat(raw);
  if (Number.isNaN(n)) return String(raw || '');
  const mhz = n >= 1800 ? n / 1000 : n;
  return canonicalBand(mhz) || String(mhz);
}

function pad2(n) { return String(n).padStart(2, '0'); }

// "20250607" or "2025-06-07" + "1830" / "183012" -> "2025-06-07 18:30:00"
function toTimestamp(date, time) {
  const d = String(date || '').replace(/[^\d]/g, '');
  const t = String(time || '').replace(/[^\d]/g, '');
  if (d.length !== 8) return '';
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  const hh = t.slice(0, 2) || '00';
  const mm = t.slice(2, 4) || '00';
  const ss = t.slice(4, 6) || '00';
  return `${iso} ${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

function looksLikeCall(tok) {
  return !!tok && tok.length >= 3 && tok.length <= 12 && CALL_RE.test(tok);
}

// tokens: everything after "QSO: <freq> <mode> <date> <time> <mycall>"
function pickWorkedCall(rest, myCall) {
  let toks = rest.slice();

  // Trailing transmitter-id (0/1) appears only for multi-transmitter
  // categories and makes the token count even; a real exchange leaves it
  // odd (sent + call + rcvd, equal halves).
  if (toks.length % 2 === 0 && /^[01]$/.test(toks[toks.length - 1])) {
    toks = toks.slice(0, -1);
  }

  const mid = (toks.length - 1) / 2;
  if (Number.isInteger(mid) && mid >= 0) {
    const cand = toks[mid];
    if (looksLikeCall(cand) && cand !== myCall) return cand;
  }

  // Fallback: exactly one call-shaped token that isn't ours.
  const calls = toks.filter((t) => looksLikeCall(t) && t !== myCall);
  if (calls.length === 1) return calls[0];
  if (calls.length > 1) return calls[Math.floor(calls.length / 2)];
  return '';
}

function blankQso() {
  return {
    call: '', band: '', mode: '', operator: '', mycall: '',
    contestname: '', contestnr: '', rx_freq: '', tx_freq: '',
    countryprefix: '', wpxprefix: '', stationprefix: '', continent: '',
    snt: '', snt_nr: '', rcv: '', rcv_nr: '', gridsquare: '', exchange1: '',
    section: '', comment: '', op_name: '', power: '', misctext: '',
    zone: '', prec: '', ck: '', is_mult1: 0, is_mult2: 0, is_mult3: 0,
    points: 0, radio_nr: null, run1run2: '', is_run_qso: 0,
    station_name: '', sent_exchange: '', n1mm_timestamp: '', logged_at: '',
    excluded: 0,
  };
}

function parseCabrillo(text) {
  const meta = {
    format: 'cabrillo', contest: '', station_call: '', operators: '',
    claimed_score: null,
  };
  const qsos = [];
  const flags = {
    has_points: false, has_mults: false, has_operator: false, has_run_flag: false,
  };

  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const tag = line.slice(0, colon).toUpperCase();
    const value = line.slice(colon + 1).trim();

    if (tag === 'CONTEST') { meta.contest = value; continue; }
    if (tag === 'CALLSIGN') { meta.station_call = value.toUpperCase(); continue; }
    if (tag === 'OPERATORS') {
      meta.operators = meta.operators ? `${meta.operators} ${value}` : value;
      continue;
    }
    if (tag === 'CLAIMED-SCORE') {
      const n = parseInt(value.replace(/[^\d]/g, ''), 10);
      if (!Number.isNaN(n)) meta.claimed_score = n;
      continue;
    }
    if (tag !== 'QSO' && tag !== 'X-QSO') continue;

    const toks = value.split(/\s+/).filter(Boolean);
    if (toks.length < 5) continue;

    const [freq, mode, date, time, mycall] = toks;
    const q = blankQso();
    q.mycall = String(mycall || '').toUpperCase();
    q.band = freqToBand(freq);
    q.rx_freq = freq;
    q.mode = normMode(mode);
    q.n1mm_timestamp = toTimestamp(date, time);
    q.logged_at = q.n1mm_timestamp;
    q.call = pickWorkedCall(toks.slice(5), q.mycall);
    if (tag === 'X-QSO') q.excluded = 1;

    qsos.push(q);
  }

  if (!meta.station_call && qsos.length) meta.station_call = qsos[0].mycall;

  return { meta, qsos, flags };
}

module.exports = { parseCabrillo, freqToBand, normMode, toTimestamp };
