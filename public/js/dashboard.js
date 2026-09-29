// localStorage key for the world map card's per-viewer show/hide (see
// toggleWorldMap()). Same contestpulse_ prefix as chrome.js's theme key.
const WORLDMAP_KEY = 'contestpulse_worldmap';

// Band field (N1MM's MHz, e.g. "7") -> ham band name ("40m"), and a sort
// key that orders bands by frequency. Same tables as report.js/compare.js
// -- each page's script is a plain classic script with no shared module
// (see CLAUDE.md), so each keeps its own copy.
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

function bandSortKey(b) {
  const n = parseFloat(b);
  return Number.isNaN(n) ? Infinity : n;
}

// Used by mapDotsSvg() below, which builds raw SVG markup by hand (see its
// own comment for why) -- Alpine's x-text auto-escapes, but a hand-built
// HTML string doesn't, and a callsign/exchange field ultimately comes from
// whatever the logger sent.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// Grayline (day/night terminator) -- pure date math, no server round trip,
// so it's recomputed client-side on the same 1s ticker as the UTC clock
// (see dashboard()'s `now`). Spencer (1971) Fourier-series approximations
// for solar declination and the equation of time -- the same formulas
// NOAA's solar calculator is built on. Verified before use, not just
// trusted from memory: declination checked against the solstices/equinoxes
// (matches +-23.4 / ~0 as expected), and the terminator formula checked
// against a real astronomical fact -- at a solstice it should be tangent to
// the polar circle, i.e. |90 - declination|, and it comes out to 66.5-66.6
// in both directions, matching the real arctic/antarctic circle latitude
// (66.56 deg) almost exactly.
function solarDayAngle(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
  return (2 * Math.PI * dayOfYear) / 365;
}

function solarDeclinationDeg(date) {
  const g = solarDayAngle(date);
  const rad = 0.006918
    - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.001480 * Math.sin(3 * g);
  return (rad * 180) / Math.PI;
}

function equationOfTimeMinutes(date) {
  const g = solarDayAngle(date);
  return 229.18 * (0.000075
    + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
}

// The point on Earth where the sun is directly overhead right now.
function subsolarPoint(date) {
  const lat = solarDeclinationDeg(date);
  const eot = equationOfTimeMinutes(date);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const lonRaw = -15 * (utcHours - 12 + eot / 60);
  const lon = ((lonRaw + 540) % 360) - 180; // normalize to (-180, 180]
  return { lat, lon };
}

// The terminator's latitude at a given longitude: the great circle 90 deg
// from the subsolar point. Symmetric about the subsolar meridian by real
// geometry (reflecting across the pole-to-subsolar-point plane is a
// genuine symmetry of the setup) -- terminatorLat(sub.lon + x) really does
// equal terminatorLat(sub.lon - x), that was checked and is not a bug.
function terminatorLatDeg(lonDeg, sub) {
  const subLatRad = (sub.lat * Math.PI) / 180;
  if (Math.abs(subLatRad) < 1e-6) return 0; // equinox: avoid a /~0 blowup
  const dLon = ((lonDeg - sub.lon) * Math.PI) / 180;
  return (Math.atan(-Math.cos(dLon) / Math.tan(subLatRad)) * 180) / Math.PI;
}

// Maidenhead grid locator -> approximate center { lat, lon }. Mirrors
// src/analyze/geo.js's gridToLatLon() exactly -- no build step means no
// shared module between server and browser, so this is kept in sync by
// hand (same convention as ops-dashboard's winagent/agent structs). See
// that file's own comment for the field/square/subsquare math.
function gridToLatLon(grid) {
  if (!grid || typeof grid !== 'string') return null;
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}([0-9]{2}([A-X]{2})?)?$/.test(g)) return null;

  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  let lonSpan = 20;
  let latSpan = 10;

  if (g.length >= 4) {
    lon += (g.charCodeAt(2) - 48) * 2;
    lat += (g.charCodeAt(3) - 48) * 1;
    lonSpan = 2;
    latSpan = 1;
  }
  if (g.length === 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24);
    lonSpan = 2 / 24;
    latSpan = 1 / 24;
  }

  return { lat: lat + latSpan / 2, lon: lon + lonSpan / 2 };
}

