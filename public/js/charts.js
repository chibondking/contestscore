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

    async init() {
      await this.fetchData();
      // A historical trends view, not a live ticker -- a periodic refetch
      // is enough here; contact:new/score:update don't need a socket wire-up
      // for this page the way the main dashboard needs them.
      setInterval(() => this.fetchData(), 30000);
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
    rateOverTime(bucketMinutes = 15) {
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
    operatorTimeSeries(bucketMinutes = 15) {
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

    renderOperatorQsoChart() {
      operatorQsoChart = renderMultiSeriesChart(
        operatorQsoChart, 'operatorQsoChart', this.operatorTimeSeries(), 'qsosOverTime',
      );
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
