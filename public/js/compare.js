// Not type="module" -- Alpine x-data="compare()" is evaluated in global
// scope. Compares two saved analyses (GET /api/analyze/<id>) side by side:
// headline metrics with a delta column, a per-band QSO table, and a set of
// Chart.js breakdowns (rate/cumulative over elapsed time, band/mode/
// continent/run-vs-S&P share, and -- for a from-live analysis only --
// space-weather conditions during the session). Both logs are public by
// id, so this page needs no auth.
function compare() {
  // Chart.js instances live here, outside the Alpine-wrapped object --
  // same reasoning as charts.js: Alpine's reactive Proxy breaks a Chart
  // instance's internal WeakMap lookups on subsequent .update() calls if
  // it's stashed as a property of the x-data object itself.
  let rateChart = null;
  let cumChart = null;
  let bandChart = null;
  let modeChart = null;
  let contChart = null;
  let runspChart = null;
  let solarAChart = null;
  let solarBChart = null;

  return {
    aId: '', bId: '',
    a: null, b: null,        // { meta, qsos }
    solarA: [], solarB: [],  // solar_snapshots rows spanning each log's own session (live-sourced only)
    loading: true,
    error: '',

    async init() {
      const p = new URLSearchParams(location.search);
      this.aId = idFrom(p.get('a'));
      this.bId = idFrom(p.get('b'));
      if (!this.aId || !this.bId) {
        this.error = 'Need two analysis ids: /compare?a=<id>&b=<id>';
        this.loading = false;
        return;
      }
      try {
        const [a, b] = await Promise.all([load(this.aId), load(this.bId)]);
        this.a = a;
        this.b = b;
        [this.solarA, this.solarB] = await Promise.all([fetchSolarFor(a), fetchSolarFor(b)]);
      } catch (err) {
        this.error = String(err.message || err);
      }
      this.loading = false;
    },

    get ready() { return !!(this.a && this.b); },

    // [{ label, a, b, delta, fmt }]
    get metricRows() {
      if (!this.ready) return [];
      const A = summarize(this.a);
      const B = summarize(this.b);
      const rows = [
        ['QSOs', A.qsos, B.qsos],
        ['Points', A.points, B.points, A.hasPoints || B.hasPoints],
        ['Mults', A.mults, B.mults, A.hasMults || B.hasMults],
        ['Pts / QSO', A.ppq, B.ppq, A.hasPoints || B.hasPoints, 2],
        ['DXCC', A.dxcc, B.dxcc],
        ['CQ zones', A.zones, B.zones],
        ['Bands', A.bands, B.bands],
        ['Hours active', A.hours, B.hours],
        ['Avg rate /h', A.rate, B.rate],
        ['Best 60 min', A.best60, B.best60],
      ];
      return rows
        .filter((r) => r[3] === undefined || r[3])
        .map(([label, a, b, , dp]) => ({
          label,
          a: fmtNum(a, dp),
          b: fmtNum(b, dp),
          delta: fmtDelta(b - a, dp),
          up: b - a > 0,
          down: b - a < 0,
        }));
    },

    get bandRows() {
      if (!this.ready) return [];
      const A = byBand(this.a.qsos);
      const B = byBand(this.b.qsos);
      const bands = [...new Set([...A.keys(), ...B.keys()])]
        .sort((x, y) => bandKey(x) - bandKey(y));
      return bands.map((band) => {
        const a = A.get(band) || 0;
        const b = B.get(band) || 0;
        return {
          band: bandLabel(band),
          a, b,
          delta: fmtDelta(b - a),
          up: b - a > 0, down: b - a < 0,
        };
      });
    },

    get hasRunFlag() {
      return !!(this.ready && (this.a.meta.has_run_flag || this.b.meta.has_run_flag));
    },

    get solarReady() {
      return this.ready && (this.a.meta.format === 'live' || this.b.meta.format === 'live');
    },

    // ---- Chart renderers, called from x-effect on each canvas ----------

    renderRateChart() {
      if (!this.ready) return;
      rateChart = upsertChart(rateChart, 'cmpRateChart', buildElapsedOverlay(
        this.a.qsos, this.b.qsos, 'rate', 'QSOs/hr',
      ));
    },

    renderCumulativeChart() {
      if (!this.ready) return;
      cumChart = upsertChart(cumChart, 'cmpCumChart', buildElapsedOverlay(
        this.a.qsos, this.b.qsos, 'cumulative', 'Cumulative QSOs',
      ));
    },

    renderBandChart() {
      if (!this.ready) return;
      const A = byBand(this.a.qsos);
      const B = byBand(this.b.qsos);
      const bands = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => bandKey(x) - bandKey(y));
      bandChart = upsertChart(bandChart, 'cmpBandChart', buildGroupedBar(
        bands.map(bandLabel), bands.map((b) => A.get(b) || 0), bands.map((b) => B.get(b) || 0),
      ));
    },

    renderModeChart() {
      if (!this.ready) return;
      const A = groupCount(this.a.qsos, (q) => modeGroup(q.mode));
      const B = groupCount(this.b.qsos, (q) => modeGroup(q.mode));
      const modes = ['CW', 'PH', 'DG', '—'].filter((m) => A.has(m) || B.has(m));
      modeChart = upsertChart(modeChart, 'cmpModeChart', buildGroupedBar(
        modes, modes.map((m) => A.get(m) || 0), modes.map((m) => B.get(m) || 0),
      ));
    },

    renderContinentChart() {
      if (!this.ready) return;
      const A = groupCount(this.a.qsos, (q) => (q.continent || '—').toUpperCase());
      const B = groupCount(this.b.qsos, (q) => (q.continent || '—').toUpperCase());
      const conts = CONTINENT_ORDER.filter((c) => A.has(c) || B.has(c));
      contChart = upsertChart(contChart, 'cmpContChart', buildGroupedBar(
        conts, conts.map((c) => A.get(c) || 0), conts.map((c) => B.get(c) || 0),
      ));
    },

    renderRunSpChart() {
      if (!this.ready || !this.hasRunFlag) return;
      const A = runSpCounts(this.a.qsos);
      const B = runSpCounts(this.b.qsos);
      runspChart = upsertChart(runspChart, 'cmpRunSpChart', buildGroupedBar(
        ['Run', 'S&P'], [A.run, A.sp], [B.run, B.sp],
      ));
    },

    renderSolarChart(which) {
      const rows = which === 'a' ? this.solarA : this.solarB;
      const cfg = buildSolarChart(rows);
      if (which === 'a') solarAChart = upsertChart(solarAChart, 'cmpSolarAChart', cfg);
      else solarBChart = upsertChart(solarBChart, 'cmpSolarBChart', cfg);
    },
  };
}

