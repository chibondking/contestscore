
const DXLOG_MIN_GAP_MS = 90 * 1000;
const DXLOG_MAX_GAP_MS = 45 * 60 * 1000;

function isDelayedScoreSource(soft) {
  return /^dxlog/i.test(String(soft || ''));
}

// The Operators table's rules, copied from stats.js (dedupeForScoring,
// modeGroup, bestWindow) so its numbers match the Stats page: a dupe (same
// call, band and mode group; the earliest one counts) is dropped, and peak
// rate is the best *sliding* window, not a fixed clock block. Change one,
// change the other -- tui/index.js has a third copy.
function rateModeGroup(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return '—';
  if (m === 'CW') return 'CW';
  if (['USB', 'LSB', 'SSB', 'AM', 'FM', 'PH', 'PHONE', 'DV', 'FMN'].includes(m)) return 'PH';
  return 'DG';
}

function dedupeForRate(qs, timeOf) {
  const best = new Map();
  const passthrough = [];
  for (const q of qs) {
    const t = timeOf(q);
    if (/QTC/i.test(q.exchange1 || '') || t == null || Number.isNaN(t)) { passthrough.push(q); continue; }
    const k = `${(q.call || '').toUpperCase()}|${q.band || ''}|${rateModeGroup(q.mode)}`;
    const e = best.get(k);
    if (!e || t < e.t) best.set(k, { q, t });
  }
  return [...passthrough, ...[...best.values()].map((e) => e.q)];
}

