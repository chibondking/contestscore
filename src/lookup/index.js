// Server-side callsign lookup for the LIVE dashboard only -- the offline
// analyzer (src/analyze/) never imports this. Today the one provider is
// HamQTH; `qrz` / `hamdb` are named in the config but not implemented.
//
// Flow: src/udp/index.js calls enqueue(call) on every contact:new. We skip
// calls already in callsign_cache (any source, incl. N1MM's own lookupinfo)
// and calls already queued/in-flight, then work the queue one at a time
// with a small gap between requests. Each result is emitted as
// `lookup:result` (same event N1MM's lookupinfo uses); the udp/index.js
// handler is the single writer to callsign_cache.
//
// Nothing here can crash the dashboard: a provider outage just means the
// queue drains slowly (with backoff) and no lookup:result events fire.

const defaultConfig = require('../../config/default.json');
const { getCachedCallsign, getQsos, getSetting, setSetting } = require('../db/queries');
const { isFresh } = require('./ttl');
const { createHamqthClient } = require('./hamqth');
const { createHamdataClient, resolveHamdataUrl } = require('../hamdata/client');

const KNOWN_PROVIDERS = new Set(['hamqth']);
const BETWEEN_MS = 350;          // spacing between upstream requests
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const PRIME_CAP = 300;           // most calls to back-fill on startup

// "W1AW/4", "OK2CQR/P", "K1ABC/QRP" -> the base call. "PREFIX/CALL"
// (portable in another entity, e.g. "VP2E/W1ABC") keeps the token that
// looks like a full callsign.
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

// Resolve provider + credentials from env (wins) then config. `enabled` is
// true only for a known provider that actually has credentials. A hamdata
// URL wins over everything: the shared service holds the credentials and
// this instance just asks it.
function resolveLookupConfig(env = process.env, config = defaultConfig) {
  const lk = config.lookup || {};
  const prg = lk.prg || 'contestscore';
  const hamdataUrl = resolveHamdataUrl(env, config);
  if (hamdataUrl) return { provider: 'hamdata', enabled: true, prg, url: hamdataUrl };

  const provider = String(env.LOOKUP_PROVIDER || lk.provider || 'none').toLowerCase();
  if (!KNOWN_PROVIDERS.has(provider)) return { provider: 'none', enabled: false, prg };

  const creds = lk[provider] || {};
  const username = env[`${provider.toUpperCase()}_USERNAME`] || creds.username || '';
  const password = env[`${provider.toUpperCase()}_PASSWORD`] || creds.password || '';
  return { provider, enabled: Boolean(username && password), prg, username, password };
}

