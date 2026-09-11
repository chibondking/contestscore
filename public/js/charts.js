// Not type="module" -- same reason as dashboard.js/admin.js: Alpine's
// x-data="charts()" is evaluated in global scope, and a module's top-level
// declarations don't land there.
function charts() {
  // Chart.js instances live here, in a plain closure variable -- NOT as
  // properties on the object below. Alpine wraps everything it returns from
  // x-data in a reactive Proxy (it's Vue-based under the hood); a Chart.js
  // instance stashed inside that Proxy gets its internal state/WeakMap
  // lookups broken on subsequent access, so the first render works but later
  // .update() calls silently no-op. Keeping them outside Alpine's reactivity
  // entirely is the fix -- this is exactly why charts.html's periodic
  // fetchData() poll never visibly redrew the chart.
  let rateChart = null;
  let scoreChart = null;
  let operatorQsoChart = null;
  let operatorRateChart = null;
  let operatorScoreChart = null;
  let operatorMultChart = null;

  // The "more charts" grid below (see extraCharts / renderExtra) is
  // spec-driven rather than one named closure var per canvas -- there are a
  // dozen-plus of them. Same rule as above though: the live Chart.js
  // instances are kept in this plain Map, never on the Alpine object.
  const extra = new Map(); // spec.id -> Chart

  return {
    qsos: [],
    scoreHistory: [],
    // "At a glance" is the default for a 48-hour contest -- the full
    // per-operator time-series breakdown is real detail a viewer can opt
    // into, not something to show by default on every load. Per-viewer
    // convenience, so localStorage (not a server-side setting) is the right
    // place for it.
    detailed: false,
    // Set from ?log=<id> -- render a saved analyzed log instead of the live
    // contest, with no socket/poll wiring (an uploaded log never changes).
    logId: null,
    logMeta: null,

    async init() {
      try {
        this.detailed = localStorage.getItem('contestpulse_charts_detailed') === '1';
      } catch {
        // private browsing / storage disabled -- just default to simple
      }
      this.logId = new URLSearchParams(location.search).get('log');
      await this.fetchData();
      if (this.logId) return;
      // Live updates via socket, same events dashboard.js listens for --
      // a 48-hour contest shouldn't need a manual refresh to see a chart
      // move. The interval stays as a fallback in case an event is missed
      // (e.g. a brief disconnect), not as the primary update path anymore.
      const socket = io();
      const refresh = () => this.fetchData();
      socket.on('contact:new', refresh);
      socket.on('contact:delete', refresh);
      socket.on('score:update', refresh);
      socket.on('db:cleared', refresh);
      setInterval(() => this.fetchData(), 30000);
    },

    saveDetailed() {
      try {
        localStorage.setItem('contestpulse_charts_detailed', this.detailed ? '1' : '0');
      } catch {
        // ignore -- not worth surfacing an error just for a remembered toggle
      }
    },

    // Picks a bucket width from the actual span of logged QSOs so a 48-hour
    // contest doesn't render ~200 tightly-packed 15-minute points where a
    // 2-hour club contest would only need a couple. Snaps up to one of a
    // few human-friendly sizes rather than an arbitrary computed value.
    autoBucketMinutes() {
      const times = this.qsos
        .map((q) => q.logged_at && new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime())
        .filter((t) => t && !Number.isNaN(t));
      if (times.length < 2) return 15;
      const spanMinutes = (Math.max(...times) - Math.min(...times)) / 60000;
      const targetPoints = 60; // roughly this many points across the full span
      const sizes = [5, 10, 15, 30, 60, 120];
      return sizes.find((m) => spanMinutes / m <= targetPoints) || sizes[sizes.length - 1];
    },

    async fetchData() {
      try {
        if (this.logId) {
          const r = await fetch(`/api/analyze/${encodeURIComponent(this.logId)}`);
          const body = r.ok ? await r.json() : null;
          this.qsos = body ? (body.qsos || []) : [];
          this.logMeta = body ? body.meta : null;
          // An uploaded log has no score-broadcast history; the Score Over
          // Time card falls back to its own "no score data yet" empty state.
          this.scoreHistory = [];
          return;
        }
        const [qsos, scoreHistory] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score/history').then((r) => r.json()),
        ]);
        this.qsos = qsos;
        this.scoreHistory = scoreHistory;
      } catch (err) {
        console.error('Failed to load chart data:', err);
      }
    },

    // Buckets the full QSO log into fixed windows and extrapolates each to
    // a QSOs/hour rate, the same idea as the main dashboard's live 10/30/60
    // min windows but as a full-contest time series instead of "right now".
    // Computed client-side from the already-loaded qsos array rather than a
    // new backend endpoint.
    rateOverTime(bucketMinutes = this.autoBucketMinutes()) {
      const bucketMs = bucketMinutes * 60000;
      const counts = new Map();
      for (const q of this.qsos) {
        // logged_at is SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS",
        // UTC, no separator/offset marker) -- needs both fixed up for Date to
        // parse it as UTC reliably.
        const t = new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime();
        if (Number.isNaN(t)) continue;
        const bucket = Math.floor(t / bucketMs) * bucketMs;
        counts.set(bucket, (counts.get(bucket) || 0) + 1);
      }
      const perHour = 60 / bucketMinutes;
      return [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, count]) => ({ t: bucket, rate: Math.round(count * perHour) }));
    },

    renderRateChart() {
      const canvas = document.getElementById('rateChart');
      if (!canvas || typeof Chart === 'undefined') return;

      const points = this.rateOverTime();
      const labels = points.map((p) => new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const values = points.map((p) => p.rate);

      if (rateChart) {
        rateChart.data.labels = labels;
        rateChart.data.datasets[0].data = values;
        rateChart.update();
        return;
      }

      rateChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'QSOs/hr',
            data: values,
            borderColor: '#2a78d6', // dataviz reference palette, dark-mode slot 1 (blue)
            backgroundColor: 'rgba(42, 120, 214, 0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          }],
        },
        options: trendChartOptions(),
      });
    },

    // Total QSOs per operator, as of right now -- a bar chart, not a time
    // series. This is the "at a glance" panel that stays visible outside
    // detailed mode: over a 48-hour contest, "who's worked the most QSOs
    // so far" is a snapshot question, not a trend a viewer needs to watch
    // unfold minute by minute (that's what Detailed view's Rate by
    // Operator is for).
    operatorTotals() {
      const totals = new Map();
      for (const q of this.qsos) {
        const op = q.operator || '—';
        totals.set(op, (totals.get(op) || 0) + 1);
      }
      return [...totals.entries()]
        .map(([operator, qsos]) => ({ operator, qsos }))
        .sort((a, b) => b.qsos - a.qsos);
    },

    renderOperatorQsoChart() {
      const canvas = document.getElementById('operatorQsoChart');
      if (!canvas || typeof Chart === 'undefined') return;

      const totals = this.operatorTotals();
      const labels = totals.map((t) => t.operator);
      const values = totals.map((t) => t.qsos);
      // Every per-operator chart on the page colours an op the same way --
      // by its rank in total QSOs (busiest op = palette slot 0) -- so a
      // colour means the same operator across the QSO, Rate, Score and Mult
      // charts. See operatorColorMap().
      const colorFor = operatorColorMap(this.qsos);
      const colors = labels.map((op) => colorFor.get(op));

      if (operatorQsoChart) {
        operatorQsoChart.data.labels = labels;
        operatorQsoChart.data.datasets[0].data = values;
        operatorQsoChart.data.datasets[0].backgroundColor = colors;
        operatorQsoChart.update();
        return;
      }

      operatorQsoChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'QSOs', data: values, backgroundColor: colors, borderRadius: 4 }],
        },
        options: barChartOptions(),
      });
    },

    // QSOs per clock-hour, stacked by operator: each hour's bar is the
    // station's total for that hour, split into who made them. A 1-hour
    // bucket count is itself the hourly rate, so this is "rate by operator"
    // read as a column chart rather than several overlapping lines.
    renderOperatorRateChart() {
      operatorRateChart = upsertChart(
        operatorRateChart, 'operatorRateChart', buildOperatorRateByHour(this.qsos),
      );
    },

    // One bar per operator: total QSO points contributed so far. "Score
    // contribution" as a share-of-the-whole snapshot, matching the QSOs by
    // Operator bar above rather than a running-total line.
    renderOperatorScoreChart() {
      operatorScoreChart = upsertChart(
        operatorScoreChart, 'operatorScoreChart',
        buildOperatorContribution(this.qsos, (q) => Number(q.points) || 0, 'Points'),
      );
    },

    // One bar per operator: total multiplier credit (is_mult1/2/3, the
    // N1MM per-QSO flags on the qso row -- not score_snapshots.mults, which
    // is a per-broadcast contest total and not attributable to an operator).
    renderOperatorMultChart() {
      operatorMultChart = upsertChart(
        operatorMultChart, 'operatorMultChart',
        buildOperatorContribution(this.qsos, multCount, 'Mults'),
      );
    },

    renderScoreChart() {
      const canvas = document.getElementById('scoreChart');
      if (!canvas || typeof Chart === 'undefined') return;

      const labels = this.scoreHistory.map((s) => new Date(s.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const values = this.scoreHistory.map((s) => s.points);

      if (scoreChart) {
        scoreChart.data.labels = labels;
        scoreChart.data.datasets[0].data = values;
        scoreChart.update();
        return;
      }

      scoreChart = new Chart(canvas, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Points',
            data: values,
            borderColor: '#eb6834', // dataviz reference palette, dark-mode slot 2 (orange) -- a distinct hue from the rate chart, shown on a separate panel
            backgroundColor: 'rgba(235, 104, 52, 0.15)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          }],
        },
        options: trendChartOptions(),
      });
    },

    // ================================================================
    // "More charts" -- a spec-driven grid of additional breakdowns, the
    // visual counterpart to the Stats page's tables. Each spec names a
    // canvas id, a title, whether it wants a full-width row and a squarer
    // box (doughnuts), and a build(qsos, scoreHistory, bucketMinutes) that
    // returns a ready Chart.js config (or null when there's no data). All
    // keyed off logged_at like the rest of this page -- deliberately not
    // n1mm_timestamp (that's the Stats page's choice; see stats.js
    // qsoTime()).
    // ================================================================
    get extraCharts() {
      // When viewing an uploaded log, drop the charts whose data the source
      // format didn't carry (a bare Cabrillo has no points / mults / run
      // flag), rather than drawing an all-zeros chart.
      const m = this.logMeta;
      if (!m) return EXTRA_CHART_SPECS;
      return EXTRA_CHART_SPECS.filter((s) => !s.need || m[`has_${s.need}`]);
    },

    renderExtra(spec) {
      const canvas = document.getElementById(spec.id);
      if (!canvas || typeof Chart === 'undefined') return;

      const cfg = spec.build(this.qsos, this.scoreHistory, this.autoBucketMinutes());
      const current = extra.get(spec.id);

      if (!cfg) {
        // No data yet -- tear down a stale chart so the box goes properly
        // blank rather than showing the last contest's shape.
        if (current) { current.destroy(); extra.delete(spec.id); }
        return;
      }

      // Same detached-canvas guard as upsertChart(): the
      // x-if="qsos.length > 0" wrapper can remove and re-create these
      // canvases, orphaning the old instance.
      if (current && current.canvas !== canvas) {
        current.destroy();
        extra.delete(spec.id);
      }

      const live = extra.get(spec.id);
      if (live) {
        live.data = cfg.data;
        live.options = cfg.options;
        live.update();
        return;
      }
      extra.set(spec.id, new Chart(canvas, cfg));
    },
  };
}

