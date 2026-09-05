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
// No <mult> breakdown has been confirmed yet — the only captured example
// (ARRL Field Day) doesn't score multipliers. If a contest broadcasts one,
// it's parsed defensively using the same band/mode-keyed shape as qso/point;
// otherwise `mults` stays null on every row.
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
    rowFor(attrs).mults = Number(text) || 0;
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
    timestamp:      s.timestamp || '',
    breakdown:      breakdownRows,
  };
}

module.exports = { parseScore };
