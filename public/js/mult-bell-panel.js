// The mult bell, as one part of a page's component (see component.js): a
// desk-bell "ding" when a new multiplier is logged, set from the bell
// control in the page header (public/partials/mult-bell.html).
//
// Needs liveFeed() in the same component (it listens for 'contact' and
// counts mults from qsos/score). Used by the dashboard and Map TV; the
// settings are this browser's (localStorage, MULTBELL_KEY), so both pages
// share them. The strike count lives in multbell.js, shared with the TUI.

// ---------------------------------------------------------------------
// Mult bell: a desk-bell "ding" when a new multiplier is logged. Per viewer
// (it's this browser's speaker), so localStorage like the map toggle, and
// OFF unless the viewer turns it on. `after` holds it quiet until the
// contest has more than that many mults -- early on nearly every QSO is a
// mult, and a ding a minute for the first many hours is just noise.
const MULTBELL_KEY = 'contestpulse_multbell';
const MULTBELL_DEFAULTS = { enabled: false, after: 0, volume: 0.6 };
// One ding per burst: ContestPulse's held contact queue (v1.8.0) can flush
// a backlog of QSOs in a few seconds after an outage.
const MULTBELL_COOLDOWN_MS = 2000;
// A QSO whose own N1MM timestamp is older than this is a replayed backlog,
// not news. Generous on purpose: the logging PC's clock may be off a bit.
const MULTBELL_MAX_AGE_MS = 15 * 60 * 1000;

// Whatever localStorage held (or nothing) -> a complete, sane settings object.
function normalizeMultBell(raw) {
  let s = raw;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { s = null; }
  }
  if (!s || typeof s !== 'object') s = {};
  const after = Math.floor(Number(s.after));
  const volume = Number(s.volume);
  return {
    enabled: s.enabled === true,
    after: Number.isFinite(after) && after > 0 ? after : 0,
    volume: s.volume != null && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : MULTBELL_DEFAULTS.volume,
  };
}

// Should this contact:new ring the bell? `isNew` is false for a
// contactreplace edit of a QSO already on screen -- an edit isn't a newly
// worked mult. `multCount` is the contest's mult total including this one.
// `n1mmAgeMs` is now minus the QSO's own logged timestamp (null if unknown).
function multBellShouldRing({ settings, isNew, isMult, counted, multCount, n1mmAgeMs, msSinceLastDing }) {
  if (!settings || !settings.enabled) return false;
  if (!isNew || !isMult || !counted) return false;
  if (!(multCount > settings.after)) return false;
  if (n1mmAgeMs != null && n1mmAgeMs > MULTBELL_MAX_AGE_MS) return false;
  if (msSinceLastDing != null && msSinceLastDing < MULTBELL_COOLDOWN_MS) return false;
  return true;
}

// multDingCount / MULTBELL_STRIKE_GAP_MS live in multbell.js (shared with the TUI).

// N1MM's <timestamp> ("2026-09-16 14:23:05", UTC) -> epoch ms, or null.
function n1mmTimestampMs(ts) {
  if (!ts) return null;
  const t = new Date(String(ts).trim().replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? null : t;
}

// Synthesized, so there's no audio file to ship or cache: a service bell is
// a bright fundamental plus a few inharmonic partials that die away faster
// the higher they are, struck by a short click. The two slightly detuned
// fundamentals beat against each other for the ring's shimmer. `delay`
// (seconds) schedules the strike later, for a double or triple ding.
function playDeskBell(ctx, volume, delay = 0) {
  const t0 = ctx.currentTime + 0.01 + delay;
  const out = ctx.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume)) * 0.35;
  out.connect(ctx.destination);
  const f0 = 1870;
  const partials = [
    [1, 1.0, 2.4], [1.0016, 0.6, 2.2], [2.74, 0.35, 0.9],
    [5.38, 0.18, 0.45], [8.9, 0.08, 0.25],
  ];
  for (const [ratio, amp, decay] of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f0 * ratio;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }
  // The striker: 15ms of decaying noise.
  const len = Math.floor(ctx.sampleRate * 0.015);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const click = ctx.createBufferSource();
  const cg = ctx.createGain();
  cg.gain.value = 0.25;
  click.buffer = buf;
  click.connect(cg).connect(out);
  click.start(t0);
}

