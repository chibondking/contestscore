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

const HAMQSL_URL = 'https://www.hamqsl.com/solarxml.php';
const PARSE_OPTS = { explicitArray: false, trim: true };

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
    retentionDays: Number(env.SOLAR_RETENTION_DAYS) || cfg.retentionDays || 365,
  };
}

function createSolarService({ io, env = process.env, deps = {} } = {}) {
  const { enabled, refreshMs, retentionDays } = resolveSolarConfig(env);

  const doFetch = deps.fetchImpl || globalThis.fetch;
  const insert = deps.insertSolarSnapshot || insertSolarSnapshot;
  const latest = deps.getLatestSolar || getLatestSolar;
  const prune = deps.pruneSolarSnapshots || pruneSolarSnapshots;

  let timer = null;
  let current = null;
  try { current = latest(); } catch { current = null; } // seed from last stored reading

  async function refresh() {
    if (!enabled) return null;
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
    getCurrent: () => publicView(current),
  };
}

module.exports = { createSolarService, parseSolarXml, resolveSolarConfig, latestSolar };
