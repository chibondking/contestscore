const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

function toArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

// xml2js represents `<qso band="20" mode="CW">156</qso>` — an element with
// both attributes and text content — as { _: '156', $: { band: '20', mode:
// 'CW' } }. Plain-text elements with no attributes come through as a bare
// string instead.
function textAndAttrs(el) {
  if (el == null) return { text: '', attrs: {} };
  if (typeof el === 'object') return { text: el._ ?? '', attrs: el.$ || {} };
  return { text: String(el), attrs: {} };
}

// Real N1MM wire format (per
// https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/): root
// element is <dynamicresults>, not <Score>. Score/QSO counts arrive as a
// <breakdown> block of repeated <qso band="..." mode="..."> and <point
// band="..." mode="..."> elements (one pair per band/mode combination the
// station has worked, plus a band="total" mode="ALL" pair for the contest
// grand total) rather than flat top-level fields. The overall point total is
// <score>, not <total>.
//
// A live capture (2026-09, N1MM+ Score Reporting, "CW-OPEN" contest) showed
// <dynamicresults> nested one level deeper than documented, inside an outer
// <rtc> ("real-time contest [score]") wrapper -- every real Score broadcast
// was being rejected as "not a dynamicresults packet" until this was found,
// since the docs' example shows dynamicresults as the bare root. Both shapes
// are accepted here; which one a given N1MM installation sends may depend on
// its version or a setting this project doesn't otherwise touch.
//
// <mult> is confirmed live, and it does NOT share qso/point's shape: it
// carries a third attribute, type, and a contest can send SEVERAL <mult>
// elements for the same band/mode, one per multiplier category. From a real
// DXLog K1USN SST capture (test/fixtures/dxlog/dynamicresults-sst.xml):
//
//   <mult band="total" mode="ALL" type="state">10</mult>
//   <mult band="total" mode="ALL" type="country">0</mult>
//
// So a row's multiplier total is the SUM over its types, which is what
// matches DXLog's own <score>: that capture has 11 points and <score>110</score>,
// i.e. 11 x (10 + 0). Keying a row on band|mode alone and assigning made
// the last type win, so "state 10" was overwritten by "country 0" and the
// dashboard's Mults metric read 0 for the whole contest. (The earlier
// CW-OPS fixture sends only type="state", which is why one mult type's
// worth of this was right all along and the bug stayed invisible.)
//
// Sum, not max, because that's the scoring convention for a contest with
// several multiplier categories (CQ WW: zones + countries) and it's what
// reproduces <score>. Worth knowing: in both captures in hand the extra
// type is 0, so they confirm the overwrite but can't by themselves
// distinguish sum from max -- a capture with two nonzero types would.
// `mults` still stays null on every row when a contest sends no <mult> at
// all, which is how the dashboard tells "no multipliers in this contest"
// from "zero so far".
async function parseScore(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const s = result.dynamicresults || (result.rtc && result.rtc.dynamicresults);
  if (!s) throw new Error('Not a dynamicresults (Score) packet');

  const clsAttrs = (s.class && s.class.$) || {};
  const qth = s.qth || {};
  const breakdown = s.breakdown || {};

  const rows = new Map(); // "band|mode" -> { band, mode, qsos, points, mults }
  const rowFor = (attrs) => {
    const key = `${attrs.band}|${attrs.mode}`;
    let row = rows.get(key);
    if (!row) {
      row = { band: attrs.band, mode: attrs.mode, qsos: 0, points: 0, mults: null };
      rows.set(key, row);
    }
    return row;
  };

  for (const el of toArray(breakdown.qso)) {
    const { text, attrs } = textAndAttrs(el);
    rowFor(attrs).qsos = Number(text) || 0;
  }
  for (const el of toArray(breakdown.point)) {
    const { text, attrs } = textAndAttrs(el);
    rowFor(attrs).points = Number(text) || 0;
  }
  for (const el of toArray(breakdown.mult)) {
    const { text, attrs } = textAndAttrs(el);
    const row = rowFor(attrs);
    // += over =, so every type="..." for this band/mode contributes rather
    // than the last one clobbering the rest. Starts from null -> 0 on the
    // first <mult> seen, so a contest with no <mult> keeps null.
    row.mults = (row.mults ?? 0) + (Number(text) || 0);
  }

  const breakdownRows = [...rows.values()].map((r) => ({
    ...r,
    is_total: r.band === 'total' && r.mode === 'ALL',
  }));

  return {
    contest:        s.contest || '',
    call:           s.call || '',
    ops:            s.ops || '',
    power:          clsAttrs.power || '',
    assisted:       clsAttrs.assisted === 'ASSISTED' ? 1 : 0,
    transmitter:    clsAttrs.transmitter || '',
    category_ops:   clsAttrs.ops || '',
    category_bands: clsAttrs.bands || '',
    category_mode:  clsAttrs.mode || '',
    overlay:        clsAttrs.overlay || '',
    dxcc_country:   qth.dxcccountry || '',
    cq_zone:        qth.cqzone || '',
    iaru_zone:      qth.iaruzone || '',
    arrl_section:   qth.arrlsection || '',
    st_prov_oth:    qth.stprvoth || '',
    grid6:          qth.grid6 || '',
    score_total:    Number(s.score) || 0,
    // The sending logger (<soft>) -- "DXLog" for DXLog.net, whose Score
    // broadcast rides its online-scoreboard timer; the dashboard flags that
    // score as delayed. Absent in N1MM's own documented example.
    soft:           s.soft || '',
    timestamp:      s.timestamp || '',
    breakdown:      breakdownRows,
  };
}

module.exports = { parseScore };