function multBellPanel() {
  // Mult bell's Web Audio context, made on first use; and when it last rang.
  // In this closure, not on the component, so Alpine doesn't proxy them.
  let audioCtx = null;
  let lastDingAt = null;

  return {
    // Mult bell settings (normalizeMultBell), read from localStorage in
    // init(); the header popover is open or not; and whether the browser is
    // still blocking sound until someone clicks the page (autoplay policy --
    // after a reload, a wall display needs one click before it can ding).
    multBell: { ...MULTBELL_DEFAULTS },

    multBellOpen: false,

    audioBlocked: false,

    // Load this browser's settings, unlock audio on the first click or key,
    // and ring on each new QSO. Call once from the page's init().
    initMultBell() {
      try { this.multBell = normalizeMultBell(localStorage.getItem(MULTBELL_KEY)); } catch { /* defaults: off */ }
      // Browsers only start audio after a user gesture. Any click or key on
      // the page counts, so unlock on the first one if the bell is on.
      const unlock = () => { if (this.multBell.enabled) this.ensureAudio(); };
      window.addEventListener('pointerdown', unlock);
      window.addEventListener('keydown', unlock);
      if (this.multBell.enabled) this.ensureAudio();
      this.onLive('contact', (q, isNew) => this.maybeRingMultBell(q, isNew));
    },

    // Mults so far, including any just prepended: N1MM's own total from the
    // Score broadcast, or the flagged QSOs in the live log, whichever is
    // higher -- the Score snapshot lags the log, and a logger with no
    // <mult> breakdown leaves score.mults null.
    multCount() {
      const logged = this.qsos.filter((q) => isCountedQso(q) && this.isMult(q)).length;
      const reported = Number(this.score.mults);
      return Math.max(logged, Number.isFinite(reported) ? reported : 0);
    },

    maybeRingMultBell(q, isNew) {
      const now = Date.now();
      const ts = n1mmTimestampMs(q.n1mm_timestamp);
      const ring = multBellShouldRing({
        settings: this.multBell,
        isNew,
        isMult: this.isMult(q),
        counted: isCountedQso(q),
        multCount: this.multBell.enabled ? this.multCount() : 0,
        n1mmAgeMs: ts == null ? null : now - ts,
        msSinceLastDing: lastDingAt == null ? null : now - lastDingAt,
      });
      if (!ring) return;
      lastDingAt = now;
      this.ding(multDingCount(q));
    },

    // Make (or wake) the audio context. Must first run inside a user
    // gesture or the browser leaves it suspended; audioBlocked says so in
    // the popover until a click lets it through.
    ensureAudio() {
      try {
        if (!audioCtx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return null;
          audioCtx = new Ctx();
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().then(() => { this.audioBlocked = false; }).catch(() => {});
        }
        this.audioBlocked = audioCtx.state !== 'running';
        return audioCtx;
      } catch {
        return null;
      }
    },

    ding(strikes = 1) {
      const ctx = this.ensureAudio();
      if (!ctx) return;
      try {
        for (let i = 0; i < Math.max(1, strikes); i += 1) {
          playDeskBell(ctx, this.multBell.volume, (i * MULTBELL_STRIKE_GAP_MS) / 1000);
        }
      } catch { /* no sound, no harm */ }
    },

    saveMultBell() {
      this.multBell = normalizeMultBell(this.multBell);
      try { localStorage.setItem(MULTBELL_KEY, JSON.stringify(this.multBell)); } catch { /* not remembered */ }
      if (this.multBell.enabled) this.ensureAudio();
    },

    // 'off' | 'on' | 'blocked' (on, but the browser won't play sound until
    // a click on the page) -- the header button's look and label.
    multBellState() {
      if (!this.multBell.enabled) return 'off';
      return this.audioBlocked ? 'blocked' : 'on';
    },

    multBellTitle() {
      if (!this.multBell.enabled) return 'Mult bell: off';
      if (this.audioBlocked) return 'Mult bell: on, but the browser is holding sound back -- click anywhere on the page';
      return this.multBell.after > 0
        ? `Mult bell: on after ${this.multBell.after} mults (${this.multCount()} so far)`
        : 'Mult bell: on';
    },
  };
}