// dataviz reference palette, dark-mode categorical slots, in the palette's
// fixed (CVD-safe) order -- never cycled/reassigned per filter, only ever
// consumed in this order as operators are discovered. Contest ops rarely
// exceed a handful per station; past 8 the color repeats rather than
// growing an unvalidated 9th hue (see the dataviz skill: a 9th categorical
// series folds into "Other"/small multiples rather than inventing a color).
const CATEGORICAL_COLORS = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
];

// Create-or-update a Chart.js instance for a canvas that Alpine may have
// swapped out from under us (the per-operator cards live inside
// charts.html's `x-if="detailed"` block, so their <canvas> is destroyed
// and rebuilt every time the toggle flips). `existingChart` is the
// caller's own closure variable; this returns the instance to store back
// into it. A null `cfg` means "no data" -- any live chart is torn down so
// the box goes blank instead of showing the last render.
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

// operator -> palette colour, assigned by the operator's rank in total
// QSOs (busiest = slot 0). Every per-operator chart uses this, so a colour
// identifies the same operator across the QSO / Rate / Score / Mult charts.
function operatorColorMap(qsos) {
  const totals = new Map();
  for (const q of qsos) {
    const op = q.operator || '—';
    totals.set(op, (totals.get(op) || 0) + 1);
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([op]) => op);
  return new Map(ranked.map((op, i) => [op, CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]]));
}

