// Client for a hamdata service (hamdata/) -- the shared solar + callsign
// lookup service a VPS full of contestscore tenants uses instead of each
// instance polling hamqsl.com and HamQTH itself. Only used when
// HAMDATA_URL (or config `hamdata.url`) is set; a standalone/Pi install
// never loads this and keeps doing both in-process.
//
// Deliberately the same shape as the pieces it stands in for:
// lookup(call) matches src/lookup/hamqth.js's client, so the lookup
// queue/pacing/backoff/pause in src/lookup/index.js is unchanged, and
// solarSince() feeds src/solar/'s poller rows already in solar_snapshots
// shape.

const TIMEOUT_MS = 15000;

function resolveHamdataUrl(env = process.env, config = {}) {
  const url = env.HAMDATA_URL || (config.hamdata && config.hamdata.url) || '';
  return String(url).replace(/\/+$/, '');
}

function createHamdataClient({ url, fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  if (!url) throw new Error('hamdata client needs a url');
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('hamdata client: no fetch implementation available');

  async function getJson(pathAndQuery) {
    const res = await doFetch(`${url}${pathAndQuery}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      let body = {};
      try { body = await res.json(); } catch { /* not JSON */ }
      const err = new Error(`hamdata ${pathAndQuery.split('?')[0]}: HTTP ${res.status}${body.error ? ` (${body.error})` : ''}`);
      // The box operator stopped all outgoing HamQTH lookups (hamdata-ctl
      // stop-lookups): not a fault, so callers can say so instead of erroring.
      if (body.code === 'paused') err.code = 'HAMDATA_PAUSED';
      if (body.code === 'disabled') err.code = 'HAMDATA_DISABLED'; // no HamQTH account configured
      throw err;
    }
    return res.json();
  }

  // -> { call, found, ...fields, source } -- source is where hamdata got it
  // (e.g. 'hamqth'), so this instance's callsign_cache rows and the busts
  // panel (source = 'hamqth') behave exactly as with a direct HamQTH client.
  async function lookup(call) {
    const cs = String(call || '').trim().toUpperCase();
    if (!cs) throw new Error('hamdata lookup: empty callsign');
    return getJson(`/lookup/${encodeURIComponent(cs)}`);
  }

  // -> solar_snapshots-shaped rows with fetched_at > after, oldest first.
  async function solarSince(after = '') {
    return getJson(`/solar/since?after=${encodeURIComponent(after || '')}`);
  }

  // -> hamdata's lookup status ({ enabled, paused, ... }); paused = the box
  // operator has stopped outgoing lookups for every instance.
  async function lookupStatus() {
    return getJson('/lookup/status');
  }

  return { lookup, solarSince, lookupStatus };
}

module.exports = { createHamdataClient, resolveHamdataUrl };