// Most entries of `times` (sorted ascending, ms) inside any window of windowMs.
function bestWindowCount(times, windowMs) {
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    if (j < i) j = i;
    while (j + 1 < times.length && times[j + 1] - times[i] < windowMs) j += 1;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

// The dashboard page (/): the live feed, the map card and the mult bell
// (component.js) plus everything only the dashboard shows -- radios,
// sparklines, busts, solar, COSB cards, the operator table.
function dashboard() {
  // Chart.js instances live here, in a plain closure variable -- NOT as
  // Alpine data properties. Same reactivity trap as charts.js: Alpine
  // deep-wraps returned x-data objects in a Proxy, which breaks Chart.js's
  // internal state on a later .update() call. See charts.js's own comment
  // for the full explanation.
  let scoreSparkline = null;
  let rateSparkline = null;

  return compose(liveFeed(), mapPanel(), multBellPanel(), {
    // Full-contest score time series, just for the Score card's sparkline --
    // fetched once and refreshed on score:update, same idea as charts.html's
    // trend charts but shrunk down to fit the space Feed Status left behind
    // when it moved into the header.
    scoreHistory: [],

    radios: [],

    // Per-station ContestPulse (or other bridge) liveness, keyed by
    // station_id. Not contest data -- db:cleared deliberately leaves this
    // alone, since it reflects the bridge process, not the QSO log.
    bridges: [],

    // { commit, deployedAt } from GET /api/version, shown in the footer.
    // Only changes on a real deploy -- a stale/cached page would show an
    // old timestamp here even though nothing else looks obviously wrong.
    version: {},

    // Optional-feature switches from GET /api/features. `lookup.enabled`
    // gates the Possible Busts card entirely -- no lookup provider, no card.
    features: {},

    // QSOs whose callsign HamQTH doesn't recognise (from GET /api/busts).
    // Server-derived from the live log + cache, so a call fixed in the
    // logger drops off on the next fetch (the 60s poll or a lookup:result).
    busts: [],

    // Latest space-weather reading from GET /api/solar / solar:update.
    // { updated: null } until the first server-side fetch lands.
    solar: { updated: null },

    init() {
      // What the dashboard does on top of the shared feed and map (see
      // live-feed.js for the events).
      this.onLive('delete', () => this.fetchBusts()); // it may have been a flagged bust
      // A not-found lookup is a new possible bust -- pull the derived list
      // rather than rebuild the row from a payload that doesn't carry it.
      this.onLive('lookup', (data) => { if (data && data.found === false) this.fetchBusts(); });
      this.onLive('score', () => this.fetchScoreHistory());
      this.onLive('cleared', () => {
        this.scoreHistory = [];
        this.radios = [];
        this.busts = [];
      });
      this.onLive('reconnect', () => {
        this.fetchDashboardState();
        this.fetchBusts();
      });

      const socket = this.initLiveFeed();
      this.initMapPanel();
      this.initMultBell();

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

      socket.on('solar:update', (data) => {
        if (data) this.solar = data;
        this.touch();
      });

      socket.on('bridge:status', (data) => {
        const idx = this.bridges.findIndex((b) => b.station_id === data.station_id);
        if (idx >= 0) this.bridges[idx] = data;
        else this.bridges.push(data);
        this.bridges = [...this.bridges];
        this.touch();
      });

      this.fetchDashboardState();
      this.fetchVersion();
      this.fetchFeatures();
      this.fetchBusts();
      this.fetchSolar();
      // Slow safety-net poll so a bust that was corrected in the logger
      // clears even if the lookup:result / contact events were missed.
      setInterval(() => this.fetchBusts(), 60000);
      this.watchTopRow();
    },

    // The dashboard-only state (the feed loads QSOs, score and rate).
    async fetchDashboardState() {
      try {
        const [scoreHistory, radios, bridges] = await Promise.all([
          fetch('/api/score/history').then((r) => r.json()),
          fetch('/api/radios').then((r) => r.json()),
          fetch('/api/bridges').then((r) => r.json()),
        ]);
        this.scoreHistory = scoreHistory;
        this.radios       = radios;
        this.bridges      = bridges;
        this.touch();
      } catch (err) {
        console.error('Failed to load initial state:', err);
      }
    },

    // Is any of .top-row still visible below the sticky header? The header
    // wraps to more lines on a narrow window, so its height is measured
    // again on resize. No IntersectionObserver (old browser): the HUD just
    // never shows, the page is as it was.
    watchTopRow() {
      if (typeof IntersectionObserver === 'undefined') return;
      const row = document.querySelector('.top-row');
      if (!row) return;
      let obs = null;
      const observe = () => {
        if (obs) obs.disconnect();
        const header = document.querySelector('.header');
        const top = header ? header.offsetHeight : 0;
        obs = new IntersectionObserver(([e]) => { this.topRowVisible = e.isIntersecting; },
          { rootMargin: `-${top}px 0px 0px 0px` });
        obs.observe(row);
      };
      observe();
      let t = null;
      window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(observe, 200); });
    },

    // score.qsos comes from N1MM's own periodic dynamicresults broadcast --
    // a snapshot, not an event fired per QSO -- while this.qsos already
    // grows in real time off contact:new. NOT a raw count comparison
    // (qsos.length > score.qsos): a genuine dupe -- the same station worked
    // twice, its own real contactinfo packet each time, own ext_id each
    // time -- legitimately lands two rows in the live log while N1MM's own
    // running qso tally in dynamicresults excludes dupes from the count, so
    // a count-based check would flag "stale" forever the moment any dupe is
    // logged even once caught up (confirmed live on scoreboard.wt2p.us,
    // CW-OPS 2026-09-16: 2 genuine dupes pinned qsos.length 2 over
    // score.qsos permanently). Compare timestamps instead: a QSO landed
    // after the score's own captured_at, and enough time has passed since
    // then (comfortably past the observed ~10s broadcast cadence) that a
    // fresh snapshot should have caught up by now.
    //
    // Not for a delayed score source (DXLog -- see scoreIsDelayed()): there
    // the lag is DXLog's reporting interval, expected and always present,
    // and the score-source chip already says so. "Catching up" would sit
    // on the card almost permanently.
    scoreStale() {
      if (this.scoreIsDelayed()) return false;
      if (!this.score.captured_at || this.qsos.length === 0) return false;
      const capturedAt = new Date(this.score.captured_at).getTime();
      // qsos[0] is the most recent QSO -- getQsos() orders DESC and
      // contact:new prepends (see socket.on('contact:new') above).
      const lastQsoAt = new Date(this.qsos[0].logged_at.replace(' ', 'T') + 'Z').getTime();
      const STALE_GRACE_MS = 30000;
      return lastQsoAt > capturedAt && (this.now - capturedAt) > STALE_GRACE_MS;
    },

    // DXLog.net sends its Score broadcast on the same timer as its online-
    // scoreboard posts -- minutes apart, not after every QSO like N1MM -- so
    // the Score card is behind the live QSO log by design. Detected from
    // the broadcast's own <soft> (see parsers/score.js).
    scoreIsDelayed() {
      return isDelayedScoreSource(this.score.soft);
    },

    // The measured gap between DXLog's recent Score posts, in whole minutes
    // -- the median of the last few. DXLog's timer is 2-30 min, so a gap
    // under 90s is a manual score push (not the timer) and one over 45 min
    // is a pause or a restart; both are ignored. null until there are at
    // least two timer gaps to go on.
    scoreIntervalMinutes() {
      const times = this.scoreHistory
        .filter((r) => isDelayedScoreSource(r.soft))
        .map((r) => new Date(r.captured_at).getTime())
        .filter((t) => !Number.isNaN(t));
      const gaps = times.slice(1).map((t, i) => t - times[i])
        .filter((g) => g >= DXLOG_MIN_GAP_MS && g <= DXLOG_MAX_GAP_MS)
        .slice(-6)
        .sort((a, b) => a - b);
      if (gaps.length < 2) return null;
      return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / 60000));
    },

    scoreSourceChip() {
      if (!this.scoreIsDelayed()) return '';
      const m = this.scoreIntervalMinutes();
      return m ? `DXLog · every ~${m} min` : 'DXLog · delayed';
    },

    formatDeployTime(iso) {
      return iso ? new Date(iso).toLocaleString() : '';
    },

    // Footer label for a hosted (tenant) scoreboard, next to the deploy
    // info -- '' on a standalone install, so nothing shows there. On the
    // club's own hostname it's that hostname's first label ("k9ct-score");
    // on an alias like scoreboard.wt2p.us it's "tenant wt2p". The app
    // doesn't know the hostname suffix (routing config), so it reads the
    // label rather than building one.
    tenantLabel(hostname = (typeof location !== 'undefined' ? location.hostname : '')) {
      const t = this.features && this.features.tenant;
      if (!t || !t.call) return '';
      const id = String(t.call).toLowerCase();
      const label = String(hostname || '').toLowerCase().split('.')[0];
      return label.startsWith(id) ? label : `tenant ${id}`;
    },

    // Tally of qsos by continent (N1MM's own 2-letter codes: NA/SA/EU/AS/
    // AF/OC/AN). Computed client-side from the already-loaded qsos array
    // rather than a new backend endpoint -- the full log is already in
    // memory here.
    continentCounts() {
      const counts = {};
      for (const q of this.countedQsos()) {
        const c = (q.continent || '').trim().toUpperCase();
        if (!c) continue;
        counts[c] = (counts[c] || 0) + 1;
      }
      return counts;
    },

    // Sequential encoding (one hue, magnitude by intensity -- this is a
    // "compare magnitude across a labeled region" job, not an identity one,
    // so per the dataviz skill it's one hue, not a categorical palette).
    // A darker navy, not --accent itself: --accent (rgb(88,166,255), a
    // light sky blue) is tuned to pop as a small link/highlight, but filled
    // in behind a whole row at high alpha it got bright enough to wash out
    // the label text sitting on top of it (reported live against a real
    // EU=23 row). Scaling alpha instead of stepping through a light->dark
    // ramp: this theme is permanently dark, so "recedes toward the surface"
    // means low alpha, not a lighter tint (a light tint would stand out
    // against the near-black background, the opposite of receding). Capped
    // below full opacity so even the top of the ramp stays dark enough for
    // --text on top to read clearly.
    continentTileStyle(code) {
      const counts = this.continentCounts();
      const max = Math.max(1, ...Object.values(counts));
      const count = counts[code] || 0;
      if (count === 0) return {};
      const intensity = count / max; // 0..1, empty tiles excluded above
      const alpha = 0.2 + 0.5 * intensity;
      return {
        background: `rgba(24, 68, 130, ${alpha})`,
        borderColor: `rgba(24, 68, 130, ${Math.min(1, alpha + 0.2)})`,
      };
    },

    // Per-operator stats (QSO count, points, peak rate), the same breakdown
    // the original Node-RED dashboard showed for multi-op stations. Computed
    // client-side from the already-loaded qsos array, same approach as
    // continentCounts() -- no new backend endpoint needed. Dupes are dropped
    // and peak rate is the best sliding 60/10 minutes, the same rules as the
    // Stats page (see dedupeForRate above), so the two pages agree. The 60m
    // count already is the rate/hr; the 10m column is extrapolated (x6) and
    // noisier on purpose -- a short hot streak a 60m window smooths out.
    operatorStats() {
      const timeOf = (q) => (q.logged_at ? new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime() : NaN);
      const byOp = new Map();
      for (const q of dedupeForRate(this.countedQsos(), timeOf)) {
        const op = q.operator || '—';
        if (!byOp.has(op)) byOp.set(op, { operator: op, qsos: 0, points: 0, times: [] });
        const entry = byOp.get(op);
        entry.qsos += 1;
        entry.points += Number(q.points) || 0;
        const t = timeOf(q);
        if (!Number.isNaN(t)) entry.times.push(t);
      }
      return [...byOp.values()]
        .map((entry) => {
          const times = entry.times.sort((a, b) => a - b);
          return {
            operator: entry.operator,
            qsos: entry.qsos,
            points: entry.points,
            peakRate60: bestWindowCount(times, 3600000),
            peakRate10: bestWindowCount(times, 600000) * 6,
          };
        })
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

    // The full history on purpose, not ?changes=1 (which Charts uses):
    // scoreIntervalMinutes() measures DXLog's posting interval from the gaps
    // between consecutive broadcasts, and DXLog posts on a timer whether or
    // not the score moved -- dropping the unchanged ones would stretch the
    // measured interval and skew the "score is delayed" note.
    async fetchScoreHistory() {
      try {
        this.scoreHistory = await fetch('/api/score/history').then((r) => r.json());
      } catch (err) {
        console.error('Failed to refresh score history:', err);
      }
    },

    // Same bucketing approach as charts.js's rateOverTime()/
    // autoBucketMinutes(), shrunk down for a small in-card sparkline rather
    // than a full trend chart -- still spans a 48-hour contest without
    // rendering hundreds of cramped points.
    autoBucketMinutes() {
      const times = this.countedQsos()
        .map((q) => q.logged_at && new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime())
        .filter((t) => t && !Number.isNaN(t));
      if (times.length < 2) return 15;
      const spanMinutes = (Math.max(...times) - Math.min(...times)) / 60000;
      const sizes = [5, 10, 15, 30, 60, 120];
      return sizes.find((m) => spanMinutes / m <= 30) || sizes[sizes.length - 1];
    },

    rateOverTime() {
      const bucketMinutes = this.autoBucketMinutes();
      const bucketMs = bucketMinutes * 60000;
      const counts = new Map();
      for (const q of this.countedQsos()) {
        const t = q.logged_at ? new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime() : NaN;
        if (Number.isNaN(t)) continue;
        const bucket = Math.floor(t / bucketMs) * bucketMs;
        counts.set(bucket, (counts.get(bucket) || 0) + 1);
      }
      const perHour = 60 / bucketMinutes;
      return [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, count]) => Math.round(count * perHour));
    },

    // Sparklines: no axes, no legend, no gridlines -- just the shape of the
    // trend, filling the space Feed Status left behind when it moved into
    // the header. Chart.js instances are kept in the closure variables
    // above dashboard()'s return, not on `this` -- see the top-of-file
    // comment for why.
    // The Score card's trend line: the contest score at each broadcast.
    // score_total is the score (points x mults); `points` on the same row is
    // QSO points alone, which this used to plot -- a different shape, and
    // flat whenever a new multiplier was what moved the score.
    // A logger whose Score broadcast carries no <score> at all leaves
    // score_total at 0 on every row; for that one the points line is still
    // the best trend there is, so fall back to it rather than draw a flat
    // zero. (N1MM and DXLog both send <score>.)
    scoreSparklineValues() {
      const hasScore = this.scoreHistory.some((s) => Number(s.score_total) > 0);
      return this.scoreHistory.map((s) => (hasScore ? Number(s.score_total) || 0 : s.points));
    },

    renderScoreSparkline() {
      const canvas = document.getElementById('scoreSparkline');
      if (!canvas || typeof Chart === 'undefined') return;
      const values = this.scoreSparklineValues();

      if (scoreSparkline) {
        scoreSparkline.data.labels = values.map((_, i) => i);
        scoreSparkline.data.datasets[0].data = values;
        scoreSparkline.update();
        return;
      }
      scoreSparkline = new Chart(canvas, sparklineConfig(values, '#eb6834', 'rgba(235, 104, 52, 0.15)'));
    },

    renderRateSparkline() {
      const canvas = document.getElementById('rateSparkline');
      if (!canvas || typeof Chart === 'undefined') return;
      const values = this.rateOverTime();

      if (rateSparkline) {
        rateSparkline.data.labels = values.map((_, i) => i);
        rateSparkline.data.datasets[0].data = values;
        rateSparkline.update();
        return;
      }
      // Palette slot-1 blue; wt2p.us amber in the wt2p theme (charts.js primarySeries()).
      const wt2p = document.documentElement.getAttribute('data-theme') === 'wt2p';
      rateSparkline = new Chart(canvas, sparklineConfig(values, wt2p ? '#ff9400' : '#2a78d6', wt2p ? 'rgba(255, 148, 0, 0.15)' : 'rgba(42, 120, 214, 0.15)'));
    },

    async fetchVersion() {
      try {
        this.version = await fetch('/api/version').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load version info:', err);
      }
    },

    async fetchFeatures() {
      try {
        this.features = await fetch('/api/features').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load features:', err);
      }
    },

    async fetchBusts() {
      try {
        const res = await fetch('/api/busts').then((r) => r.json());
        this.busts = res.busts || [];
      } catch (err) {
        console.error('Failed to refresh busts:', err);
      }
    },

    // DB logged_at is UTC "YYYY-MM-DD HH:MM:SS"; show just HH:MMz.
    bustTime(loggedAt) {
      if (!loggedAt) return '—';
      const d = new Date(loggedAt.replace(' ', 'T') + 'Z');
      return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(11, 16)}z`;
    },

    // "+12,345" / "-830" / "—": a row's points ahead of (+) or behind (-) us.
    cosbGap(r) {
      if (!r || r.me) return '';
      if (r.gap == null) return '—';
      const s = Math.abs(r.gap).toLocaleString('en-US');
      return r.gap > 0 ? `+${s}` : r.gap < 0 ? `-${s}` : '0';
    },

    cosbNum(v) { return v == null ? '—' : Number(v).toLocaleString('en-US'); },

    // The Following card's rows: the followed stations COSB lists, plus us
    // when we're on the board, highest score first. `gap` is to us (+ =
    // ahead of us); `up` is to the row above (- = behind it).
    followTable() {
      const c = this.cosb || {};
      const rows = (c.follow || []).filter((f) => f.found).map((f) => ({ ...f, me: false }));
      const me = c.status === 'ok' ? (c.rows || []).find((r) => r.me) : null;
      if (me && !rows.some((r) => r.call === me.call)) {
        rows.push({
          call: me.call, op: me.op, section: c.section, rank: me.rank, count: c.count,
          score: me.score, qsos: me.qsos, mult: me.mult, gap: 0, me: true,
        });
      }
      rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      return rows.map((r, i) => {
        const above = rows[i - 1];
        return { ...r, up: above && above.score != null && r.score != null ? r.score - above.score : null };
      });
    },

    // Followed calls COSB doesn't list (yet).
    followMissing() {
      return ((this.cosb && this.cosb.follow) || []).filter((f) => !f.found).map((f) => f.call);
    },

    // Header line: "#11 of 37 · M/2 HP · 52,000 behind the leader".
    cosbSummary() {
      const c = this.cosb;
      if (!c || c.status !== 'ok') return '';
      const scope = this.cosbScopeLabel();
      if (c.outside) return [`${c.count} in ${scope}`, c.section, 'you are outside this scope'].join(' · ');
      const lead = c.rank === 1 ? 'leading'
        : c.leader_gap != null ? `${Number(c.leader_gap).toLocaleString('en-US')} behind the leader` : '';
      return [`#${c.rank} of ${c.count}${scope ? ` in ${scope}` : ''}`, c.section, lead].filter(Boolean).join(' · ');
    },

    async fetchSolar() {
      try {
        this.solar = await fetch('/api/solar').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load solar data:', err);
      }
    },

    // Hover text for the header chip -- the fuller picture the three
    // headline numbers leave out.
    solarTooltip() {
      const s = this.solar;
      const parts = [];
      if (s.sfi != null) parts.push(`SFI ${s.sfi}`);
      if (s.sunspots != null) parts.push(`SN ${s.sunspots}`);
      if (s.a != null) parts.push(`A ${s.a}`);
      if (s.k != null) parts.push(`K ${s.k}`);
      if (s.xray) parts.push(`X-ray ${s.xray}`);
      if (s.geomag) parts.push(s.geomag);
      if (s.updated) {
        const d = new Date(s.updated.replace(' ', 'T') + 'Z');
        if (!Number.isNaN(d.getTime())) parts.push(`updated ${d.toISOString().slice(0, 16).replace('T', ' ')}Z`);
      }
      return parts.join('  ·  ');
    },
  });
}

