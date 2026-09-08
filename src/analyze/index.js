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
const { specForContest, applyExchange } = require('./contests');
const { enrichGeo, resolveCall } = require('./geo');

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
  if (spec && format === 'cabrillo') {
    const home = resolveCall(meta.station_call);
    const isDomestic = !!home && ['K', 'VE'].includes(home.prefix);
    exchangeParsed = applyExchange(qsos, spec, { isDomestic, meta });
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

module.exports = { analyzeLog, detectFormat, newId };
