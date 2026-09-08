// Country-file geography fill: given a QSO with a `call`, populate
// `continent` / `zone` / `countryprefix` from cty.csv *only where they are
// missing*. Never overrides what the source already provided.
//
// Two callers:
//   - the log analyzer (src/analyze/index.js) -- a Cabrillo log carries
//     none of this; an older ADIF may be partial.
//   - the realtime contact pipeline (src/udp/index.js) -- N1MM sends these
//     fields, but TR4W and older/misconfigured N1MM setups may not, and
//     then the dashboard's continent breakdown has nothing to show.

const fs = require('fs');
const path = require('path');
const { loadResolver } = require('./cty');

const CTY_PATH = path.join(__dirname, 'cty.csv');

// undefined = not loaded yet, null = tried and unavailable, else a resolver
let _resolver;

function resolver() {
  if (_resolver !== undefined) return _resolver;
  try {
    _resolver = loadResolver(fs.readFileSync(CTY_PATH, 'utf8'));
  } catch (err) {
    console.warn(`geo: country file unavailable (${err.message}); continent/DXCC/zone fill disabled`);
    _resolver = null;
  }
  return _resolver;
}

// Test hook -- inject a resolver (or null) instead of reading disk.
function _setResolver(r) { _resolver = r; }

// callsign -> { entity, name, prefix, continent, cqzone } | null
function resolveCall(call) {
  const r = resolver();
  return r ? r(call) : null;
}

// Fill blank continent / zone / countryprefix on `qso` in place. Returns
// the same object. A zone of '0' counts as blank (some loggers emit it).
function enrichGeo(qso) {
  if (!qso || !qso.call) return qso;
  const needs = !qso.continent || !qso.countryprefix || !qso.zone || qso.zone === '0';
  if (!needs) return qso;

  const hit = resolveCall(qso.call);
  if (!hit) return qso;

  if (!qso.continent) qso.continent = hit.continent || '';
  if (!qso.zone || qso.zone === '0') qso.zone = hit.cqzone || '';
  if (!qso.countryprefix) qso.countryprefix = hit.prefix || '';
  return qso;
}

module.exports = { enrichGeo, resolveCall, _setResolver };