// QSOs per clock-hour (fixed 60-min buckets, UTC-aligned -- same timeAxis
// the rest of the page uses), stacked by operator. Each hour's column is
// the station's total for that hour; the segments are who made them.
function buildOperatorRateByHour(qsos) {
  if (!qsos.length) return null;
  const { buckets, bucketMs, label: fmt } = timeAxis(qsos, 60);
  if (!buckets.length) return null;

  const colorFor = operatorColorMap(qsos);
  const ops = [...colorFor.keys()];
  const grid = new Map(ops.map((op) => [op, new Map(buckets.map((b) => [b, 0]))]));
  for (const q of qsos) {
    const t = qLoggedTime(q);
    if (Number.isNaN(t)) continue;
    const b = Math.floor(t / bucketMs) * bucketMs;
    const row = grid.get(q.operator || '—');
    if (row && row.has(b)) row.set(b, row.get(b) + 1);
  }

  return {
    type: 'bar',
    data: {
      labels: buckets.map(fmt),
      datasets: ops.map((op) => ({
        label: op,
        data: buckets.map((b) => grid.get(op).get(b)),
        backgroundColor: colorFor.get(op),
        borderWidth: 0,
      })),
    },
    options: stackedChartOptions(),
  };
}

// One bar per operator: the running total of `valueFn` (QSO points, or
// multiplier credit) contributed so far, sorted biggest-first. The
// snapshot counterpart of the QSOs by Operator bar.
function buildOperatorContribution(qsos, valueFn, seriesLabel) {
  if (!qsos.length) return null;
  const totals = new Map();
  for (const q of qsos) {
    const op = q.operator || '—';
    totals.set(op, (totals.get(op) || 0) + valueFn(q));
  }
  if (!totals.size) return null;

  const colorFor = operatorColorMap(qsos);
  const ops = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([op]) => op);
  return {
    type: 'bar',
    data: {
      labels: ops,
      datasets: [{
        label: seriesLabel,
        data: ops.map((op) => totals.get(op)),
        backgroundColor: ops.map((op) => colorFor.get(op)),
        borderRadius: 4,
      }],
    },
    options: barChartOptions(),
  };
}

