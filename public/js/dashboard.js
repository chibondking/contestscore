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

    // Tally of qsos by continent (N1MM's own 2-letter codes: NA/SA/EU/AS/
    // AF/OC/AN). Computed client-side from the already-loaded qsos array
    // rather than a new backend endpoint -- the full log is already in
    // memory here.
    continentCounts() {
      const counts = {};
      for (const q of this.qsos) {
        const c = (q.continent || '').trim().toUpperCase();
        if (!c) continue;
        counts[c] = (counts[c] || 0) + 1;
      }
      return counts;
    },

    // Sequential encoding (one hue, magnitude by intensity -- this is a
    // "compare magnitude across a labeled region" job, not an identity one,
    // so per the dataviz skill it's one hue, not a categorical palette).
    // Reuses the dashboard's own existing --accent blue rather than
    // introducing a second hue, scaling alpha instead of stepping through a
    // light->dark ramp: this theme is permanently dark, so "recedes toward
    // the surface" means low alpha, not a lighter tint (a light tint would
    // stand out against the near-black background, the opposite of
    // receding). Text stays --text at every intensity since alpha-over-near-
    // black never gets bright enough to need dark text for contrast.
    continentTileStyle(code) {
      const counts = this.continentCounts();
      const max = Math.max(1, ...Object.values(counts));
      const count = counts[code] || 0;
      if (count === 0) return {};
      const intensity = count / max; // 0..1, empty tiles excluded above
      const alpha = 0.15 + 0.65 * intensity;
      return {
        background: `rgba(88, 166, 255, ${alpha})`,
        borderColor: `rgba(88, 166, 255, ${Math.min(1, alpha + 0.2)})`,
      };
    },

    // Per-operator stats (QSO count, points, peak rate), the same breakdown
    // the original Node-RED dashboard showed for multi-op stations. Computed
    // client-side from the already-loaded qsos array, same approach as
    // continentCounts() -- no new backend endpoint needed. Peak rate keys
    // off a 60-minute bucket (matching N1MM's own "hourly rate" convention
    // and the main Rate card's slowest/steadiest window) rather than a
    // short bucket that a single fast run could spike; peakRate10 is a
    // secondary, noisier column for a short hot streak that a 60-minute
    // window would smooth out.
    operatorStats() {
      const byOp = new Map();
      for (const q of this.qsos) {
        const op = q.operator || '—';
        if (!byOp.has(op)) byOp.set(op, { operator: op, qsos: 0, points: 0, buckets60: new Map(), buckets10: new Map() });
        const entry = byOp.get(op);
        entry.qsos += 1;
        entry.points += Number(q.points) || 0;
        const t = q.logged_at ? new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime() : NaN;
        if (!Number.isNaN(t)) {
          const b60 = Math.floor(t / 3600000) * 3600000;
          entry.buckets60.set(b60, (entry.buckets60.get(b60) || 0) + 1);
          const b10 = Math.floor(t / 600000) * 600000;
          entry.buckets10.set(b10, (entry.buckets10.get(b10) || 0) + 1);
        }
      }
      return [...byOp.values()]
        .map((entry) => ({
          operator: entry.operator,
          qsos: entry.qsos,
          points: entry.points,
          // A 60-minute bucket's own count already is the rate/hr -- no
          // extrapolation needed, unlike the 10-minute column.
          peakRate60: Math.max(0, ...entry.buckets60.values()),
          peakRate10: Math.round(Math.max(0, ...entry.buckets10.values()) * 6),
        }))
        .sort((a, b) => b.qsos - a.qsos);
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
