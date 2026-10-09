// Space-weather (SFI / A / K / sunspots) for the dashboard header.
//
// Polls hamqsl.com's solar XML (N0NBH's widget feed) on a slow timer -- the
// underlying data updates a few times a day at most -- keeps the newest
// reading in memory for GET /api/solar, appends every fetch to
// solar_snapshots, and emits `solar:update` when a fetch lands.
//
// The time series is the point of persisting, not just the latest value: a
// later feature will join solar_snapshots against a from-live analysis's
// time span to chart QSO rate vs. conditions. That's why the table is NOT
// wiped by DELETE /api/db.
//
// Nothing here can affect the core dashboard: a failed fetch logs and
// leaves the last good reading in place.

const xml2js = require('xml2js');
const config = require('../../config/default.json');
const { insertSolarSnapshot, getLatestSolar, pruneSolarSnapshots } = require('../db/queries');
const { createHamdataClient, resolveHamdataUrl } = require('../hamdata/client');

const HAMQSL_URL = 'https://www.hamqsl.com/solarxml.php';
const PARSE_OPTS = { explicitArray: false, trim: true };
// hamdata mode polls a local service, not hamqsl, so it can afford to look
// often -- a new reading shows up within minutes of hamdata fetching it.
const HAMDATA_POLL_MS = 10 * 60000;

function intOrNull(v) {
  const n = parseInt(String(v == null ? '' : v).trim(), 10);
  return Number.isNaN(n) ? null : n;
}

// hamqsl: <solar><solardata> solarflux / aindex / kindex / sunspots / xray
// / geomagfield / updated / ... </solardata></solar>
async function parseSolarXml(text) {
  const result = await xml2js.parseStringPromise(text, PARSE_OPTS);
  const d = result && result.solar && result.solar.solardata;
  if (!d) throw new Error('solar: unrecognised response');
  return {
    sfi: intOrNull(d.solarflux),
    a: intOrNull(d.aindex),
    k: intOrNull(d.kindex),
    sunspots: intOrNull(d.sunspots),
    xray: (typeof d.xray === 'string' ? d.xray.trim() : '') || null,
    geomag: (typeof d.geomagfield === 'string' ? d.geomagfield.trim() : '') || null,
    source_updated: (typeof d.updated === 'string' ? d.updated.trim() : '') || null,
  };
}

// DB row -> the shape the API / socket expose.
function publicView(row) {
  if (!row) return { updated: null };
  return {
    sfi: row.sfi, a: row.a_index, k: row.k_index, sunspots: row.sunspots,
    xray: row.xray, geomag: row.geomag,
    updated: row.fetched_at || null,
  };
}

// The last stored reading, as GET /api/solar returns it. Reads the DB
// directly (the service's in-memory copy is just a cache of this).
function latestSolar() {
  try { return publicView(getLatestSolar()); } catch { return { updated: null }; }
}

function resolveSolarConfig(env = process.env, cfgRoot = config) {
  const cfg = (cfgRoot && cfgRoot.solar) || {};
  return {
    enabled: String(env.SOLAR_ENABLED ?? cfg.enabled ?? true) !== 'false',
    refreshMs: (Number(env.SOLAR_REFRESH_MINUTES) || cfg.refreshMinutes || 120) * 60000,
    retentionDays: Number(env.SOLAR_RETENTION_DAYS) || cfg.retentionDays || 1826, // 5 years
    hamdataUrl: resolveHamdataUrl(env, cfgRoot),
  };
}

function createSolarService({ io, env = process.env, deps = {} } = {}) {
  const { enabled, refreshMs: hamqslRefreshMs, retentionDays, hamdataUrl } = resolveSolarConfig(env);
  const refreshMs = hamdataUrl ? HAMDATA_POLL_MS : hamqslRefreshMs;
  const hamdata = hamdataUrl
    ? (deps.hamdataClient || createHamdataClient({ url: hamdataUrl, fetchImpl: deps.fetchImpl }))
    : null;

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const insert = deps.insertSolarSnapshot || insertSolarSnapshot;
  const latest = deps.getLatestSolar || getLatestSolar;
  const prune = deps.pruneSolarSnapshots || pruneSolarSnapshots;

  let timer = null;
  let current = null;
  try { current = latest(); } catch { current = null; } // seed from last stored reading

  // hamdata mode: copy every reading hamdata has that this instance
  // doesn't yet, keeping hamdata's own fetched_at. The local table stays the
  // single source for /api/solar, /api/solar/history and the analyzer, so
  // none of them change -- and a brand-new instance back-fills the whole
  // history on its first poll (paged, see getSolarSince).
  async function refreshFromHamdata() {
    try {
      let added = 0;
      for (;;) {
        const last = latest();
        const rows = await hamdata.solarSince(last ? last.fetched_at : '');
        if (!Array.isArray(rows) || !rows.length) break;
        for (const r of rows) {
          insert({
            sfi: r.sfi, a: r.a_index, k: r.k_index, sunspots: r.sunspots,
            xray: r.xray, geomag: r.geomag, source_updated: r.source_updated,
            fetched_at: r.fetched_at,
          });
        }
        added += rows.length;
        if (rows.length < 1000) break; // hamdata's page size; a short page is the last
      }
      if (!added) return current;
      try { prune({ ttlDays: retentionDays }); } catch (e) { console.warn(`solar prune: ${e.message}`); }
      current = latest();
      if (io) io.emit('solar:update', publicView(current));
      return current;
    } catch (err) {
      console.error(`solar refresh (hamdata) failed: ${err.message}`);
      return null;
    }
  }

  async function refresh() {
    if (!enabled) return null;
    if (hamdata) return refreshFromHamdata();
    try {
      const res = await doFetch(HAMQSL_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reading = await parseSolarXml(await res.text());
      if (reading.sfi == null && reading.a == null && reading.k == null) {
        throw new Error('no indices in response');
      }
      insert(reading);
      try { prune({ ttlDays: retentionDays }); } catch (e) { console.warn(`solar prune: ${e.message}`); }
      current = latest();
      if (io) io.emit('solar:update', publicView(current));
      return current;
    } catch (err) {
      console.error(`solar refresh failed: ${err.message}`);
      return null; // keep the last good `current`
    }
  }

  function start() {
    if (!enabled || timer) return;
    refresh();
    timer = setInterval(refresh, refreshMs);
    if (timer.unref) timer.unref(); // don't keep the process alive for this
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start,
    stop,
    refresh,
    enabled,
    source: hamdata ? 'hamdata' : 'hamqsl',
    getCurrent: () => publicView(current),
  };
}

module.exports = { createSolarService, parseSolarXml, resolveSolarConfig, latestSolar };
