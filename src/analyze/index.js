// Orchestrator for the log analyzer: raw text -> { meta, qsos, excluded }
// ready to store and render. Detects Cabrillo vs ADIF, runs the matching
// pure parser, applies the per-contest exchange grammar (Cabrillo), then
// fills in continent / DXCC prefix / CQ zone from the bundled country file
// (src/analyze/geo.js) so the geographic breakdowns work regardless of
// what the source format carried.
//
// See docs/ANALYZER.md.

const crypto = require('crypto');
const { parseCabrillo } = require('./cabrillo');
const { parseAdif } = require('./adif');
const { specForContest, applyExchange, applyGenericExchange } = require('./contests');
const { enrichGeo, resolveCall } = require('./geo');

// ARRL contests where the domestic vs. DX exchange differs. "Domestic" is
// the 48 states + DC + Canada -- so Alaska (DXCC 6) and Hawaii (110) count
// as DX. cty entity 291 = United States, 1 = Canada.
function isArrlDomestic(call) {
  const hit = resolveCall(call);
  return !!hit && (hit.entity === 291 || hit.entity === 1);
}

function detectFormat(text) {
  const head = String(text).slice(0, 4000);
  if (/<eoh>/i.test(head) || /<call:\d/i.test(head) || /<adif_ver:/i.test(head)) return 'adif';
  if (/^\s*START-OF-LOG:/im.test(head) || /^\s*QSO:\s/im.test(head)) return 'cabrillo';
  // Last resort: a line starting with QSO: anywhere.
  if (/^\s*QSO:\s/im.test(text)) return 'cabrillo';
  return null;
}

function newId() {
  // 10 url-safe base32 chars ~= 50 bits; ample for a personal analyzer.
  return crypto.randomBytes(7).toString('base64')
    .replace(/[+/=]/g, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)
    .padEnd(10, '0');
}

// text: the uploaded file contents. filename: original name, for display.
function analyzeLog(text, filename) {
  const format = detectFormat(text);
  if (!format) {
    const err = new Error('Unrecognized log format (expected Cabrillo or ADIF)');
    err.code = 'BAD_FORMAT';
    throw err;
  }

  const parsed = format === 'adif' ? parseAdif(text) : parseCabrillo(text);
  const { meta, flags } = parsed;

  const qsos = parsed.qsos.filter((q) => !q.excluded);
  const excluded = parsed.qsos
    .filter((q) => q.excluded)
    .map((q) => ({ call: q.call, band: q.band, mode: q.mode, n1mm_timestamp: q.n1mm_timestamp }));

  // v2: per-contest exchange parsing. Cabrillo only -- an ADIF export
  // already has the exchange in structured fields. Runs before enrichGeo()
  // so a zone read from the actual exchange (CQ WW) wins over the country
  // file's default zone for that entity.
  const spec = specForContest(meta.contest);
  const contestKey = spec ? spec.key : null;
  let exchangeParsed = false;
  if (format === 'cabrillo') {
    if (spec) {
      exchangeParsed = applyExchange(qsos, spec, {
        isDomestic: isArrlDomestic(meta.station_call),
        meta,
      });
    } else {
      // Unknown contest: still grab a trailing state/section token.
      applyGenericExchange(qsos);
    }
  }

  for (const q of qsos) { delete q.excluded; delete q._exchTokens; }
  for (const q of qsos) enrichGeo(q);

  return {
    meta: {
      filename: filename || '',
      format,
      contest: meta.contest || '',
      contest_key: contestKey,
      exchange_parsed: exchangeParsed,
      station_call: meta.station_call || '',
      operators: meta.operators || '',
      claimed_score: meta.claimed_score ?? null,
      qso_count: qsos.length,
      excluded_count: excluded.length,
      has_points: !!flags.has_points,
      has_mults: !!flags.has_mults,
      has_operator: !!flags.has_operator,
      has_run_flag: !!flags.has_run_flag,
    },
    qsos,
    excluded,
  };
}

function topValue(values) {
  const counts = new Map();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  let best = '';
  let n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
}

// Snapshot the realtime `qsos` table (rows from src/db/queries.getQsos)
// into the same { meta, qsos, excluded } shape a file upload produces.
// The live feed is already full fidelity -- N1MM sends points, multiplier
// flags, operator, run status and the parsed exchange fields on every
// <contactinfo> -- so there's no exchange grammar or format detection to
// do here, just a field remap plus enrichGeo() for any older logger that
// left continent/zone/prefix blank.
//
// opts.claimedScore: the running score total from the latest Score
// broadcast (src/db/queries.getLatestScore().score_total), stored as the
// analysis's claimed score. Null when no Score broadcast has arrived.
function analyzeLiveQsos(rows, opts = {}) {
  const qsos = (rows || []).map((r) => ({
    call: r.call || '', band: r.band || '', mode: r.mode || '',
    operator: r.operator || '', mycall: r.mycall || '',
    countryprefix: r.countryprefix || '', continent: r.continent || '',
    zone: r.zone || '', section: r.section || '', gridsquare: r.gridsquare || '',
    op_name: r.op_name || '', power: r.power || '', prec: r.prec || '',
    ck: r.ck || '', exchange1: r.exchange1 || '', rcv_nr: r.rcv_nr || '',
    snt_nr: r.snt_nr || '', wpxprefix: r.wpxprefix || '',
    is_mult1: r.is_mult1 ? 1 : 0, is_mult2: r.is_mult2 ? 1 : 0, is_mult3: r.is_mult3 ? 1 : 0,
    points: Number(r.points) || 0,
    is_run_qso: r.is_run_qso ? 1 : 0, run1run2: r.run1run2 || '',
    n1mm_timestamp: r.n1mm_timestamp || r.logged_at || '',
    logged_at: r.logged_at || '',
  }));

  for (const q of qsos) enrichGeo(q);

  const contest = topValue(qsos.map((q, i) => rows[i].contestname));
  const spec = specForContest(contest);

  return {
    meta: {
      filename: `live: ${contest || 'contest'}`,
      format: 'live',
      contest: contest || '',
      contest_key: spec ? spec.key : null,
      // N1MM already parsed the exchange into fields for us.
      exchange_parsed: true,
      station_call: topValue(qsos.map((q) => q.mycall)),
      operators: [...new Set(qsos.map((q) => q.operator).filter(Boolean))].join(' '),
      claimed_score: opts.claimedScore != null ? Number(opts.claimedScore) : null,
      qso_count: qsos.length,
      excluded_count: 0,
      has_points: qsos.some((q) => q.points),
      has_mults: qsos.some((q) => q.is_mult1 || q.is_mult2 || q.is_mult3),
      has_operator: qsos.some((q) => q.operator),
      has_run_flag: qsos.some((q) => q.is_run_qso),
    },
    qsos,
    excluded: [],
  };
}

module.exports = { analyzeLog, analyzeLiveQsos, detectFormat, newId };