function createLookupService({ emitter, env, config, deps = {} } = {}) {
  const cfg = resolveLookupConfig(env, config);
  const getCached = deps.getCachedCallsign || getCachedCallsign;
  const readSetting = deps.getSetting || getSetting;
  const writeSetting = deps.setSetting || setSetting;
  const now = deps.now || Date.now;
  const listQsos = deps.getQsos || getQsos;
  const sleep = deps.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));
  const betweenMs = deps.betweenMs != null ? deps.betweenMs : BETWEEN_MS;

  let client = null;
  if (cfg.provider === 'hamdata') {
    client = deps.client || createHamdataClient({ url: cfg.url, fetchImpl: deps.fetchImpl });
  } else if (cfg.enabled && cfg.provider === 'hamqth') {
    client = deps.client || createHamqthClient({
      username: cfg.username, password: cfg.password, prg: cfg.prg, fetchImpl: deps.fetchImpl,
    });
  } else if (cfg.provider !== 'none' && !cfg.enabled) {
    console.warn(`lookup: provider "${cfg.provider}" selected but no credentials -- lookups disabled`);
  }

  const enabled = Boolean(client);
  const queue = [];
  const pending = new Set();
  let runPromise = null;
  let backoffMs = 0;
  let backoffUntil = 0;
  let saidUpstreamPaused = false;
  // Kill switch, toggled from the admin page (e.g. a multi-op pushing enough
  // QSO rate that lookup traffic itself becomes a concern, or a hosted club
  // that just doesn't want lookups) -- separate from `enabled`, which only
  // reflects whether a provider was configured at startup. Paused rejects
  // new enqueues *and* drops whatever's already queued: the point is an
  // immediate stop, not a slow one. Persisted in `settings` (lookup_paused)
  // so it survives a restart or deploy.
  const PAUSED_KEY = 'lookup_paused';
  let paused = false;
  try { paused = readSetting(PAUSED_KEY) === '1'; } catch { paused = false; }

  // Fresh = cached within the TTL (src/lookup/ttl.js: ~6 months found, a
  // day not-found). A stale row is looked up again and replaced.
  function isCached(call) {
    try { return isFresh(getCached(call), now()); } catch { return false; }
  }

  function enqueue(rawCall) {
    if (!enabled || paused) return;
    const call = stripSuffix(rawCall);
    if (call.length < 3 || pending.has(call) || isCached(call)) return;
    pending.add(call);
    queue.push(call);
    if (!runPromise) runPromise = run().finally(() => { runPromise = null; });
  }

  async function run() {
    while (queue.length) {
      const wait = backoffUntil - Date.now();
      if (wait > 0) await sleep(wait);

      const call = queue.shift();
      try {
        const rec = await client.lookup(call);
        // A hamdata result says where it really came from ('hamqth'); keep
        // that so cache rows and the busts panel match a direct lookup.
        if (emitter) emitter.emit('lookup:result', { ...rec, call, source: rec.source || cfg.provider, found: rec.found });
        backoffMs = 0;
        backoffUntil = 0;
        saidUpstreamPaused = false;
      } catch (err) {
        // The box operator stopping lookups for everyone isn't a fault --
        // say so once, not once per call.
        if (err.code !== 'HAMDATA_PAUSED') console.error(`lookup ${call}: ${err.message}`);
        else if (!saidUpstreamPaused) { console.warn('lookup: stopped upstream by the server operator -- cached calls only'); saidUpstreamPaused = true; }
        backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
        backoffUntil = Date.now() + backoffMs;
        // Drop the call; a later contactreplace / re-log re-enqueues it.
      } finally {
        pending.delete(call);
      }

      if (queue.length && betweenMs > 0) await sleep(betweenMs);
    }
  }

  // Back-fill lookups for QSOs already in the DB (e.g. a server restart
  // mid-contest), newest-first, capped so a big log doesn't stall the queue.
  function prime(cap = PRIME_CAP) {
    if (!enabled) return;
    let rows = [];
    try { rows = listQsos() || []; } catch { rows = []; }
    const seen = new Set();
    for (let i = rows.length - 1; i >= 0 && seen.size < cap; i -= 1) {
      const c = stripSuffix(rows[i].call);
      if (c && !seen.has(c)) { seen.add(c); enqueue(rows[i].call); }
    }
  }

  // Stops new lookups immediately and clears the pending queue -- an
  // already-in-flight request (the one `run()` is currently awaiting) is
  // left to finish on its own rather than aborted; the next one won't
  // start. Also frees every queued call's `pending` entry, since nothing
  // will run() far enough to hit that call's own `finally` otherwise --
  // left uncleared, resume() would find those calls permanently stuck
  // "already queued" and silently refuse to ever re-enqueue them.
  function persist(value) {
    try { writeSetting(PAUSED_KEY, value ? '1' : '0'); } catch (e) { console.warn(`lookup: couldn't save paused state: ${e.message}`); }
  }

  function pause() {
    paused = true;
    persist(true);
    for (const call of queue) pending.delete(call);
    queue.length = 0;
  }

  function resume() {
    paused = false;
    persist(false);
  }

  return {
    enqueue,
    prime,
    pause,
    resume,
    getStatus: () => ({ provider: enabled ? cfg.provider : 'none', enabled, paused: enabled && paused }),
    idle: () => runPromise || Promise.resolve(),
  };
}

module.exports = { createLookupService, resolveLookupConfig, stripSuffix };
