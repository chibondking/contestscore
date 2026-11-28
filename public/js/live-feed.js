// The live contest feed, as one part of a page's component (see
// component.js): the QSO log, the station's score, the rate windows and the
// COSB standings, loaded from the API and kept current over socket.io.
//
// Other parts react to the feed through its events instead of reaching
// into its socket handlers:
//
//   this.onLive('contact', (qso, isNew) => ...)  a QSO logged or edited
//   this.onLive('delete', (qso) => ...)          a QSO deleted
//   this.onLive('lookup', (result) => ...)       a callsign lookup finished
//   this.onLive('score', (score) => ...)         a new score broadcast
//   this.onLive('cleared', () => ...)            the log was wiped
//   this.onLive('reconnect', () => ...)          the socket came back
//
// Register listeners before calling initLiveFeed(). initLiveFeed() returns
// the socket, so a page can also listen for events only it uses.

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

// An X-QSO (N1MM's IsClaimedQso 0, stored as is_claimed_qso) stays in the
// log -- Recent QSOs shows it, marked -- but counts toward nothing: no QSO
// totals, rates, operator stats, continents or map dots. Missing/null counts
// (older rows, loggers that never send the flag), same as the column default.
// A Score source that reports on an interval rather than per QSO -- DXLog.net
// (see scoreIsDelayed()). Matched on the broadcast's <soft>.
// DXLog's score timer runs 2-30 min (CJ, 2026-09-30). Gaps outside these
// bounds aren't the timer -- see scoreIntervalMinutes().

