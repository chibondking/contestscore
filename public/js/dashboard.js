function dashboard() {
  return {
    connected: false,
    score: {},
    radios: [],
    qsos: [],
    // Per-station ContestPulse (or other bridge) liveness, keyed by
    // station_id. Not contest data -- db:cleared deliberately leaves this
    // alone, since it reflects the bridge process, not the QSO log.
    bridges: [],
    // N1MM-style rate meter: [{ minutes, qsos, rate_per_hour }, ...]. Pure
    // function of wall-clock time (a lull should visibly decay the rate
    // even with no new QSOs), so this is polled on a timer, not just
    // refreshed on contact:new.
    rate: [],
    // { commit, deployedAt } from GET /api/version, shown in the footer.
    // Only changes on a real deploy -- a stale/cached page would show an
    // old timestamp here even though nothing else looks obviously wrong.
    version: {},
    // "Last updated" ticker: lastUpdateAt bumps on every socket event or
    // successful poll; now ticks every second so secondsSinceUpdate()
    // counts up live in the header even between events, proving the page
    // itself is still alive and not just frozen mid-render.
    lastUpdateAt: Date.now(),
    now: Date.now(),
    // Chart.js instance for the continent breakdown -- created once, then
    // updated in place (see renderContinentChart) rather than recreated on
    // every qsos change.
    continentChart: null,

    init() {
      const socket = io();

      socket.on('connect',    () => { this.connected = true; this.touch(); });
      socket.on('disconnect', () => { this.connected = false; });

      socket.on('radio:update', (data) => {
        // Matches the backend's identity key (station_name, radio_nr), not
        // radio_nr alone -- see CLAUDE.md: two different multi-op stations
        // can both report radio_nr=1.
        const idx = this.radios.findIndex((r) => (
          (r.station_name || '') === (data.station_name || '') && r.radio_nr === data.radio_nr
        ));
        if (idx >= 0) this.radios[idx] = data;
        else this.radios.push(data);
        this.radios = [...this.radios];
        this.touch();
      });

      socket.on('contact:new', (data) => {
        // A contactreplace edit re-emits contact:new with the same ext_id --
        // update that row in place instead of prepending a duplicate (which
        // would leave two rows sharing the same x-for :key, exactly the
        // kind of thing that breaks Alpine's DOM reconciliation).
        const idx = data.ext_id ? this.qsos.findIndex((q) => q.ext_id === data.ext_id) : -1;
        if (idx >= 0) {
          this.qsos[idx] = data;
          this.qsos = [...this.qsos];
        } else {
          this.qsos = [data, ...this.qsos];
        }
        this.fetchRate();
        this.touch();
      });

      socket.on('contact:delete', (data) => {
        this.qsos = this.qsos.filter((q) => (
          data.ext_id ? q.ext_id !== data.ext_id : !(q.call === data.call && q.band === data.band)
        ));
        this.fetchRate();
        this.touch();
      });

      socket.on('score:update', (data) => {
        this.score = data;
        this.touch();
      });

      socket.on('bridge:status', (data) => {
        const idx = this.bridges.findIndex((b) => b.station_id === data.station_id);
        if (idx >= 0) this.bridges[idx] = data;
        else this.bridges.push(data);
        this.bridges = [...this.bridges];
        this.touch();
      });

      socket.on('db:cleared', () => {
        this.qsos = [];
        this.score = {};
        this.radios = [];
        this.fetchRate(); // trailing windows should drop to zero, not linger
        this.touch();
      });

      this.fetchInitialState();
      this.fetchVersion();
      // The rate windows decay purely with elapsed time, so they need to be
      // re-fetched on a timer even when nothing else is happening.
      setInterval(() => this.fetchRate(), 30000);
      // Drives the header's live "updated Xs ago" ticker.
      setInterval(() => { this.now = Date.now(); }, 1000);
    },

    touch() {
      this.lastUpdateAt = Date.now();
    },

    secondsSinceUpdate() {
      return Math.max(0, Math.round((this.now - this.lastUpdateAt) / 1000));
    },

    formatDeployTime(iso) {
      return iso ? new Date(iso).toLocaleString() : '';
    },

    // Tally of qsos by continent, sorted most-worked first. Computed
    // client-side from the already-loaded qsos array rather than a new
    // backend endpoint -- the full log is already in memory here.
    continentBreakdown() {
      const counts = {};
      for (const q of this.qsos) {
        const c = (q.continent || '').trim() || 'Unknown';
        counts[c] = (counts[c] || 0) + 1;
      }
      return Object.entries(counts)
        .map(([continent, count]) => ({ continent, count }))
        .sort((a, b) => b.count - a.count);
    },

    // Bound via x-effect="renderContinentChart()" on the canvas, so it
    // re-runs whenever this.qsos changes (Alpine tracks the access inside
    // continentBreakdown() as a dependency). Updates the existing chart
    // in place rather than recreating it, so it doesn't flicker/reset zoom
    // state on every new QSO.
    renderContinentChart() {
      const data = this.continentBreakdown();
      const canvas = document.getElementById('continentChart');
      if (!canvas || typeof Chart === 'undefined') return;

      const labels = data.map((d) => d.continent);
      const values = data.map((d) => d.count);

      if (this.continentChart) {
        this.continentChart.data.labels = labels;
        this.continentChart.data.datasets[0].data = values;
        this.continentChart.update();
        return;
      }

      this.continentChart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            data: values,
            // Comparing magnitude across a labeled category, not carrying
            // identity in the color itself -- one sequential hue is the
            // right call here (dataviz skill, "choosing a form"), not a
            // multi-hue categorical palette. Blue slot from the skill's
            // validated reference palette, dark-mode step.
            backgroundColor: '#2a78d6',
            borderRadius: 4,
            barThickness: 14,
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 200 },
          plugins: { legend: { display: false } },
          scales: {
            x: {
              beginAtZero: true,
              ticks: { color: '#8b949e', precision: 0 },
              grid: { color: '#262626' },
            },
            y: {
              ticks: { color: '#e6edf3' },
              grid: { display: false },
            },
          },
        },
      });
    },

    // "R1" for the common single-station case (SO1R/SO2R); once more than
    // one distinct station is reporting (multi-op, separate physical
    // stations), prefix with the station name too, since radio_nr alone no
    // longer identifies which physical radio it is.
    radioLabel(r) {
      if (r.radio_nr == null) return '—';
      const stations = new Set(this.radios.map((x) => x.station_name || ''));
      if (stations.size > 1 && r.station_name) {
        return r.station_name + ' R' + r.radio_nr;
      }
      return 'R' + r.radio_nr;
    },

    async fetchInitialState() {
      try {
        const [qsos, score, radios, bridges, rate] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score').then((r) => r.json()),
          fetch('/api/radios').then((r) => r.json()),
          fetch('/api/bridges').then((r) => r.json()),
          fetch('/api/rate').then((r) => r.json()),
        ]);
        this.qsos    = qsos;
        this.score   = score;
        this.radios  = radios;
        this.bridges = bridges;
        this.rate    = rate;
        this.touch();
      } catch (err) {
        console.error('Failed to load initial state:', err);
      }
    },

    async fetchRate() {
      try {
        this.rate = await fetch('/api/rate').then((r) => r.json());
        this.touch();
      } catch (err) {
        console.error('Failed to refresh rate:', err);
      }
    },

    async fetchVersion() {
      try {
        this.version = await fetch('/api/version').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load version info:', err);
      }
    },
  };
}