// Chart.js draws onto a <canvas> -- none of it is reachable by dashboard.css's
// var(--x) tokens, so tick/grid/legend colors are picked here instead,
// matching those tokens' light/dark values exactly. Toggling the theme
// reloads the page (see chrome.js), so every chart is always rebuilt fresh
// right after data-theme lands on <html>; this only ever needs to read it
// once per build, never react to a live change.
function themeColors() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light
    ? { muted: '#5b5a52', text: '#1a1a1a', grid: '#c7c2a8' }
    : { muted: '#8b949e', text: '#e6edf3', grid: '#262626' };
}

// A categorical bar per operator, direct-labeled on the x-axis -- color
// distinguishes bars but doesn't carry meaning alone (the axis label
// already does), so no legend, matching the same reasoning as the
// dashboard's continent tiles.
function barChartOptions() {
  const c = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: c.muted },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: { color: c.text, precision: 0 },
        grid: { color: c.grid },
      },
    },
  };
}

function trendChartOptions() {
  const c = themeColors();
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: c.muted, maxTicksLimit: 8, autoSkip: true },
        grid: { color: c.grid },
      },
      y: {
        beginAtZero: true,
        ticks: { color: c.text, precision: 0 },
        grid: { color: c.grid },
      },
    },
  };
}

// A stacked bar/column: same axes as trendChartOptions() but with the
// legend on (each series is a band / continent / run-state that colour
// alone has to carry) and both axes stacked.
function stackedChartOptions() {
  const o = trendChartOptions();
  o.plugins.legend = { display: true, labels: { color: themeColors().text, boxWidth: 12 } };
  o.scales.x.stacked = true;
  o.scales.y.stacked = true;
  return o;
}

function doughnutChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: {
      legend: { display: true, position: 'right', labels: { color: themeColors().text, boxWidth: 12 } },
    },
  };
}

// ===========================================================================
// "More charts" grid -- spec-driven. See the charts() object's extraCharts /
// renderExtra. Each build() takes (qsos, scoreHistory, bucketMinutes) and
// returns a ready Chart.js config, or null when there's nothing to draw.
// Time is keyed off logged_at (via qLoggedTime), same as the rest of this
// page.
// ===========================================================================