// --- helpers (module scope) ---------------------------------------------

function idFrom(s) {
  const m = String(s || '').trim().match(/([A-Za-z0-9_-]{4,40})\/?$/);
  return m ? m[1] : '';
}

async function load(id) {
  const r = await fetch(`/api/analyze/${encodeURIComponent(id)}`);
  if (r.status === 404) throw new Error(`Analysis "${id}" not found or expired`);
  if (!r.ok) throw new Error(`Failed to load "${id}" (${r.status})`);
  return r.json();
}

function qTime(q) {
  const raw = q.n1mm_timestamp || q.logged_at;
  if (!raw) return NaN;
  const t = new Date(raw.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? NaN : t;
}

function bestWindow(times, windowMs) {
  if (!times.length) return 0;
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (j < i) j = i;
    while (j + 1 < times.length && times[j + 1] - times[i] < windowMs) j += 1;
    if (j - i + 1 > best) best = j - i + 1;
  }
  return best;
}

function summarize(log) {
  const qs = log.qsos || [];
  const meta = log.meta || {};
  const times = qs.map(qTime).filter((t) => !Number.isNaN(t)).sort((x, y) => x - y);
  const points = qs.reduce((s, q) => s + (Number(q.points) || 0), 0);
  const mults = qs.reduce((s, q) => s
    + (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0), 0);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const hrs = span / 3600000;
  const distinct = (fn) => new Set(qs.map(fn).filter(Boolean)).size;
  return {
    qsos: qs.length,
    points,
    mults,
    ppq: qs.length ? points / qs.length : 0,
    hasPoints: !!meta.has_points,
    hasMults: !!meta.has_mults,
    dxcc: distinct((q) => q.countryprefix),
    zones: distinct((q) => (q.zone && q.zone !== '0' ? q.zone : '')),
    bands: distinct((q) => q.band),
    hours: new Set(times.map((t) => Math.floor(t / 3600000))).size,
    rate: hrs > 0 ? Math.round(qs.length / hrs) : 0,
    best60: bestWindow(times, 3600000),
  };
}

