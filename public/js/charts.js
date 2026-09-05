// Not type="module" -- same reason as dashboard.js/admin.js: Alpine's
// x-data="charts()" is evaluated in global scope, and a module's top-level
// declarations don't land there.
function charts() {
  return {
    qsos: [],
    scoreHistory: [],
    rateChart: null,
    scoreChart: null,

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

      if (this.rateChart) {
        this.rateChart.data.labels = labels;
        this.rateChart.data.datasets[0].data = values;
        this.rateChart.update();
        return;
      }

      this.rateChart = new Chart(canvas, {
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

    renderScoreChart() {
      const canvas = document.getElementById('scoreChart');
      if (!canvas || typeof Chart === 'undefined') return;

      const labels = this.scoreHistory.map((s) => new Date(s.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      const values = this.scoreHistory.map((s) => s.points);

      if (this.scoreChart) {
        this.scoreChart.data.labels = labels;
        this.scoreChart.data.datasets[0].data = values;
        this.scoreChart.update();
        return;
      }

      this.scoreChart = new Chart(canvas, {
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
