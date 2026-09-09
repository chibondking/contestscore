// Manual-entry -> Cabrillo. The analyze page's "Enter manually" mode turns
// a small form + a paste box into a Cabrillo document and POSTs it to the
// same /api/analyze endpoint an uploaded file uses -- so the per-contest
// exchange maps, cty enrichment and every stat work identically, with no
// server-side code for manual entry at all.
//
// Loaded as a plain global on analyze.html; module.exports-guarded so the
// round-trip (form -> Cabrillo -> analyzeLog) can be unit-tested under node.

const BAND_KHZ = {
  '160m': '1800', '80m': '3500', '60m': '5350', '40m': '7000', '30m': '10100',
  '20m': '14000', '17m': '18100', '15m': '21000', '12m': '24900', '10m': '28000',
  '6m': '50100', '4m': '70100', '2m': '144100', '1.25m': '222100', '70cm': '432100',
};

// A band token as typed ("20m", "14", "14.030", "7025") -> a kHz string for
// the Cabrillo QSO: line. src/analyze/cabrillo.js snaps kHz back to a
// canonical band, so exact values don't matter.
function bandTokenToKhz(tok) {
  const t = String(tok || '').toLowerCase().trim();
  if (BAND_KHZ[t]) return BAND_KHZ[t];
  const n = parseFloat(t);
  if (!Number.isNaN(n)) return String(Math.round(n < 1000 ? n * 1000 : n)); // MHz -> kHz
  return '14000';
}

const CALLISH = /^[A-Z0-9]{0,3}\d[A-Z0-9]*[A-Z](?:\/[A-Z0-9]+)*$/i;
const BANDTOK = /^(?:\d{1,3}m|\d{1,4}(?:\.\d+)?)$/i;

// One paste line -> { call, band, time, exch } or { passthrough, raw }, or
// null when the line has no recognizable callsign.
function parseManualLine(raw) {
  const line = String(raw || '').trim();
  if (!line || line.startsWith('#')) return null;
  if (/^QSO:/i.test(line) || line.startsWith('<')) return { passthrough: true, raw: line };

  const toks = line.split(/\s+/);
  let time = '';
  let band = '';
  if (/^\d{3,4}$/.test(toks[0])) time = toks.shift().padStart(4, '0');
  // A band token ("20m", "14", "7025") only counts as one when a callsign
  // still follows it -- "40m" alone parses as callish, so guard on that.
  if (toks.length >= 2 && BANDTOK.test(toks[0])) band = toks.shift();

  const call = (toks.shift() || '').toUpperCase();
  if (!CALLISH.test(call)) return null;

  return { call, band, time, exch: toks.join(' ') };
}

function parseManualLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(parseManualLine)
    .filter(Boolean);
}

// form: { contest, mycall, myexch, band, mode, date, qsos }
function buildManualCabrillo(form) {
  const f = form || {};
  const mycall = String(f.mycall || '').trim().toUpperCase();
  const mode = String(f.mode || 'CW').trim().toUpperCase();
  const date = String(f.date || '').trim() || new Date().toISOString().slice(0, 10);
  const sent = String(f.myexch || '').trim() || '599';
  const defKhz = bandTokenToKhz(f.band || '20m');

  const lines = ['START-OF-LOG: 3.0'];
  if (f.contest) lines.push(`CONTEST: ${String(f.contest).trim()}`);
  if (mycall) lines.push(`CALLSIGN: ${mycall}`);

  for (const row of parseManualLines(f.qsos)) {
    if (row.passthrough) { lines.push(row.raw); continue; }
    const khz = row.band ? bandTokenToKhz(row.band) : defKhz;
    const time = row.time || '0000';
    lines.push(
      `QSO: ${khz} ${mode} ${date} ${time} ${mycall} ${sent} ${row.call}${row.exch ? ` ${row.exch}` : ''}`,
    );
  }
  lines.push('END-OF-LOG:');
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildManualCabrillo, parseManualLines, parseManualLine, bandTokenToKhz };
}
