// Per-contest exchange maps (docs/ANALYZER.md v2). A Cabrillo QSO: line
// past the four fixed leading tokens is contest-specific:
//
//   QSO: <freq> <mode> <date> <time> <mycall> <sent...> <call> <rcvd...> [txid]
//
// cabrillo.js finds <call> with a symmetric-split heuristic and leaves the
// exchange unparsed. When the CONTEST: header names a contest we know, this
// module splits sent | call | rcvd deterministically and maps the received
// exchange onto QSO columns (zone, section, gridsquare, op_name, ck, prec,
// rcv_nr, exchange1, power) that the Stats/Charts renderers consume.
//
// It only overrides q.call when the token count matches the spec exactly;
// otherwise it keeps the heuristic call and maps as many trailing tokens
// as it can. Unknown contests are left entirely to the heuristic.

const { looksLikeCall } = require('./cabrillo');

// Exchange field name -> QSO column. Fields we don't consume (rst) map to
// nothing and are skipped.
const FIELD_TO_COL = {
  serial: 'rcv_nr',
  zone: 'zone',
  section: 'section',
  state: 'section',
  prov: 'section',
  loc: 'section',
  county: 'section',
  hq: 'section',
  grid: 'gridsquare',
  name: 'op_name',
  check: 'ck',
  prec: 'prec',
  class: 'exchange1',
  power: 'power',
};

const SECTION_COLS = new Set(['section']);

function normalizeContest(header) {
  return String(header || '').toUpperCase().trim().replace(/[\s_]+/g, '-');
}

// Each spec: { key, match, sent:[fields], rcvd:[fields] } or, for the
// asymmetric ones, { key, match, resolve(ctx) -> {sent, rcvd} } where
// ctx.isDomestic says whether the uploader's station is in the contest's
// home country. `flexible: true` means "no fixed grammar" -- see
// applyFlexible (state QSO parties).
const SPECS = [
  { key: 'CQ-WW', match: /^CQ-?WW/, sent: ['rst', 'zone'], rcvd: ['rst', 'zone'] },
  { key: 'CQ-WPX', match: /^CQ-?WPX/, sent: ['rst', 'serial'], rcvd: ['rst', 'serial'] },
  { key: 'CQ-160', match: /^CQ-?160/, sent: ['rst', 'loc'], rcvd: ['rst', 'loc'] },
  { key: 'WAE', match: /^WAE(DC)?|^WORKED-ALL-EUROPE/, sent: ['rst', 'serial'], rcvd: ['rst', 'serial'] },
  { key: 'IARU-HF', match: /^IARU(-HF)?/, sent: ['rst', 'hqzone'], rcvd: ['rst', 'hqzone'] },
  { key: 'STEW-PERRY', match: /^STEW-?PERRY|TOPBAND-DISTANCE/, sent: ['grid'], rcvd: ['grid'] },
  {
    key: 'ARRL-SS', match: /^ARRL-SS|SWEEPSTAKES/,
    sent: ['serial', 'prec', 'check', 'section'],
    rcvd: ['serial', 'prec', 'check', 'section'],
  },
  {
    key: 'ARRL-FD', match: /^ARRL-(FIELD-DAY|FD)|^FIELD-DAY/,
    sent: ['class', 'section'], rcvd: ['class', 'section'],
  },
  {
    key: 'ARRL-DX', match: /^ARRL-DX/,
    resolve: (ctx) => (ctx.isDomestic
      ? { sent: ['rst', 'state'], rcvd: ['rst', 'power'] }
      : { sent: ['rst', 'power'], rcvd: ['rst', 'state'] }),
  },
  { key: 'ARRL-10', match: /^ARRL-10/, sent: ['rst', 'stnum'], rcvd: ['rst', 'stnum'] },
  { key: 'ARRL-RTTY', match: /^ARRL-RTTY|RTTY-ROUNDUP/, sent: ['rst', 'stnum'], rcvd: ['rst', 'stnum'] },
  { key: 'NAQP', match: /^NAQP/, sent: ['name', 'loc'], rcvd: ['name', 'loc'] },
  { key: 'NA-SPRINT', match: /^(NA-?SPRINT|NCCC-?SPRINT)/, sent: ['serial', 'name', 'loc'], rcvd: ['serial', 'name', 'loc'] },
  { key: 'QSO-PARTY', match: /QSO-?PARTY$|-QP$|^[A-Z]{2,3}QP$/, flexible: true },
];

function specForContest(header) {
  const norm = normalizeContest(header);
  if (!norm) return null;
  return SPECS.find((sp) => sp.match.test(norm)) || null;
}

// hqzone / stnum resolve per-token: a number is a zone/serial, letters are
// an HQ abbreviation / state.
function coerce(field, token) {
  let f = field;
  if (f === 'hqzone') f = /^\d+$/.test(token) ? 'zone' : 'hq';
  if (f === 'stnum') f = /^\d+$/.test(token) ? 'serial' : 'state';
  if (f === 'rst') return null;
  const col = FIELD_TO_COL[f];
  if (!col) return null;
  return { col, value: SECTION_COLS.has(col) ? String(token).toUpperCase() : token };
}

function mapFields(q, fields, tokens) {
  for (let i = 0; i < fields.length && i < tokens.length; i += 1) {
    if (!tokens[i]) continue;
    const c = coerce(fields[i], tokens[i]);
    if (c) q[c.col] = c.value;
  }
}

// No fixed grammar (state QSO parties): after the (heuristic) worked call,
// drop a leading RST, then an all-digit serial, and take the last token as
// the location (county / state / province).
function applyFlexible(q) {
  const toks = q._exchTokens || [];
  const ci = toks.indexOf(q.call);
  let r = (ci === -1 ? [] : toks.slice(ci + 1)).filter((t) => !/^[01]$/.test(t));
  if (r.length > 1 && /^(5(\d\d|9|NN))$/i.test(r[0])) r = r.slice(1);
  if (r.length > 1 && /^\d+$/.test(r[0])) { q.rcv_nr = r[0]; r = r.slice(1); }
  if (r.length) q.section = String(r[r.length - 1]).toUpperCase();
}

// Returns true if the exchange grammar matched at least one QSO exactly
// (used for meta.exchange_parsed).
function applyExchange(qsos, spec, ctx = {}) {
  if (spec.flexible) {
    for (const q of qsos) applyFlexible(q);
    return true;
  }

  const { sent, rcvd } = spec.resolve ? spec.resolve(ctx) : spec;
  const S = sent.length;
  const R = rcvd.length;
  let matchedAny = false;

  for (const q of qsos) {
    let toks = (q._exchTokens || []).slice();

    // optional trailing transmitter-id
    if (toks.length === S + 1 + R + 1 && /^[01]$/.test(toks[toks.length - 1])) {
      toks = toks.slice(0, -1);
    }

    if (toks.length === S + 1 + R) {
      const call = toks[S];
      if (looksLikeCall(call)) q.call = call;
      mapFields(q, rcvd, toks.slice(S + 1));
      matchedAny = true;
    } else {
      // Count mismatch (asymmetric edge, missing field): keep the heuristic
      // call, map whatever trailing tokens line up.
      const ci = toks.indexOf(q.call);
      if (ci !== -1) mapFields(q, rcvd, toks.slice(ci + 1));
    }
  }

  return matchedAny;
}

module.exports = { specForContest, applyExchange, normalizeContest };