function byBand(qsos) {
  const m = new Map();
  for (const q of qsos || []) {
    const b = q.band || '—';
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}

function groupCount(qsos, keyFn) {
  const m = new Map();
  for (const q of qsos || []) {
    const k = keyFn(q);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function runSpCounts(qsos) {
  let run = 0;
  let sp = 0;
  for (const q of qsos || []) {
    if (q.is_run_qso) run += 1;
    else sp += 1;
  }
  return { run, sp };
}

function bandKey(b) {
  const n = parseFloat(b);
  return Number.isNaN(n) ? Infinity : n;
}

function bandLabel(band) {
  const n = parseFloat(band);
  if (Number.isNaN(n)) return band || '—';
  const ranges = [
    [1.7, 2.1, '160m'], [3.4, 4.1, '80m'], [5.2, 5.5, '60m'], [6.9, 7.4, '40m'],
    [10.0, 10.2, '30m'], [13.9, 14.5, '20m'], [18.0, 18.2, '17m'], [20.9, 21.5, '15m'],
    [24.8, 25.1, '12m'], [27.9, 29.8, '10m'], [49, 55, '6m'], [69, 75, '4m'],
    [143, 149, '2m'], [218, 226, '1.25m'], [419, 451, '70cm'],
  ];
  const hit = ranges.find(([lo, hi]) => n >= lo && n < hi);
  return hit ? hit[2] : String(band);
}

// Same CW / PH / DG buckets as charts.js/stats.js modeGroup().
function modeGroup(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return '—';
  if (m === 'CW') return 'CW';
  if (['USB', 'LSB', 'SSB', 'AM', 'FM', 'PH', 'PHONE', 'DV', 'FMN'].includes(m)) return 'PH';
  return 'DG';
}

function fmtNum(n, dp) {
  if (dp) return Number(n).toFixed(dp);
  return Number(n).toLocaleString();
}

function fmtDelta(n, dp) {
  if (!n) return '—';
  const s = dp ? Math.abs(n).toFixed(dp) : Math.abs(Math.round(n)).toLocaleString();
  return (n > 0 ? '+' : '−') + s;
}

// ===========================================================================
// Charts. A vs B is always the same two colors (dataviz reference palette,
// dark-mode slots 0/1 -- the same blue/orange pairing charts.js uses for its
// rate/score charts, so "A" and "B" read consistently with the rest of the
// app rather than inventing a new color language just for this page).
// ===========================================================================

const COLOR_A = '#3987e5';
const COLOR_B = '#d95926';
const CATEGORICAL_COLORS = [
  '#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767',
];
const CONTINENT_ORDER = ['NA', 'SA', 'EU', 'AS', 'AF', 'OC', 'AN', '—'];

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

function themeColors() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light
    ? { muted: '#5b5a52', text: '#1a1a1a', grid: '#c7c2a8' }
    : { muted: '#8b949e', text: '#e6edf3', grid: '#262626' };
}

// Same detached-canvas guard as charts.js's upsertChart(): a template x-if
// (e.g. the Run vs S&P card, gated on hasRunFlag) can remove and re-add a
// canvas out from under a live Chart instance. A null cfg tears the chart
// down so the box goes blank rather than showing stale data.
function upsertChart(existingChart, canvasId, cfg) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return existingChart;

  if (existingChart && existingChart.canvas !== canvas) {
    existingChart.destroy();
    existingChart = null;
  }
  if (!cfg) {
    if (existingChart) existingChart.destroy();
    return null;
  }
  if (existingChart) {
    existingChart.data = cfg.data;
    existingChart.options = cfg.options;
    existingChart.update();
    return existingChart;
  }
  return new Chart(canvas, cfg);
}

// Elapsed-time-since-start bucketing, independently per log -- two saved
// analyses are almost never from the same calendar date, so overlaying them
// on wall-clock time would misalign entirely. "+Hh MMm since first QSO" is
// the axis that actually lines two different contest instances up. The
// bucket width is shared (picked from whichever log has the longer span) so
// both series read at the same resolution.
function autoBucketMs(qsosA, qsosB) {
  const spanMinutes = (qsos) => {
    const times = qsos.map(qTime).filter((t) => !Number.isNaN(t));
    if (times.length < 2) return 0;
    return (Math.max(...times) - Math.min(...times)) / 60000;
  };
  const span = Math.max(spanMinutes(qsosA), spanMinutes(qsosB));
  const targetPoints = 60;
  const sizes = [5, 10, 15, 30, 60, 120];
  const bucketMin = sizes.find((m) => span / m <= targetPoints) || sizes[sizes.length - 1];
  return bucketMin * 60000;
}

// { x: elapsedHours, y: value } points -- a linear x-axis rather than a
// shared labels array, since A and B independently may run different
// lengths of time and don't need identical bucket counts to overlay
// correctly on the same numeric axis.
function elapsedPoints(qsos, bucketMs, which) {
  const times = qsos.map(qTime).filter((t) => !Number.isNaN(t)).sort((x, y) => x - y);
  if (!times.length) return [];
  const start = times[0];
  const counts = new Map();
  for (const t of times) {
    const b = Math.floor((t - start) / bucketMs) * bucketMs;
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  const buckets = [...counts.keys()].sort((x, y) => x - y);
  if (which === 'rate') {
    const perHour = 3600000 / bucketMs;
    return buckets.map((b) => ({ x: b / 3600000, y: Math.round(counts.get(b) * perHour) }));
  }
  let run = 0;
  return buckets.map((b) => ({ x: b / 3600000, y: (run += counts.get(b)) }));
}

function elapsedLabel(hours) {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `+${h}h${String(m).padStart(2, '0')}m`;
}

function elapsedChartOptions() {
  const c = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: true, labels: { color: c.text, boxWidth: 12 } },
      tooltip: { callbacks: { title: (items) => (items.length ? elapsedLabel(items[0].parsed.x) : '') } },
    },
    scales: {
      x: {
        type: 'linear',
        ticks: { color: c.muted, callback: (v) => elapsedLabel(v) },
        grid: { color: c.grid },
        title: { display: true, text: 'Elapsed time since first QSO', color: c.muted },
      },
      y: {
        beginAtZero: true,
        ticks: { color: c.text, precision: 0 },
        grid: { color: c.grid },
      },
    },
  };
}