function dashboard() {
  // Chart.js instances live here, in a plain closure variable -- NOT as
  // Alpine data properties. Same reactivity trap as charts.js: Alpine
  // deep-wraps returned x-data objects in a Proxy, which breaks Chart.js's
  // internal state on a later .update() call. See charts.js's own comment
  // for the full explanation.
  let scoreSparkline = null;
  let rateSparkline = null;

  return {
    connected: false,
    score: {},
    // Full-contest score time series, just for the Score card's sparkline --
    // fetched once and refreshed on score:update, same idea as charts.html's
    // trend charts but shrunk down to fit the space Feed Status left behind
    // when it moved into the header.
    scoreHistory: [],
    radios: [],
    qsos: [],
    // World map card: shown/hidden per viewer (toggleWorldMap(), persisted
    // under WORLDMAP_KEY), and which theme's ocean image it draws. Both are
    // really set in init() -- this factory runs before any DOM/storage
    // exists in the tests' sandbox, so it can't read either here.
    showWorldMap: true,
    // Band filter for the map: 'all', or one of mapBands()' raw band
    // values. A view choice for right now, so it isn't persisted -- a
    // remembered 40m would silently empty the map in the next contest.
    mapBand: 'all',
    mapOceanHref: '/img/map/ocean-dark.webp',
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
        this.fetchBusts(); // a deleted QSO may have been a flagged bust
        this.touch();
      });

      // The lookup:result event fires for both N1MM's own <lookupinfo> and
      // the HamQTH queue. A not-found result is a new possible bust -- pull
      // the freshly-derived list rather than trying to reconstruct the row
      // (band/mode/op) from the lookup payload, which doesn't carry it.
      socket.on('lookup:result', (data) => {
        if (data && data.found === false) this.fetchBusts();
      });

      socket.on('solar:update', (data) => {
        if (data) this.solar = data;
        this.touch();
      });

      socket.on('score:update', (data) => {
        this.score = data;
        this.fetchScoreHistory();
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
        this.scoreHistory = [];
        this.radios = [];
        this.busts = [];
        this.mapBand = 'all'; // that band's QSOs are gone too
        this.fetchRate(); // trailing windows should drop to zero, not linger
        this.touch();
      });

      this.fetchInitialState();
      this.fetchVersion();
      this.fetchFeatures();
      this.fetchBusts();
      this.fetchSolar();
      // Map: a viewer's own show/hide choice, and the ocean for the active
      // theme (the theme toggle reloads the page, so reading it once here
      // is enough -- same as the Chart.js colors).
      try { this.showWorldMap = localStorage.getItem(WORLDMAP_KEY) !== 'hidden'; } catch { /* keep shown */ }
      if (document.documentElement.getAttribute('data-theme') === 'light') {
        this.mapOceanHref = '/img/map/ocean-light.webp';
      }
      // The rate windows decay purely with elapsed time, so they need to be
      // re-fetched on a timer even when nothing else is happening.
      setInterval(() => this.fetchRate(), 30000);
      // Slow safety-net poll so a bust that was corrected in the logger
      // clears even if the lookup:result / contact events were missed.
      setInterval(() => this.fetchBusts(), 60000);
      // Drives the header's live "updated Xs ago" ticker.
      setInterval(() => { this.now = Date.now(); }, 1000);
    },

    touch() {
      this.lastUpdateAt = Date.now();
    },

    secondsSinceUpdate() {
      return Math.max(0, Math.round((this.now - this.lastUpdateAt) / 1000));
    },

    // Contesting runs on UTC, not local time -- reuses the same `now` tick
    // that already drives secondsSinceUpdate(), so no extra timer.
    utcClock() {
      return new Date(this.now).toISOString().slice(11, 19) + 'Z';
    },

    // The call this station is actually transmitting under -- N1MM's
    // Station Data callsign, which is not necessarily the operator's own
    // (a club call like WT9P/K9CT while WT2P sits at the keyboard). Read from
    // `mycall`, never `operator`/`ops`/OpCall: a club station can have several
    // operators at once, and those fields name the people, not the station.
    // this.qsos is newest-first (API and socket path both), so the first row
    // with a mycall is the call in use right now, which also follows a mid-
    // contest change; score.call (the periodic dynamicresults snapshot)
    // covers a page load before any QSO has been logged.
    stationCall() {
      const q = this.qsos.find((row) => row.mycall);
      return (q && q.mycall) || this.score.call || '';
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
    scoreStale() {
      if (!this.score.captured_at || this.qsos.length === 0) return false;
      const capturedAt = new Date(this.score.captured_at).getTime();
      // qsos[0] is the most recent QSO -- getQsos() orders DESC and
      // contact:new prepends (see socket.on('contact:new') above).
      const lastQsoAt = new Date(this.qsos[0].logged_at.replace(' ', 'T') + 'Z').getTime();
      const STALE_GRACE_MS = 30000;
      return lastQsoAt > capturedAt && (this.now - capturedAt) > STALE_GRACE_MS;
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

    // WAE (and a couple of other DARC-rules contests): a logged row can be
    // a QTC -- a relayed traffic report about an earlier QSO, not a new
    // contact -- rather than an ordinary QSO. N1MM marks which is which in
    // the same field the Cabrillo line-type prefix comes from, passed
    // through untouched as qsos.exchange1 -- confirmed against a real
    // packet as "SQTC" (sent) or "RQTC" (received), not the bare "QTC"
    // originally guessed, hence the substring match rather than equality.
    // Most contests never populate exchange1 as anything but blank or a
    // real exchange value, so this stays a no-op there.
    isQtc(q) {
      return /QTC/i.test(q.exchange1 || '');
    },

    // N1MM's own verdict that this QSO counted as a new multiplier for the
    // active contest -- <ismultiplier1/2/3> in the ContactInfo packet
    // (stored as is_mult1/2/3). Which of the three is which is contest-
    // specific (e.g. state/section vs. zone vs. DXCC), so any of them
    // lights the flag rather than this guessing at a meaning. N1MM decides
    // it when the QSO is logged, so a later edit that changes the status
    // arrives as a contactreplace and updates the row in place. The logger
    // is the authority: an unflagged QSO is simply not a mult here, no
    // second-guessing from callsign, contest name or anything else.
    // One exception on our side: a WAE QTC is relayed traffic, not a contact,
    // so it never carries the flag whatever the packet says.
    isMult(q) {
      if (this.isQtc(q)) return false;
      return !!(q.is_mult1 || q.is_mult2 || q.is_mult3);
    },

    // Show/hide the world map card, remembered per viewer. A convenience,
    // not state anyone else needs -- so localStorage, and a storage failure
    // (private window, blocked site data) just means it isn't remembered.
    toggleWorldMap() {
      this.showWorldMap = !this.showWorldMap;
      try { localStorage.setItem(WORLDMAP_KEY, this.showWorldMap ? 'shown' : 'hidden'); } catch { /* not remembered */ }
    },

    // Time zone bands in the style of SDR Console's World Map: a boundary
    // line every 15 deg (nominal nautical zones centered on each 15 deg
    // meridian, not the real political borders), every other band faintly
    // shaded, and a UTC-offset badge on each zone's center meridian along
    // the top edge. The +/-12 zones straddle the dateline at the map's
    // edges, so they get no badge (it would be cut in half). Static -- no
    // reactive reads, so x-html renders it once.
    mapZonesSvg() {
      const x = (lon) => ((lon + 180) / 360) * 1000;
      const out = [];
      for (let k = -12; k <= 12; k += 1) {
        const west = Math.max(-180, k * 15 - 7.5);
        const east = Math.min(180, k * 15 + 7.5);
        if (k % 2 !== 0) {
          out.push(`<rect x="${x(west).toFixed(2)}" y="0" width="${(x(east) - x(west)).toFixed(2)}" height="500" class="worldmap-zone-band"></rect>`);
        }
        if (k < 12) out.push(`<line x1="${x(east).toFixed(2)}" y1="0" x2="${x(east).toFixed(2)}" y2="500" class="worldmap-zone-line"></line>`);
      }
      for (let k = -11; k <= 11; k += 1) {
        const label = k > 0 ? `+${k}` : String(k);
        out.push(`<g class="worldmap-zone-badge"><circle cx="${x(k * 15).toFixed(2)}" cy="11" r="8.5"></circle>`
          + `<text x="${x(k * 15).toFixed(2)}" y="11">${label}</text></g>`);
      }
      return out.join('');
    },

    // Projects a lat/lon onto the SAME 1000x500 equirectangular canvas
    // the map layers were built on (public/img/map/, viewBox="0 0 1000 500") --
    // x = (lon+180)/360 * 1000, y = (90-lat)/180 * 500. Both must agree, or
    // dots land off the coastline they are supposedly on.
    projectLatLon(lat, lon) {
      return { x: ((lon + 180) / 360) * 1000, y: ((90 - lat) / 180) * 500 };
    },

    // this.qsos is newest-first (see stationCall()'s own note). A QTC is
    // relayed traffic re-sent for an existing contact (see isQtc), not a
    // new one -- worth excluding here for the same reason the MULT chip
    // does: counting it as one of "the last 30 QSOs" would both misstate
    // the count and duplicate a dot already plotted for its real QSO.
    // Only a QSO whose call actually resolves to a location (server-attached
    // lat/lon -- see src/routes/api.js / src/udp/index.js) gets a dot.
    //
    // With a band picked (mapBand), it's the last 30 on that band, not the
    // last 30 overall narrowed down -- otherwise a quiet band would show
    // only the one or two of its QSOs that happen to be recent.
    mapPoints() {
      const points = this.qsos
        .filter((q) => !this.isQtc(q))
        .filter((q) => this.mapBand === 'all' || q.band === this.mapBand)
        .slice(0, 30)
        .filter((q) => q.lat != null && q.lon != null)
        .map((q) => ({
          key: q.ext_id ?? q.id ?? (q.call + q.band + q.mode + q.logged_at),
          call: q.call,
          band: q.band,
          mode: q.mode,
          mult: this.isMult(q),
          ...this.projectLatLon(q.lat, q.lon),
        }));
      // Mult dots draw last (SVG paints in document order) so a mult never
      // sits hidden under an ordinary dot that happens to land on the same
      // pixel -- same "make the notable one visible" reasoning as the
      // Recent QSOs chip, just expressed as z-order here instead of color.
      points.sort((a, b) => (a.mult === b.mult ? 0 : a.mult ? 1 : -1));
      return points;
    },

    // Bands present in the log (QTCs excluded, as on the map), lowest
    // frequency first -- the choices for the map's band filter.
    mapBands() {
      const bands = new Set(this.qsos.filter((q) => !this.isQtc(q) && q.band).map((q) => q.band));
      return [...bands].sort((a, b) => bandSortKey(a) - bandSortKey(b));
    },

    bandLabel(band) { return bandLabel(band); },

    // The dots are built as a raw SVG string and injected via x-html on a
    // <g> (index.html), NOT a <template x-for> inside the <svg> --
    // confirmed live in a real browser that Alpine's x-for/template breaks
    // there: the browser's foreign-content (HTML-inside-SVG) parsing of a
    // <template> mangles the directive attributes on its contents, so only
    // the first item ever bound and every attribute after it came out
    // empty ("p is not defined" thrown for the rest). x-html assigning
    // innerHTML on an SVG element parses correctly in the SVG namespace,
    // verified the same way. Escaped by hand since this is raw HTML now,
    // not Alpine's own auto-escaped x-text.
    mapDotsSvg() {
      return this.mapPoints().map((p) => {
        const title = escapeHtml(`${p.call} — ${bandLabel(p.band)} ${p.mode}${p.mult ? ' — MULT' : ''}`);
        const cls = p.mult ? 'worldmap-dot worldmap-dot--mult' : 'worldmap-dot';
        const r = p.mult ? 4 : 3;
        // A nested <title> child, not a `title` attribute -- confirmed
        // that's what actually matters: a bare attribute only feeds the
        // accessible-name computation (which is why the earlier
        // getByTitle() check falsely looked like a pass), it does not
        // trigger a real hover tooltip. <title> is SVG's own, standard
        // tooltip mechanism.
        return `<circle cx="${p.x}" cy="${p.y}" r="${r}" class="${cls}"><title>${title}</title></circle>`;
      }).join('');
    },

    // The station's own location, from N1MM's reported transmitter grid
    // (score.grid6 -- the same field the header's grid-locator chip already
    // shows) -- not hardcoded, since the grid genuinely changes: a
    // different contest, a different physical QTH, even the same club call
    // operating from a different location. Recomputed from whatever
    // score.grid6 currently says, so it moves the moment a new Score
    // broadcast reports a different one. A single, non-repeated marker, so
    // (unlike mapDotsSvg) this binds directly via ordinary :cx/:cy/:title
    // attributes -- no <template x-for>, so none of that directive's
    // SVG-nesting bug applies here.
    homePoint() {
      const ll = gridToLatLon(this.score.grid6);
      if (!ll) return null;
      return { ...this.projectLatLon(ll.lat, ll.lon), grid: this.score.grid6 };
    },

    // Day/night terminator (grayline), propagation context for the map.
    // See the solar* functions' own header comment for the astronomy and
    // how it was checked. A single shape, like the land outline -- binds
    // directly via :d, not x-html/x-for. Recomputes every render because it
    // reads `this.now` (ticks every 1s, same clock utcClock() uses), which
    // is deliberate: the terminator itself barely moves in a second, but
    // recomputing on the existing ticker is simpler and cheap enough (a
    // ~180-point trig loop) rather than adding a second, slower timer just
    // to throttle it.
    nightPolygonPath() {
      const date = new Date(this.now);
      const sub = subsolarPoint(date);
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 2) {
        const { x, y } = this.projectLatLon(terminatorLatDeg(lon, sub), lon);
        pts.push(`${lon === -180 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      // Close along whichever pole is currently dark -- sub.lat > 0 (a
      // northern-hemisphere summer subsolar point) means the SOUTH pole is
      // the one in permanent darkness right now, and vice versa. Verified
      // by rendering both solstices and sampling actual pixels before
      // trusting this, not just by reading the formula.
      //
      // The shape is padded 40 units past the viewBox on the left, right
      // and pole sides (the terminator is periodic, so lon -180 and 180
      // share a y). The map blurs this shape into a soft-edged mask
      // (index.html's #worldmap-soft), and without the padding the blur
      // would also fade the night side along the map's own edges. The
      // <svg> clips anything outside the viewBox, so the padding is never
      // drawn.
      const darkPoleY = this.projectLatLon(sub.lat >= 0 ? -90 : 90, 180).y;
      const padPoleY = darkPoleY === 0 ? -40 : 540;
      const edgeY = this.projectLatLon(terminatorLatDeg(180, sub), 180).y.toFixed(1);
      pts[0] = `M-40,${edgeY}L${pts[0].slice(1)}`;
      pts.push(`L1040,${edgeY}`, `L1040,${padPoleY}`, `L-40,${padPoleY}`, 'Z');
      return pts.join('');
    },

    async fetchInitialState() {
      try {
        const [qsos, score, scoreHistory, radios, bridges, rate] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score').then((r) => r.json()),
          fetch('/api/score/history').then((r) => r.json()),
          fetch('/api/radios').then((r) => r.json()),
          fetch('/api/bridges').then((r) => r.json()),
          fetch('/api/rate').then((r) => r.json()),
        ]);
        this.qsos         = qsos;
        this.score        = score;
        this.scoreHistory = scoreHistory;
        this.radios       = radios;
        this.bridges      = bridges;
        this.rate         = rate;
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
      const times = this.qsos
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
      for (const q of this.qsos) {
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
    renderScoreSparkline() {
      const canvas = document.getElementById('scoreSparkline');
      if (!canvas || typeof Chart === 'undefined') return;
      const values = this.scoreHistory.map((s) => s.points);

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
      rateSparkline = new Chart(canvas, sparklineConfig(values, '#2a78d6', 'rgba(42, 120, 214, 0.15)'));
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
  };
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
  const ring = document.documentElement.getAttribute('data-theme') === 'light' ? '#ffffff' : '#0a0a0a';
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