// Minimal Chart.js config shared by the Score/Rate cards' sparklines --
// same colors as charts.html's full trend charts (dataviz reference
// palette slots 1/2) so a viewer sees the same series as the same color on
// either page, but with every axis/legend/grid stripped since this is
// decorative-but-informative filler for a card, not an analytical chart.
function sparklineConfig(values, borderColor, backgroundColor) {
  // The ring around the highlighted point needs to sit on the card's own
  // surface color to read as "floating" rather than a plain dot -- same
  // white/near-black split as dashboard.css's --surface token. Chart.js
  // draws on canvas, invisible to CSS, so it's picked once here, the same
  // approach charts.js's themeColors() uses (a theme toggle reloads the
  // page, so this never needs to react live).
  const theme = document.documentElement.getAttribute('data-theme');
  const ring = theme === 'light' ? '#ffffff' : (theme === 'wt2p' ? '#121212' : '#0a0a0a');
  const isLast = (ctx) => ctx.dataIndex === ctx.dataset.data.length - 1;
  return {
    type: 'line',
    data: {
      labels: values.map((_, i) => i),
      datasets: [{
        data: values,
        borderColor,
        backgroundColor,
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        // Every point stays invisible except the latest one, which gets a
        // solid dot -- "where the number on the tile came from," at a
        // glance, without needing the axis/legend this sparkline has no
        // room for. Scriptable so it keeps tracking the last point across
        // the .update() calls above (the trailing window keeps sliding),
        // not just the point that happened to be last at first render.
        pointRadius: (ctx) => (isLast(ctx) ? 4 : 0),
        pointHoverRadius: (ctx) => (isLast(ctx) ? 4 : 0),
        pointBackgroundColor: borderColor,
        pointBorderColor: ring,
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true },
      },
    },
  };
}