function isCountedQso(q) {
  return q.is_claimed_qso == null || Number(q.is_claimed_qso) !== 0;
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

// "W1AW/4", "OK2CQR/P" -> the base call. Mirrors src/lookup/index.js's
// stripSuffix() exactly (kept in sync by hand, like gridToLatLon above) --
// lookup:result's `base` is the server's version, so the two must agree for
// a portable call's dot to be matched.
function stripSuffix(raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (!c || !c.includes('/')) return c;

  const parts = c.split('/').filter(Boolean);
  if (parts.length === 1) return parts[0];

  const tail = parts[parts.length - 1];
  if (/^(P|M|MM|AM|A|R|QRP|LH|\d{1,2})$/.test(tail)) parts.pop();
  if (parts.length === 1) return parts[0];

  const looksLikeCall = (t) => /\d/.test(t) && t.length >= 3;
  const [a, b] = parts;
  if (looksLikeCall(a) && !looksLikeCall(b)) return a;
  if (looksLikeCall(b) && !looksLikeCall(a)) return b;
  return a.length >= b.length ? a : b;
}

// The Standings card's scope (setCosbScope()), per viewer.
const COSB_SCOPE_KEY = 'contestpulse_cosb_scope';

function liveFeed() {
  // Listeners by event name. Kept in this closure, not on the component,
  // so Alpine doesn't wrap them in its reactive proxy.
  const listeners = {};

  return {
    connected: false,

    score: {},

    qsos: [],

    // N1MM-style rate meter: [{ minutes, qsos, rate_per_hour }, ...]. Pure
    // function of wall-clock time (a lull should visibly decay the rate
    // even with no new QSOs), so this is polled on a timer, not just
    // refreshed on contact:new.
    rate: [],

    // contestonlinescore.com standings for this station (GET /api/cosb,
    // cosb:update every ~2 min while a contest is live). The card shows
    // only when status is 'ok' -- this station found in a COSB category.
    cosb: { status: 'idle' },
    // The viewer's COSB scope: 'world', 'cont:EU', 'zone:5' (src/cosb/
    // scope.js). Per viewer, under COSB_SCOPE_KEY; set in initLiveFeed().
    cosbScope: 'world',

    // "Last updated" ticker: lastUpdateAt bumps on every socket event or
    // successful poll; now ticks every second so secondsSinceUpdate()
    // counts up live in the header even between events, proving the page
    // itself is still alive and not just frozen mid-render.
    lastUpdateAt: Date.now(),

    now: Date.now(),

    onLive(event, fn) {
      (listeners[event] || (listeners[event] = [])).push(fn);
    },

    emitLive(event, ...args) {
      for (const fn of listeners[event] || []) fn(...args);
    },

    // Open the socket, load the current state and start the timers.
    initLiveFeed() {
      const socket = io();

      socket.on('connect',    () => this.onSocketConnect());
      socket.on('disconnect', () => { this.connected = false; });

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
        this.emitLive('contact', data, idx < 0);
        this.fetchRate();
        this.touch();
      });

      socket.on('contact:delete', (data) => {
        this.qsos = this.qsos.filter((q) => (
          data.ext_id ? q.ext_id !== data.ext_id : !(q.call === data.call && q.band === data.band)
        ));
        this.emitLive('delete', data);
        this.fetchRate();
        this.touch();
      });

      // Fires for both N1MM's own <lookupinfo> and the HamQTH queue.
      socket.on('lookup:result', (data) => {
        this.emitLive('lookup', data);
        // A found result with a usable grid carries lat/lon (src/udp/
        // index.js). Move this call's already-plotted dots there -- their
        // contact:new went out before the lookup ran, so they're sitting on
        // the country-file estimate. A QSO's own exchange grid still wins,
        // same as resolveLatLonEnriched on the server.
        if (data && data.lat != null && data.lon != null && data.base) {
          let moved = false;
          const qsos = this.qsos.map((q) => {
            if (q.locSource === 'exchange' || stripSuffix(q.call) !== data.base) return q;
            moved = true;
            return { ...q, lat: data.lat, lon: data.lon, locSource: data.locSource };
          });
          if (moved) this.qsos = qsos;
        }
      });

      socket.on('score:update', (data) => {
        this.score = data;
        this.emitLive('score', data);
        this.touch();
      });

      // The push is the whole-board view; a viewer on a scope asks for theirs.
      socket.on('cosb:update', (data) => {
        if (!data) return;
        if (this.cosbScope === 'world') this.cosb = data;
        else this.fetchCosb();
      });

      socket.on('db:cleared', () => {
        this.qsos = [];
        this.score = {};
        this.emitLive('cleared');
        this.fetchRate(); // trailing windows should drop to zero, not linger
        this.touch();
      });

      try { this.cosbScope = localStorage.getItem(COSB_SCOPE_KEY) || 'world'; } catch { /* world */ }
      this.fetchLiveState();
      this.fetchCosb();
      // The rate windows decay purely with elapsed time, so they need to be
      // re-fetched on a timer even when nothing else is happening.
      setInterval(() => this.fetchRate(), 30000);
      // Drives the live clocks ("updated Xs ago", the UTC clock).
      setInterval(() => { this.now = Date.now(); }, 1000);
      return socket;
    },

    // A reconnect may have missed events: reload rather than trust the gap.
    onSocketConnect() {
      this.connected = true;
      this.socketConnects = (this.socketConnects || 0) + 1;
      if (this.socketConnects > 1) {
        this.fetchLiveState();
        this.fetchCosb();
        this.emitLive('reconnect');
      }
      this.touch();
    },

    async fetchLiveState() {
      try {
        const [qsos, score, rate] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score').then((r) => r.json()),
          fetch('/api/rate').then((r) => r.json()),
        ]);
        this.qsos  = qsos;
        this.score = score;
        this.rate  = rate;
        this.touch();
      } catch (err) {
        console.error('Failed to load initial state:', err);
      }
    },

    // DXCC entities (countries) worked: distinct N1MM country prefixes
    // over the QSOs that count, QTCs left out (relayed traffic, not a
    // contact). null when the logger sends no prefix -- the metric hides.
    dxccCount() {
      const s = new Set();
      for (const q of this.qsos) {
        if (q.countryprefix && isCountedQso(q) && !this.isQtc(q)) s.add(q.countryprefix);
      }
      return s.size ? s.size : null;
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

    bandLabel(band) { return bandLabel(band); },

    // The QSOs that count (see isCountedQso) -- what every total, rate and
    // map dot on this page is built from. this.qsos itself keeps X-QSOs so
    // Recent QSOs can still show them.
    countedQsos() { return this.qsos.filter(isCountedQso); },

    isXQso(q) { return !isCountedQso(q); },

    async fetchRate() {
      try {
        this.rate = await fetch('/api/rate').then((r) => r.json());
        this.touch();
      } catch (err) {
        console.error('Failed to refresh rate:', err);
      }
    },

    async fetchCosb() {
      try {
        const q = this.cosbScope && this.cosbScope !== 'world' ? `?scope=${encodeURIComponent(this.cosbScope)}` : '';
        const res = await fetch(`/api/cosb${q}`).then((r) => r.json());
        const st = res && res.standings;
        if (!st) return;
        // A scope saved in an earlier contest that this category doesn't
        // have: back to the whole board, so the picker and table agree.
        const choices = st.scopes ? [...st.scopes.continents, ...st.scopes.zones].map((o) => o.scope) : null;
        if (q && choices && !choices.includes(this.cosbScope)) { this.setCosbScope('world'); return; }
        this.cosb = st;
      } catch (err) {
        console.error('Failed to load COSB standings:', err);
      }
    },

    // The Standings card's scope picker. Remembered per viewer.
    setCosbScope(scope) {
      this.cosbScope = scope || 'world';
      try { localStorage.setItem(COSB_SCOPE_KEY, this.cosbScope); } catch { /* not remembered */ }
      this.fetchCosb();
    },

    // "NA" / "Zone 5" / '' (whole board): for headers and the HUD.
    cosbScopeLabel() {
      const c = this.cosb || {};
      return c.scope && c.scope !== 'world' ? c.scope_label || '' : '';
    },

    cosbTitle() {
      const c = this.cosb || {};
      const bits = ['contestonlinescore.com'];
      if (c.contest && c.contest.name) bits.push(c.contest.name);
      if (c.updated) bits.push(`board ${c.updated}`);
      if (c.error) bits.push(`last refresh failed: ${c.error}`);
      return bits.join(' · ');
    },

    // When COSB last updated its board, for the cards and the map HUD:
    // "updated 07:16z · 3 min ago". COSB stamps the board in UTC
    // ("28 Nov 2026 07:16 UTC"); '' when there's no board time.
    cosbUpdatedLabel() {
      const u = this.cosb && this.cosb.updated;
      const m = /(\d{2}):(\d{2}) UTC$/.exec(String(u || ''));
      if (!m) return '';
      const t = Date.parse(String(u).replace(' UTC', ' GMT'));
      const mins = Number.isFinite(t) ? Math.max(0, Math.floor((this.now - t) / 60000)) : null;
      const ago = mins == null ? '' : mins < 1 ? ' · just now' : ` · ${mins} min ago`;
      return `updated ${m[1]}:${m[2]}z${ago}`;
    },
  };
}
