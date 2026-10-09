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
const { loadResolver, locationToken } = require('./cty');

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

// The country file in use: { loaded, version: "20260915" | null, date:
// "2026-09-15" | null, entities }. Loaded once per process, so this is the
// file the running server read at startup (a deploy restarts it).
function ctyInfo() {
  const r = resolver();
  if (!r) return { loaded: false, version: null, date: null, entities: 0 };
  const info = r.info || {};
  const v = info.version || null;
  return {
    loaded: true,
    version: v,
    date: v ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null,
    entities: info.entities || 0,
  };
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

// The continental US is ONE DXCC entity (ADIF code 291) -- cty.csv gives it
// exactly one lat/lon for the whole country (the "K" line), which is a
// central-US point nowhere near a West Coast call. Hawaii/Alaska/Puerto
// Rico etc. don't have this problem because they're each their OWN DXCC
// entity with their own cty.csv line and coordinates already -- it's only
// the 10 numbered call areas *within* the mainland (which a DXCC country
// file has no concept of at all) that collapse to one point. Confirmed
// live 2026-09 (W6SX, AA7V plotting in Missouri instead of the West
// Coast): a real, reportable inaccuracy, not a hypothetical one.
//
// Centers are rough geographic approximations of each call area's states
// (not population-weighted, not authoritative) -- same honesty as the
// country-file entity center this refines. A vanity call can legitimately
// carry a call-area digit that doesn't match the operator's real location;
// this is a best-effort improvement over "always Missouri," not a claim of
// precision.
const US_CALL_AREA_CENTERS = {
  0: { lat: 41.5, lon: -96.0 },  // CO IA KS MN MO NE ND SD
  1: { lat: 43.0, lon: -71.5 },  // CT MA ME NH RI VT
  2: { lat: 42.5, lon: -75.5 },  // NJ NY
  3: { lat: 40.0, lon: -77.5 },  // DE DC MD PA
  4: { lat: 33.0, lon: -83.5 },  // AL FL GA KY NC SC TN VA
  5: { lat: 32.5, lon: -96.0 },  // AR LA MS NM OK TX
  6: { lat: 37.0, lon: -120.0 }, // CA
  7: { lat: 43.5, lon: -116.0 }, // AZ ID MT NV OR UT WA WY
  8: { lat: 40.0, lon: -82.5 },  // MI OH WV
  9: { lat: 41.0, lon: -89.0 },  // IL IN WI
};
// US-allocated prefix letters only (A[A-L], K, N, W, each optionally with a
// second letter) -- NOT a bare [A-Z]{1,2}. A German call like DL1XYZ has the
// exact same digit-then-letters shape and would otherwise match too; the
// entity===291 gate in resolveLatLon() already keeps that from happening in
// practice, but this function should be correct standing on its own, not
// only correct because of how its one caller happens to use it.
const US_CALL_AREA_RE = /^(?:A[A-L]|[KNW][A-Z]?)([0-9])[A-Z]{1,3}$/;

// Only called once resolveCall() has already confirmed this is entity 291
// (mainland US, not KH6/KL7/KP4/etc, which already resolve correctly on
// their own) -- see resolveLatLon(). Reuses cty.js's own locationToken()
// so "portable" calls are reduced the same way the entity lookup itself
// already reduced them.
function usCallAreaLatLon(call) {
  const token = locationToken(String(call).toUpperCase().trim());
  const m = US_CALL_AREA_RE.exec(token);
  return m ? US_CALL_AREA_CENTERS[m[1]] : null;
}

// Approximate worked-station location for the world map: prefer a real
// grid square (an actual reported location), then a US call-area refinement
// for the mainland (see usCallAreaLatLon), then the country file's
// entity-center guess. Not persisted on the QSO -- see the header comment.
function resolveLatLon(qso) {
  if (!qso) return null;

  const fromGrid = gridToLatLon(qso.gridsquare);
  if (fromGrid) return fromGrid;

  if (!qso.call) return null;
  const hit = resolveCall(qso.call);
  if (!hit) return null;

  if (hit.entity === 291) {
    const fromCallArea = usCallAreaLatLon(qso.call);
    if (fromCallArea) return fromCallArea;
  }

  if (hit.lat == null || hit.lon == null) return null;
  return { lat: hit.lat, lon: hit.lon };
}

// Same job as resolveLatLon(), but takes the worked call's callsign_cache
// record (HamQTH today; any future lookup provider that fills `grid`) as a
// second, additive source -- a real callbook/QRZ-style grid, which is
// usually far more precise than the country file's one-point-per-DXCC-entity
// guess (see the US_CALL_AREA_CENTERS comment above for how rough that guess
// already admits to being).
//
// Priority: the QSO's OWN exchange grid still wins outright -- a grid the
// other station actually sent over the air (common on VHF+/rover contests)
// is ground truth for that specific QSO, and can legitimately disagree with
// what a lookup service has on file (a rover, a DXpedition, an outdated
// callbook entry). Only when the exchange has nothing usable do we reach
// for the lookup's grid; only when that ALSO has nothing usable do we fall
// through to resolveLatLon() -- the exact old method, untouched -- so a
// disabled/uncredentialed lookup provider or a callsign it simply hasn't
// resolved yet (no cache row, or cached with found:false) degrades to
// exactly what the map already did before HamQTH lookups existed.
//
// `cached` is the parsed callsign_cache.data JSON (see src/db/queries.js's
// getCachedLocation), or null/undefined if there is no row -- callers don't
// need to know or care whether that's because lookups are disabled, the
// provider hasn't reached this call yet, or HamQTH itself came back
// not-found. Adds `locSource` ('exchange' | the cache row's own `source`,
// e.g. 'hamqth' | 'estimate') alongside lat/lon so a future UI could
// distinguish a real report from a guess; resolveLatLon() itself carries no
// such field and every existing caller/test of it is unaffected.
function resolveLatLonEnriched(qso, cached) {
  if (!qso) return null;

  const fromGrid = gridToLatLon(qso.gridsquare);
  if (fromGrid) return { ...fromGrid, locSource: 'exchange' };

  if (qso.call && cached && cached.found) {
    const fromCache = gridToLatLon(cached.grid);
    if (fromCache) return { ...fromCache, locSource: cached.source || 'lookup' };
  }

  const old = resolveLatLon(qso);
  return old ? { ...old, locSource: 'estimate' } : null;
}

module.exports = {
  enrichGeo, resolveCall, gridToLatLon, usCallAreaLatLon, resolveLatLon, resolveLatLonEnriched, ctyInfo, _setResolver,
};