function buildElapsedOverlay(qsosA, qsosB, which, seriesLabel) {
  if (!qsosA.length && !qsosB.length) return null;
  const bucketMs = autoBucketMs(qsosA, qsosB);
  const pointsA = elapsedPoints(qsosA, bucketMs, which);
  const pointsB = elapsedPoints(qsosB, bucketMs, which);
  if (!pointsA.length && !pointsB.length) return null;
  return {
    type: 'line',
    data: {
      datasets: [
        {
          label: `A · ${seriesLabel}`, data: pointsA,
          borderColor: COLOR_A, backgroundColor: hexA(COLOR_A, 0.12),
          fill: which === 'cumulative', tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
        {
          label: `B · ${seriesLabel}`, data: pointsB,
          borderColor: COLOR_B, backgroundColor: hexA(COLOR_B, 0.12),
          fill: which === 'cumulative', tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
      ],
    },
    options: elapsedChartOptions(),
  };
}

function groupedBarOptions() {
  const c = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: { legend: { display: true, labels: { color: c.text, boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: c.muted }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { color: c.text, precision: 0 }, grid: { color: c.grid } },
    },
  };
}

function buildGroupedBar(labels, aData, bData) {
  if (!labels.length) return null;
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'A', data: aData, backgroundColor: COLOR_A, borderRadius: 4 },
        { label: 'B', data: bData, backgroundColor: COLOR_B, borderRadius: 4 },
      ],
    },
    options: groupedBarOptions(),
  };
}

// Space-weather conditions spanning a from-live analysis's own session
// (see docs/ANALYZER.md "Not done" -- this is that feature). Only ever
// fetched for a format === 'live' log; an uploaded log from an arbitrary
// past date has no captured solar, so fetchSolarFor() short-circuits.
async function fetchSolarFor(log) {
  if (!log || log.meta.format !== 'live') return [];
  const times = (log.qsos || []).map(qTime).filter((t) => !Number.isNaN(t));
  if (times.length < 2) return [];
  const toSqlUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const from = toSqlUtc(Math.min(...times));
  const to = toSqlUtc(Math.max(...times));
  try {
    const r = await fetch(`/api/solar/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    return r.ok ? await r.json() : [];
  } catch {
    return [];
  }
}

function dualAxisOptions() {
  const c = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: { legend: { display: true, labels: { color: c.text, boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: c.muted, maxTicksLimit: 8, autoSkip: true }, grid: { color: c.grid } },
      y: {
        position: 'left', ticks: { color: c.text }, grid: { color: c.grid },
        title: { display: true, text: 'SFI', color: c.muted },
      },
      y1: {
        position: 'right', ticks: { color: c.text }, grid: { display: false },
        title: { display: true, text: 'K-index', color: c.muted },
      },
    },
  };
}

function buildSolarChart(rows) {
  if (!rows || !rows.length) return null;
  const labels = rows.map((r) => new Date(r.fetched_at.replace(' ', 'T') + 'Z')
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'SFI', data: rows.map((r) => r.sfi), yAxisID: 'y',
          borderColor: CATEGORICAL_COLORS[3], backgroundColor: hexA(CATEGORICAL_COLORS[3], 0.15),
          tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
        {
          label: 'K-index', data: rows.map((r) => r.k_index), yAxisID: 'y1',
          borderColor: CATEGORICAL_COLORS[6], backgroundColor: hexA(CATEGORICAL_COLORS[6], 0.15),
          tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
      ],
    },
    options: dualAxisOptions(),
  };
}