const CONTINENT_ORDER = ['NA', 'SA', 'EU', 'AS', 'AF', 'OC', 'AN', '—'];
const MODE_COLORS = {
  CW: CATEGORICAL_COLORS[0], PH: CATEGORICAL_COLORS[1],
  DG: CATEGORICAL_COLORS[2], '—': '#8b949e',
};

function qLoggedTime(q) {
  if (!q.logged_at) return NaN;
  const t = new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? NaN : t;
}

function multCount(q) {
  return (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0);
}

// Same CW / PH / DG buckets as stats.js modeGroup().
function modeGroup(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return '—';
  if (m === 'CW') return 'CW';
  if (['USB', 'LSB', 'SSB', 'AM', 'FM', 'PH', 'PHONE', 'DV', 'FMN'].includes(m)) return 'PH';
  return 'DG';
}

function bandSortKey(band) {
  const n = parseFloat(band);
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

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

function sortedBands(qsos) {
  return [...new Set(qsos.map((q) => q.band).filter(Boolean))]
    .sort((a, b) => bandSortKey(a) - bandSortKey(b));
}

// A band keeps the same colour across every chart on the page: index into
// the fixed palette by the band's position in frequency order.
function bandColorFactory(qsos) {
  const order = sortedBands(qsos);
  return (band) => CATEGORICAL_COLORS[Math.max(0, order.indexOf(band)) % CATEGORICAL_COLORS.length];
}

function continentColor(c) {
  const i = CONTINENT_ORDER.indexOf(c);
  return CATEGORICAL_COLORS[(i < 0 ? 7 : i) % CATEGORICAL_COLORS.length];
}

// Even bucket timeline across the full span of logged QSOs, plus a label
// formatter that adds the date once a contest runs past 24h. Min/max by
// loop, not Math.min(...times), so a big log can't blow the call stack.
function timeAxis(qsos, bucketMin) {
  const bucketMs = Math.max(1, bucketMin) * 60000;
  const times = [];
  for (const q of qsos) {
    const t = qLoggedTime(q);
    if (!Number.isNaN(t)) times.push(t);
  }
  if (!times.length) return { buckets: [], bucketMs, label: () => '' };

  let min = times[0];
  let max = times[0];
  for (const t of times) { if (t < min) min = t; if (t > max) max = t; }

  const start = Math.floor(min / bucketMs) * bucketMs;
  const end = Math.floor(max / bucketMs) * bucketMs;
  const buckets = [];
  for (let b = start; b <= end && buckets.length < 2000; b += bucketMs) buckets.push(b);

  const multiDay = end - start >= 24 * 3600000;
  const pad = (n) => String(n).padStart(2, '0');
  const label = (ms) => {
    const d = new Date(ms);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return multiDay ? `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${hm}` : hm;
  };
  return { buckets, bucketMs, label };
}

function buildCumulative(qsos, bucketMin, valueFn, label, color) {
  if (!qsos.length) return null;
  const { buckets, bucketMs, label: fmt } = timeAxis(qsos, bucketMin);
  if (!buckets.length) return null;

  const perBucket = new Map(buckets.map((b) => [b, 0]));
  for (const q of qsos) {
    const t = qLoggedTime(q);
    if (Number.isNaN(t)) continue;
    const b = Math.floor(t / bucketMs) * bucketMs;
    if (perBucket.has(b)) perBucket.set(b, perBucket.get(b) + valueFn(q));
  }

  let run = 0;
  const data = buckets.map((b) => (run += perBucket.get(b)));
  return {
    type: 'line',
    data: {
      labels: buckets.map(fmt),
      datasets: [{
        label,
        data,
        borderColor: color,
        backgroundColor: hexA(color, 0.15),
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: trendChartOptions(),
  };
}

function buildStackedByKey(qsos, bucketMin, keyFn, orderedKeys, colorFn) {
  if (!qsos.length) return null;
  const { buckets, bucketMs, label: fmt } = timeAxis(qsos, bucketMin);
  if (!buckets.length) return null;

  const keys = orderedKeys.filter((k, i) => orderedKeys.indexOf(k) === i && qsos.some((q) => keyFn(q) === k));
  const grid = new Map(keys.map((k) => [k, new Map(buckets.map((b) => [b, 0]))]));
  for (const q of qsos) {
    const t = qLoggedTime(q);
    if (Number.isNaN(t)) continue;
    const b = Math.floor(t / bucketMs) * bucketMs;
    const row = grid.get(keyFn(q));
    if (row && row.has(b)) row.set(b, row.get(b) + 1);
  }

  return {
    type: 'bar',
    data: {
      labels: buckets.map(fmt),
      datasets: keys.map((k) => ({
        label: k,
        data: buckets.map((b) => grid.get(k).get(b)),
        backgroundColor: colorFn(k),
        borderWidth: 0,
      })),
    },
    options: stackedChartOptions(),
  };
}

function buildTotalsBar(qsos, keyFn, orderedKeys, colorFn) {
  if (!qsos.length) return null;
  const counts = new Map();
  for (const q of qsos) {
    const k = keyFn(q);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (counts.size === 0) return null;

  let keys = orderedKeys
    ? orderedKeys.filter((k) => counts.has(k))
    : [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));

  return {
    type: 'bar',
    data: {
      labels: keys,
      datasets: [{
        label: 'QSOs',
        data: keys.map((k) => counts.get(k) || 0),
        backgroundColor: keys.map(colorFn),
        borderRadius: 4,
      }],
    },
    options: barChartOptions(),
  };
}

function buildDoughnut(qsos, keyFn, orderedKeys, colorFn) {
  if (!qsos.length) return null;
  const counts = new Map();
  for (const q of qsos) {
    const k = keyFn(q);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (counts.size === 0) return null;

  const keys = orderedKeys
    ? orderedKeys.filter((k) => counts.has(k))
    : [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));

  return {
    type: 'doughnut',
    data: {
      labels: keys,
      datasets: [{
        data: keys.map((k) => counts.get(k)),
        backgroundColor: keys.map(colorFn),
        borderColor: '#0a0a0a',
        borderWidth: 2,
      }],
    },
    options: doughnutChartOptions(),
  };
}

function buildHistogram(labels, values, color) {
  if (!labels.length) return null;
  return {
    type: 'bar',
    data: { labels, datasets: [{ label: 'QSOs', data: values, backgroundColor: color, borderRadius: 4 }] },
    options: barChartOptions(),
  };
}

function buildMultsByBand(qsos) {
  if (!qsos.length) return null;
  const bands = sortedBands(qsos);
  if (!bands.length) return null;
  const by = new Map(bands.map((b) => [b, 0]));
  for (const q of qsos) if (by.has(q.band)) by.set(q.band, by.get(q.band) + multCount(q));
  return buildHistogram(
    bands.map(bandLabel),
    bands.map((b) => by.get(b)),
    bands.map((b, i) => CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]),
  );
}

function buildPointsDist(qsos) {
  if (!qsos.length) return null;
  const by = new Map();
  for (const q of qsos) {
    const p = Number(q.points) || 0;
    by.set(p, (by.get(p) || 0) + 1);
  }
  const keys = [...by.keys()].sort((a, b) => a - b);
  return buildHistogram(keys.map(String), keys.map((k) => by.get(k)), CATEGORICAL_COLORS[3]);
}

function buildCallLenDist(qsos) {
  if (!qsos.length) return null;
  const by = new Map();
  for (const q of qsos) {
    const L = (q.call || '').length;
    if (!L) continue;
    const k = L >= 10 ? '10+' : String(L);
    by.set(k, (by.get(k) || 0) + 1);
  }
  const order = ['3', '4', '5', '6', '7', '8', '9', '10+'].filter((k) => by.has(k));
  return buildHistogram(order, order.map((k) => by.get(k)), CATEGORICAL_COLORS[6]);
}

function buildHourOfDay(qsos) {
  if (!qsos.length) return null;
  const by = new Array(24).fill(0);
  let any = false;
  for (const q of qsos) {
    const t = qLoggedTime(q);
    if (Number.isNaN(t)) continue;
    by[new Date(t).getUTCHours()] += 1;
    any = true;
  }
  if (!any) return null;
  return buildHistogram(
    [...Array(24).keys()].map((h) => String(h).padStart(2, '0')),
    by,
    CATEGORICAL_COLORS[0],
  );
}

// Distribution of the per-hour rate seen across fixed 10-minute windows --
// "how much of the contest was spent at what rate". Each window's QSO count
// is extrapolated x6 to a per-hour figure and dropped into a coarse bin.
function buildRateHistogram(qsos) {
  const times = [];
  for (const q of qsos) {
    const t = qLoggedTime(q);
    if (!Number.isNaN(t)) times.push(t);
  }
  if (times.length < 2) return null;

  const bucketMs = 10 * 60000;
  let min = times[0];
  let max = times[0];
  for (const t of times) { if (t < min) min = t; if (t > max) max = t; }
  const start = Math.floor(min / bucketMs) * bucketMs;
  const end = Math.floor(max / bucketMs) * bucketMs;

  const counts = new Map();
  for (let b = start; b <= end; b += bucketMs) counts.set(b, 0);
  for (const t of times) {
    const b = Math.floor(t / bucketMs) * bucketMs;
    counts.set(b, (counts.get(b) || 0) + 1);
  }

  const labels = ['0–24', '25–49', '50–74', '75–99', '100–149', '150+'];
  const bins = [0, 0, 0, 0, 0, 0];
  for (const c of counts.values()) {
    const r = c * 6;
    const idx = r < 25 ? 0 : r < 50 ? 1 : r < 75 ? 2 : r < 100 ? 3 : r < 150 ? 4 : 5;
    bins[idx] += 1;
  }
  return buildHistogram(labels, bins, CATEGORICAL_COLORS[2]);
}

const EXTRA_CHART_SPECS = [
  {
    id: 'cx-cum-qsos', title: 'Cumulative QSOs', wide: true,
    build: (q, sh, bm) => buildCumulative(q, bm, () => 1, 'QSOs', CATEGORICAL_COLORS[0]),
  },
  {
    id: 'cx-cum-points', title: 'Cumulative QSO Points', wide: true, need: 'points',
    build: (q, sh, bm) => buildCumulative(q, bm, (x) => Number(x.points) || 0, 'Points', CATEGORICAL_COLORS[1]),
  },
  {
    id: 'cx-cum-mults', title: 'Cumulative Multipliers', wide: true, need: 'mults',
    build: (q, sh, bm) => buildCumulative(q, bm, multCount, 'Mults', CATEGORICAL_COLORS[2]),
  },
  {
    id: 'cx-band-time', title: 'QSOs by Band Over Time', wide: true,
    build: (q, sh, bm) => buildStackedByKey(q, bm, (x) => x.band || '—', [...sortedBands(q), '—'], bandColorFactory(q)),
  },
  {
    id: 'cx-cont-time', title: 'QSOs by Continent Over Time', wide: true,
    build: (q, sh, bm) => buildStackedByKey(q, bm, (x) => (x.continent || '—').toUpperCase(), CONTINENT_ORDER, continentColor),
  },
  {
    id: 'cx-runsp-time', title: 'Run vs. Search & Pounce Over Time', wide: true, need: 'run_flag',
    build: (q, sh, bm) => buildStackedByKey(
      q, bm, (x) => (x.is_run_qso ? 'Run' : 'S&P'), ['Run', 'S&P'],
      (k) => (k === 'Run' ? CATEGORICAL_COLORS[5] : CATEGORICAL_COLORS[0]),
    ),
  },
  {
    id: 'cx-band-share', title: 'QSOs by Band', wide: false,
    build: (q) => buildTotalsBar(q, (x) => x.band || '—', [...sortedBands(q), '—'], bandColorFactory(q)),
  },
  {
    id: 'cx-mode-share', title: 'QSOs by Mode', wide: false, pie: true,
    build: (q) => buildDoughnut(q, (x) => modeGroup(x.mode), ['CW', 'PH', 'DG', '—'], (k) => MODE_COLORS[k] || '#8b949e'),
  },
  {
    id: 'cx-cont-share', title: 'QSOs by Continent', wide: false,
    build: (q) => buildTotalsBar(q, (x) => (x.continent || '—').toUpperCase(), null, continentColor),
  },
  {
    id: 'cx-mult-band', title: 'Multipliers by Band', wide: false, need: 'mults',
    build: (q) => buildMultsByBand(q),
  },
  {
    id: 'cx-hour-of-day', title: 'QSOs by Hour of Day (UTC)', wide: true,
    build: (q) => buildHourOfDay(q),
  },
  {
    id: 'cx-points-dist', title: 'Points-per-QSO Distribution', wide: false, need: 'points',
    build: (q) => buildPointsDist(q),
  },
  {
    id: 'cx-calllen-dist', title: 'Callsign Length Distribution', wide: false,
    build: (q) => buildCallLenDist(q),
  },
  {
    id: 'cx-rate-hist', title: 'Rate Distribution (10-min windows)', wide: false,
    build: (q) => buildRateHistogram(q),
  },
];
