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
//
// resolveLatLon() (below) is a separate, additive lookup for the world map
// (public/index.html's #worldmap card) -- unlike enrichGeo() it never
// mutates the QSO or gets written to the qsos table; src/routes/api.js and
// src/udp/index.js each attach it only on the copy sent to the browser.

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

// Fill blank continent / zone / countryprefix on `qso` in place from the
// country file. Returns the same object. A zone of '0' counts as blank
// (some loggers emit it).
//
// `override`: field names ('continent' / 'countryprefix' / 'zone') to take
// from the country file even when the packet already carries a value. The
// realtime pipeline overrides all three because some loggers send a
// hardcoded default on every QSO rather than the actual worked station's
// data -- not1mm's contactinfo (ADD) packet always says continent="NA"
// countryprefix="K", and (a separate bug: a key-name typo in its sender)
// zone="5" -- and a stale constant is worse than the cty.csv answer keyed
// off the actual call. An override never blanks a real value: it only
// applies when the lookup itself produced something. The analyzer (an
// uploaded Cabrillo/ADIF) stays plain fill-only for all three -- a zone
// that made it into a saved log came from a real exchange, not a logger
// default, and is worth trusting over a prefix guess for a portable/rover.
function enrichGeo(qso, { override = [] } = {}) {
  if (!qso || !qso.call) return qso;
  const ov = new Set(override);
  const missing = !qso.continent || !qso.countryprefix || !qso.zone || qso.zone === '0';
  if (!missing && ov.size === 0) return qso;

  const hit = resolveCall(qso.call);
  if (!hit) return qso;

  if (!qso.continent || ov.has('continent')) {
    qso.continent = hit.continent || qso.continent || '';
  }
  if (!qso.zone || qso.zone === '0' || ov.has('zone')) {
    qso.zone = hit.cqzone || qso.zone || '';
  }
  if (!qso.countryprefix || ov.has('countryprefix')) {
    qso.countryprefix = hit.prefix || qso.countryprefix || '';
  }
  return qso;
}

// Maidenhead grid locator -> approximate center { lat, lon }. Accepts a
// 2-, 4-, or 6-character locator (case-insensitive); N1MM's `gridsquare`
// field is whatever the operator's exchange carried, so any length shows up
// in practice. A 2-char locator (a 10x20 degree field) is centered on the
// field; a bare grid with no sub-square digits is rare in an exchange but
// handled the same way. Returns null for anything that doesn't parse --
// callers fall back to the country file's entity-center coordinates.
function gridToLatLon(grid) {
  if (!grid || typeof grid !== 'string') return null;
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}([0-9]{2}([A-X]{2})?)?$/.test(g)) return null;

  // Field: 20 deg lon x 10 deg lat per letter pair, A=0.
  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  let lonSpan = 20;
  let latSpan = 10;

  if (g.length >= 4) {
    // Square: 2 deg lon x 1 deg lat per digit.
    lon += (g.charCodeAt(2) - 48) * 2;
    lat += (g.charCodeAt(3) - 48) * 1;
    lonSpan = 2;
    latSpan = 1;
  }
  if (g.length === 6) {
    // Subsquare: 1/24 of the square per letter.
    lon += (g.charCodeAt(4) - 65) * (2 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24);
    lonSpan = 2 / 24;
    latSpan = 1 / 24;
  }

  // Center of whatever the smallest resolved cell is, not its corner.
  return { lat: lat + latSpan / 2, lon: lon + lonSpan / 2 };
}

// Approximate worked-station location for the world map: prefer a real
// grid square (an actual reported location) over the country file's
// entity-center guess. Not persisted on the QSO -- see the header comment.
function resolveLatLon(qso) {
  if (!qso) return null;

  const fromGrid = gridToLatLon(qso.gridsquare);
  if (fromGrid) return fromGrid;

  if (!qso.call) return null;
  const hit = resolveCall(qso.call);
  if (!hit || hit.lat == null || hit.lon == null) return null;
  return { lat: hit.lat, lon: hit.lon };
}

module.exports = { enrichGeo, resolveCall, gridToLatLon, resolveLatLon, _setResolver };
