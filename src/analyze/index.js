// Orchestrator for the log analyzer: raw text -> { meta, qsos } ready to
// store and render. Detects Cabrillo vs ADIF, runs the matching pure
// parser, then enriches every QSO's continent / DXCC prefix / CQ zone from
// the bundled country file so the analyzer's geographic breakdowns work
// regardless of what the source format carried.
//
// See docs/ANALYZER.md.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseCabrillo } = require('./cabrillo');
const { parseAdif } = require('./adif');
const { loadResolver } = require('./cty');
const { specForContest, applyExchange } = require('./contests');

// Bundled as a source asset (not under data/, which is gitignored runtime
// state). Refreshed by .github/workflows/cty-refresh.yml.
const CTY_PATH = path.join(__dirname, 'cty.csv');

// The country file is ~300 KB; parse it once per process.
let _resolver;
function ctyResolver() {
  if (_resolver !== undefined) return _resolver;
  try {
    _resolver = loadResolver(fs.readFileSync(CTY_PATH, 'utf8'));
  } catch (err) {
    // No country file bundled yet (see .github/workflows/cty-refresh.yml) --
    // degrade to no geographic enrichment rather than failing the upload.
    console.warn(`analyzer: country file unavailable (${err.message}); continent/DXCC/zone enrichment disabled`);
    _resolver = null;
  }
  return _resolver;
}

// For tests: force a specific resolver (or null) instead of reading disk.
function _setResolver(r) { _resolver = r; }

function detectFormat(text) {
  const head = String(text).slice(0, 4000);
  if (/<eoh>/i.test(head) || /<call:\d/i.test(head) || /<adif_ver:/i.test(head)) return 'adif';
  if (/^\s*START-OF-LOG:/im.test(head) || /^\s*QSO:\s/im.test(head)) return 'cabrillo';
  // Last resort: a line starting with QSO: anywhere.
  if (/^\s*QSO:\s/im.test(text)) return 'cabrillo';
  return null;
}

function enrich(qsos) {
  const resolve = ctyResolver();
  if (!resolve) return;
  for (const q of qsos) {
    if (!q.call) continue;
    const hit = resolve(q.call);
    if (!hit) continue;
    if (!q.continent) q.continent = hit.continent || '';
    if (!q.zone || q.zone === '0') q.zone = hit.cqzone || '';
    if (!q.countryprefix) q.countryprefix = hit.prefix || '';
  }
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

  const excludedCount = parsed.qsos.filter((q) => q.excluded).length;
  const qsos = parsed.qsos.filter((q) => !q.excluded);

  // v2: per-contest exchange parsing. Cabrillo only -- an ADIF export
  // already has the exchange in structured fields. Runs before enrich() so
  // a zone read from the actual exchange (CQ WW) wins over the country
  // file's default zone for that entity.
  const spec = specForContest(meta.contest);
  const contestKey = spec ? spec.key : null;
  let exchangeParsed = false;
  if (spec && format === 'cabrillo') {
    const resolve = ctyResolver();
    const home = resolve ? resolve(meta.station_call) : null;
    const isDomestic = !!home && ['K', 'VE'].includes(home.prefix);
    exchangeParsed = applyExchange(qsos, spec, { isDomestic, meta });
  }

  for (const q of qsos) { delete q.excluded; delete q._exchTokens; }

  enrich(qsos);

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
      excluded_count: excludedCount,
      has_points: !!flags.has_points,
      has_mults: !!flags.has_mults,
      has_operator: !!flags.has_operator,
      has_run_flag: !!flags.has_run_flag,
    },
    qsos,
  };
}

module.exports = { analyzeLog, detectFormat, newId, _setResolver };
