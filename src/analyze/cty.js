// Country-file (cty.dat / cty.csv) resolver: callsign -> { entity, prefix,
// continent, cqzone }. Used server-side at upload time (src/analyze/
// index.js) to fill continent / DXCC / CQ-zone on parsed QSOs so the
// analyzer's continent and DXCC breakdowns work for any contest, including
// a bare Cabrillo log that carries none of that itself.
//
// Input is the "big CTY" cty.csv from country-files.com, one entity per
// line:
//
//   K,United States,291,NA,5,8,37.60,91.87,5.0,AA AB AC ... =N2NL/MM(7) AA0(4)[7] ...
//
//   col 0  primary DXCC prefix
//   col 1  entity name
//   col 2  ADIF DXCC entity code
//   col 3  continent
//   col 4  CQ zone      col 5  ITU zone      cols 6-8  lat / lon / gmt
//   col 9+ space-separated alias list, ';'-terminated. A bare token is an
//          alias prefix; "=CALL" is an exact-callsign exception. Any token
//          may carry overrides: "(n)" CQ zone, "[n]" ITU zone, "{CONT}"
//          continent, plus "<lat/lon>" and "~tz~" which we ignore.
//
// This is not a full cty.dat implementation (no ITU-zone consumers here,
// no lat/lon), just enough for aggregate contest stats. A portable op's
// zone can still be wrong; that's acceptable for a breakdown.

const OVERRIDE_RE = /\((\d+)\)|\[(\d+)\]|\{([A-Za-z]{2})\}|<[^>]*>|~[^~]*~/g;

// Suffixes that don't change the DXCC entity (they may change zone, which
// we don't try to chase). Everything else on the left/right of a "/" is a
// candidate location token.
const PLAIN_SUFFIXES = new Set([
  'P', 'M', 'MM', 'AM', 'A', 'QRP', 'QRPP', 'LH', 'LGT', 'R', 'BCN', 'B',
  'J', 'Y', 'AG', 'AE', 'KT', 'N', 'T', 'W', 'G', 'D',
]);

function parseCty(text) {
  const exact = new Map();     // "N2NL/MM" -> record
  const prefixes = new Map();  // "AA0" -> record   (longest match wins at lookup)
  let maxPrefixLen = 1;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(',');
    if (parts.length < 10) continue;

    const base = {
      entity: Number(parts[2]) || null,
      name: parts[1],
      prefix: parts[0].trim(),
      continent: parts[3].trim(),
      cqzone: String(parts[4]).trim(),
    };

    // The primary prefix is itself a matchable prefix.
    addPrefix(prefixes, base.prefix, base);
    maxPrefixLen = Math.max(maxPrefixLen, base.prefix.length);

    const aliasBlob = parts.slice(9).join(',').replace(/;\s*$/, '');
    for (const token of aliasBlob.split(/\s+/)) {
      if (!token) continue;

      let cqOv = null;
      let contOv = null;
      let m;
      OVERRIDE_RE.lastIndex = 0;
      while ((m = OVERRIDE_RE.exec(token)) !== null) {
        if (m[1]) cqOv = m[1];
        else if (m[3]) contOv = m[3].toUpperCase();
      }
      const clean = token.replace(OVERRIDE_RE, '').toUpperCase();
      if (!clean) continue;

      const rec = {
        ...base,
        continent: contOv || base.continent,
        cqzone: cqOv || base.cqzone,
      };

      if (clean.startsWith('=')) {
        exact.set(clean.slice(1), rec);
      } else {
        addPrefix(prefixes, clean, rec);
        maxPrefixLen = Math.max(maxPrefixLen, clean.length);
      }
    }
  }

  return { exact, prefixes, maxPrefixLen };
}

// First writer wins: cty.csv lists the more specific entity's alias before
// a broader one would ever be re-derived, and we never want a later, less
// specific line to clobber a specific alias.
function addPrefix(map, key, rec) {
  if (key && !map.has(key)) map.set(key, rec);
}

// Reduce a called-as string to the token that names where the station is.
// "DL1XYZ/P" -> "DL1XYZ", "EA8/DL1XYZ" -> "EA8", "W1AW/4" -> "W1AW".
function locationToken(call) {
  const segs = call.split('/').filter(Boolean);
  if (segs.length <= 1) return segs[0] || call;

  const candidates = segs.filter(
    (s) => !PLAIN_SUFFIXES.has(s) && !/^\d{1,2}$/.test(s),
  );
  if (candidates.length === 0) return segs[0];
  if (candidates.length === 1) return candidates[0];

  // Two real tokens, e.g. "EA8" + "DL1XYZ" -- the shorter one is the
  // location prefix the op prepended.
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0];
}

function makeResolver(parsed) {
  const { exact, prefixes, maxPrefixLen } = parsed;

  return function resolve(callRaw) {
    if (!callRaw) return null;
    const call = String(callRaw).toUpperCase().trim();
    if (!call) return null;

    if (exact.has(call)) return exact.get(call);

    const loc = locationToken(call);
    if (exact.has(loc)) return exact.get(loc);

    const upper = Math.min(loc.length, maxPrefixLen);
    for (let n = upper; n >= 1; n -= 1) {
      const hit = prefixes.get(loc.slice(0, n));
      if (hit) return hit;
    }
    return null;
  };
}

// Convenience: text -> resolve()
function loadResolver(text) {
  return makeResolver(parseCty(text));
}

module.exports = { parseCty, makeResolver, loadResolver, locationToken };
