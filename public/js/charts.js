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

  return {
    qsos: [],
    scoreHistory: [],
    // "At a glance" is the default for a 48-hour contest -- the full
    // per-operator time-series breakdown is real detail a viewer can opt
    // into, not something to show by default on every load. Per-viewer
    // convenience, so localStorage (not a server-side setting) is the right
    // place for it.
    detailed: false,

    async init() {
      try {
        this.detailed = localStorage.getItem('contestpulse_charts_detailed') === '1';
      } catch {
        // private browsing / storage disabled -- just default to simple
      }
      await this.fetchData();
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

    // Per-operator breakdown, same bucketing idea as rateOverTime() but
    // split by q.operator instead of pooled -- the original Node-RED
    // dashboard's per-op stats, as a time series instead of a single
    // snapshot table. All operators share the same bucket timeline (the
    // union of every bucket any operator has a QSO in) so their lines land
    // on a common x-axis. QSOs and points are cumulative (running total,
    // the natural way to show "contribution" building up); rate and
    // multiplier count are per-bucket, matching the overall rate chart.
    // Multiplier credit is is_mult1/2/3 (N1MM per-QSO multiplier flags,
    // stored on the qso row) rather than score_snapshots' mults column --
    // that column is a per-broadcast contest total, not attributable to one
    // operator.
    operatorTimeSeries(bucketMinutes = this.autoBucketMinutes()) {
      const bucketMs = bucketMinutes * 60000;
      const perHour = 60 / bucketMinutes;
      const operators = [...new Set(this.qsos.map((q) => q.operator || '—'))];
      const perOp = new Map(operators.map((op) => [op, new Map()]));
      const allBuckets = new Set();

      for (const q of this.qsos) {
        if (!q.logged_at) continue;
        const t = new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime();
        if (Number.isNaN(t)) continue;
        const bucket = Math.floor(t / bucketMs) * bucketMs;
        allBuckets.add(bucket);
        const op = q.operator || '—';
        const bucketMap = perOp.get(op);
        const entry = bucketMap.get(bucket) || { qsos: 0, points: 0, mults: 0 };
        entry.qsos += 1;
        entry.points += Number(q.points) || 0;
        entry.mults += (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0);
        bucketMap.set(bucket, entry);
      }

      const buckets = [...allBuckets].sort((a, b) => a - b);
      const labels = buckets.map((b) => new Date(b).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

      const series = operators.map((op, i) => {
        let cumQsos = 0;
        let cumPoints = 0;
        const qsosOverTime = [];
        const rateOverTime = [];
        const scoreOverTime = [];
        const multsOverTime = [];
        for (const bucket of buckets) {
          const entry = perOp.get(op).get(bucket) || { qsos: 0, points: 0, mults: 0 };
          cumQsos += entry.qsos;
          cumPoints += entry.points;
          qsosOverTime.push(cumQsos);
          rateOverTime.push(Math.round(entry.qsos * perHour));
          scoreOverTime.push(cumPoints);
          multsOverTime.push(entry.mults);
        }
        return {
          operator: op,
          color: CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length],
          qsosOverTime, rateOverTime, scoreOverTime, multsOverTime,
        };
      });

      return { labels, series };
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
      // Same fixed categorical order as the detailed per-operator line
      // charts -- an operator's color stays consistent whether Detailed
      // view is on or off.
      const colors = totals.map((_, i) => CATEGORICAL_COLORS[i % CATEGORICAL_COLORS.length]);

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

    renderOperatorRateChart() {
      operatorRateChart = renderMultiSeriesChart(
        operatorRateChart, 'operatorRateChart', this.operatorTimeSeries(), 'rateOverTime',
      );
    },

    renderOperatorScoreChart() {
      operatorScoreChart = renderMultiSeriesChart(
        operatorScoreChart, 'operatorScoreChart', this.operatorTimeSeries(), 'scoreOverTime',
      );
    },

    renderOperatorMultChart() {
      operatorMultChart = renderMultiSeriesChart(
        operatorMultChart, 'operatorMultChart', this.operatorTimeSeries(), 'multsOverTime',
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

// Shared renderer for the four per-operator charts (QSOs/rate/score/mults
// over time) -- same series set, same x-axis, only the y-values (picked out
// by `key`) differ. `existingChart` is the caller's own closure variable
// (see charts()'s Alpine-reactivity note above); this returns the chart
// instance to store back into it, whether reused or freshly created.
function renderMultiSeriesChart(existingChart, canvasId, { labels, series }, key) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return existingChart;

  // These three charts live inside charts.html's `x-if="detailed"` block,
  // which destroys and recreates their <canvas> elements every time the
  // toggle flips -- a stale chart instance bound to the now-removed canvas
  // needs to be torn down rather than reused, or .update() would silently
  // target a detached canvas while the freshly-mounted one stays blank.
  if (existingChart && existingChart.canvas !== canvas) {
    existingChart.destroy();
    existingChart = null;
  }

  const datasets = series.map((s) => ({
    label: s.operator,
    data: s[key],
    borderColor: s.color,
    backgroundColor: s.color,
    fill: false,
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
  }));

  if (existingChart) {
    existingChart.data.labels = labels;
    existingChart.data.datasets = datasets;
    existingChart.update();
    return existingChart;
  }

  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: multiSeriesChartOptions(),
  });
}

// Per-operator charts always have >=1 series and typically several, so
// (per the dataviz skill) the legend stays on -- unlike the single-series
// overall rate/score charts above, where the card title already names the
// one series and a legend box would be redundant.
function multiSeriesChartOptions() {
  const opts = trendChartOptions();
  opts.plugins.legend = { display: true, labels: { color: '#e6edf3' } };
  return opts;
}

// A categorical bar per operator, direct-labeled on the x-axis -- color
// distinguishes bars but doesn't carry meaning alone (the axis label
// already does), so no legend, matching the same reasoning as the
// dashboard's continent tiles.
function barChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: '#8b949e' },
        grid: { display: false },
      },
      y: {
        beginAtZero: true,
        ticks: { color: '#e6edf3', precision: 0 },
        grid: { color: '#262626' },
      },
    },
  };
}

function trendChartOptions() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 200 },
    plugins: { legend: { display: false } },
    scales: {
      x: {
        ticks: { color: '#8b949e', maxTicksLimit: 8, autoSkip: true },
        grid: { color: '#262626' },
      },
      y: {
        beginAtZero: true,
        ticks: { color: '#e6edf3', precision: 0 },
        grid: { color: '#262626' },
      },
    },
  };
}
