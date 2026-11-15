// Space weather joined to the log: which SFI / A / K reading was in effect
// for each hour of a contest, and how the rate moved with the K-index.
//
// Shared by stats.js, charts.js and report.js -- the live Stats/Charts
// pages and the analyzer's saved-log views of the same pages, so whatever
// the live view shows about conditions, the post-contest one shows too.
// A plain classic script like the rest of public/js (no modules, no build
// step): everything hangs off one global, ContestConditions, so nothing
// here can collide with the per-page copies of qsoTime()/bandLabel()/etc.
// Pure functions except fetchForSpan()/forSavedLog(), which only fetch.
//
// Readings are solar_snapshots rows as GET /api/solar/history returns them:
// { sfi, a_index, k_index, sunspots, fetched_at: "YYYY-MM-DD HH:MM:SS" UTC }.
const ContestConditions = (() => {
  const HOUR_MS = 3600000;

  // A reading older than this says nothing about "now": hamqsl.com updates
  // about every 3h and the poller runs every 2h, so 6h means the poller was
  // down, not that conditions held. Same figure as the server's
  // SOLAR_LEAD_IN_HOURS and the Solar page's gap rule.
  const STALE_MS = 6 * HOUR_MS;

  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function sqlUtc(ms) {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  }

  // Raw rows -> [{ t, sfi, a, k, sunspots }], oldest first. Rows with no
  // usable time are dropped. An SFI of 0 is hamqsl's "no data", never a
  // real flux (the quiet-sun floor is in the 60s), so it becomes null.
  function normalize(rows) {
    const out = [];
    for (const r of rows || []) {
      if (!r) continue;
      // Already normalized (has a numeric t): pass through.
      const t = typeof r.t === 'number'
        ? r.t
        : new Date(String(r.fetched_at || '').replace(' ', 'T') + 'Z').getTime();
      if (!Number.isFinite(t)) continue;
      const sfi = num(r.sfi);
      out.push({
        t,
        sfi: sfi && sfi > 0 ? sfi : null,
        a: num(r.a != null ? r.a : r.a_index),
        k: num(r.k != null ? r.k : r.k_index),
        sunspots: num(r.sunspots),
      });
    }
    return out.sort((x, y) => x.t - y.t);
  }

  // The reading in effect at `tMs`: the newest one at or before it, unless
  // that one is stale. `readings` must be normalize()d.
  function readingAt(readings, tMs) {
    let hit = null;
    for (const r of readings) {
      if (r.t <= tMs) hit = r; else break;
    }
    return hit && tMs - hit.t <= STALE_MS ? hit : null;
  }

  // The reading that stands for clock hour `hourIdx` (epoch hours): the
  // newest one known by the end of that hour.
  function readingForHour(readings, hourIdx) {
    return readingAt(readings, (hourIdx + 1) * HOUR_MS - 1);
  }

  // NOAA's reading of a K-index, same wording as the Solar page (solar.js
  // kLabel): below 4 quiet, 4 active, 5+ a geomagnetic storm G1..G5.
  function kLevel(k) {
    const n = num(k);
    if (n == null) return '';
    if (n >= 5) return `G${Math.min(5, Math.round(n) - 4)} storm`;
    if (n >= 4) return 'active';
    return 'quiet';
  }

  // NOAA's bands for the A-index, same as solar.js A_LEVELS.
  function aLevel(a) {
    const n = num(a);
    if (n == null) return '';
    if (n <= 7) return 'quiet';
    if (n <= 15) return 'unsettled';
    if (n <= 29) return 'active';
    if (n <= 49) return 'minor storm';
    if (n <= 99) return 'major storm';
    return 'severe storm';
  }

  function range(readings, field) {
    const vals = readings.map((r) => r[field]).filter((v) => v != null);
    if (!vals.length) return null;
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }

  // "119" or "119–124".
  function fmtRange(r) {
    if (!r) return '—';
    return r.min === r.max ? String(r.min) : `${r.min}–${r.max}`;
  }

  // Conditions over a session running fromMs..toMs: the readings that
  // apply (the one in effect at the start, then every one during it), the
  // min/max of each index over them, and the newest. null when no reading
  // applies.
  function summary(readings, fromMs, toMs) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
    const first = readingAt(readings, fromMs);
    const during = readings.filter((r) => r.t > fromMs && r.t <= toMs);
    const span = first ? [first, ...during] : during;
    if (!span.length) return null;
    return {
      count: span.length,
      sfi: range(span, 'sfi'),
      sunspots: range(span, 'sunspots'),
      a: range(span, 'a'),
      k: range(span, 'k'),
      latest: span[span.length - 1],
    };
  }

  // n per hour over `hrs` hours, one decimal; 0 when there are no hours.
  function perHour(n, hrs) {
    return hrs ? Math.round((n / hrs) * 10) / 10 : 0;
  }

  // Rate against the K-index. Every clock hour with at least one QSO is an
  // "active hour"; each takes the K in effect that hour, and hours are
  // grouped by K. Rates are per active hour at that K, so off time doesn't
  // dilute them.
  //
  //   timeFn(q)   -> ms (NaN to skip)
  //   pointsFn(q) -> QSO points (optional)
  //   keyFn(q)    -> a breakdown key, e.g. continent or band (optional)
  //
  // Returns { rows, keys, total, unknownHours, unknownQ }:
  //   rows  [{ k, level, hours, q, pts, qph, pph, byKey: {key: count} }], K ascending
  //   keys  breakdown keys present, busiest first
  //   total { hours, q, pts, qph, pph } over the rows
  //   unknownHours / unknownQ: active hours (and their QSOs) with no
  //   usable K reading -- left out of the rows.
  function rateByK(qsos, readings, { timeFn, pointsFn, keyFn } = {}) {
    const hours = new Map(); // hourIdx -> { q, pts, byKey }
    for (const q of qsos || []) {
      const t = timeFn(q);
      if (!Number.isFinite(t)) continue;
      const h = Math.floor(t / HOUR_MS);
      let e = hours.get(h);
      if (!e) { e = { q: 0, pts: 0, byKey: {} }; hours.set(h, e); }
      e.q += 1;
      if (pointsFn) e.pts += pointsFn(q) || 0;
      if (keyFn) {
        const key = keyFn(q);
        e.byKey[key] = (e.byKey[key] || 0) + 1;
      }
    }

    const byK = new Map(); // k -> { hours, q, pts, byKey }
    const keyTotals = {};
    let unknownHours = 0;
    let unknownQ = 0;
    for (const [h, e] of hours) {
      const r = readingForHour(readings, h);
      if (!r || r.k == null) { unknownHours += 1; unknownQ += e.q; continue; }
      let g = byK.get(r.k);
      if (!g) { g = { hours: 0, q: 0, pts: 0, byKey: {} }; byK.set(r.k, g); }
      g.hours += 1;
      g.q += e.q;
      g.pts += e.pts;
      for (const [key, n] of Object.entries(e.byKey)) {
        g.byKey[key] = (g.byKey[key] || 0) + n;
        keyTotals[key] = (keyTotals[key] || 0) + n;
      }
    }

    const per = perHour;
    const rows = [...byK.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, g]) => ({
        k, level: kLevel(k), hours: g.hours, q: g.q, pts: g.pts,
        qph: per(g.q, g.hours), pph: per(g.pts, g.hours), byKey: g.byKey,
      }));
    const tot = rows.reduce(
      (a, r) => ({ hours: a.hours + r.hours, q: a.q + r.q, pts: a.pts + r.pts }),
      { hours: 0, q: 0, pts: 0 },
    );
    return {
      rows,
      keys: Object.keys(keyTotals).sort((a, b) => keyTotals[b] - keyTotals[a]),
      total: { ...tot, qph: per(tot.q, tot.hours), pph: per(tot.pts, tot.hours) },
      unknownHours,
      unknownQ,
    };
  }

  // Active hours at K >= minK, out of all active hours with a reading.
  function disturbedHours(byK, minK = 4) {
    const hit = byK.rows.filter((r) => r.k >= minK).reduce((s, r) => s + r.hours, 0);
    return { hours: hit, of: byK.total.hours };
  }

  // Readings covering fromMs..toMs from the server (which also returns the
  // one in effect at the start). [] on any failure -- conditions are
  // context, never worth breaking a page over.
  async function fetchForSpan(fromMs, toMs) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return [];
    try {
      const r = await fetch(`/api/solar/history?from=${encodeURIComponent(sqlUtc(fromMs))}&to=${encodeURIComponent(sqlUtc(toMs))}`);
      const rows = r.ok ? await r.json() : [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  // Readings for a saved analysis (`body` from GET /api/analyze/<id>). A
  // from-live snapshot carries its own (body.solar); anything else -- an
  // older snapshot, an uploaded Cabrillo/ADIF -- is looked up by the log's
  // own time span, which finds readings only if this server was polling
  // through that contest.
  async function forSavedLog(body, timeFn) {
    if (!body) return [];
    if (Array.isArray(body.solar) && body.solar.length) return body.solar;
    const times = (body.qsos || []).map(timeFn).filter((t) => Number.isFinite(t));
    if (!times.length) return [];
    let min = times[0];
    let max = times[0];
    for (const t of times) { if (t < min) min = t; if (t > max) max = t; }
    return fetchForSpan(min, max);
  }

  return {
    HOUR_MS, STALE_MS, sqlUtc, normalize, readingAt, readingForHour, kLevel, aLevel,
    range, fmtRange, summary, perHour, rateByK, disturbedHours, fetchForSpan, forSavedLog,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContestConditions;
}
