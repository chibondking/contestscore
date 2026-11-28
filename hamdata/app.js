// hamdata's HTTP API. Bound to 127.0.0.1 by server.js -- no tunnel route,
// nothing public; the only callers are contestscore instances on the same
// box and the ops dashboard's health check.
//
//   GET  /health                 liveness + solar/lookup diagnostics
//   GET  /solar                  latest reading (same shape as contestscore's /api/solar)
//   GET  /solar/since?after=     solar_snapshots rows newer than `after`, oldest first
//   GET  /lookup/status         broker state + `cache` counts of the shared cache
//   GET  /lookup/:call           cached-or-fetched record, see broker.js
//   POST /lookup/pause|resume    bearer HAMDATA_TOKEN (503 if unset -- fail closed):
//                                stop/start ALL outgoing HamQTH lookups (persisted)
//   DELETE /lookup/cache         bearer HAMDATA_TOKEN + X-Confirm: yes -- clear the
//                                shared callsign cache (never solar data)
//   GET  /lookup/export?after_ts=&after_call=&limit=
//                                cache rows oldest-first after a (cached_at, call)
//                                cursor -- for syncing the cache between boxes
//   POST /lookup/import          bearer HAMDATA_TOKEN: merge rows from another box
//                                (newer cached_at wins; `hamdata-ctl import-cache`)
//
// Cache sync: the ops dashboard's agent on each box pulls new rows from the
// other boxes (through the dashboard) and imports them here, and exports
// this box's new rows for the others (ops repo docs/design/63). hamdata
// itself never talks to another box.

const express = require('express');
const { getDb } = require('../src/db');
const {
  getSolarSince, clearCallsignCache, countCallsignCache, exportCallsignCache, importCallsignCache,
} = require('../src/db/queries');
const { latestSolar } = require('../src/solar');
const { stripSuffix } = require('../src/lookup');

const CALL_RE = /^[A-Z0-9]{3,15}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,20}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_IMPORT = 1000;
const MAX_DATA = 4096;
const FUTURE_SLACK_MS = 10 * 60 * 1000;

// One row from another box, or null if it isn't one we'd have written
// ourselves: a base call, a provider name, a datetime('now')-shaped stamp
// that isn't in the future (a skewed clock must not win forever), and a JSON
// object no bigger than a real lookup record.
function validImportRow(r, nowMs) {
  if (!r || typeof r !== 'object') return null;
  const { call, source, cached_at: ts, data } = r;
  if (typeof call !== 'string' || !CALL_RE.test(call)) return null;
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return null;
  if (typeof ts !== 'string' || !TS_RE.test(ts)) return null;
  const ms = new Date(ts.replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(ms) || ms > nowMs + FUTURE_SLACK_MS) return null;
  if (typeof data !== 'string' || data.length > MAX_DATA) return null;
  let obj;
  try { obj = JSON.parse(data); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  return { call, source, cached_at: ts, data };
}

function createApp({ broker, solar, cosb = null, env = process.env, now = Date.now }) {
  const app = express();

  function requireToken(req, res, next) {
    const token = env.HAMDATA_TOKEN;
    if (!token) return res.status(503).json({ error: 'HAMDATA_TOKEN not configured' });
    if (req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Missing or invalid bearer token' });
    }
    return next();
  }

  app.get('/health', (req, res) => {
    let dbOk = true;
    try { getDb().prepare('SELECT 1').get(); } catch { dbOk = false; }
    const s = latestSolar();
    const ageMs = s.updated ? Date.now() - new Date(s.updated.replace(' ', 'T') + 'Z').getTime() : null;
    res.status(dbOk ? 200 : 503).json({
      status: dbOk ? 'ok' : 'degraded',
      checks: { db: { ok: dbOk } },
      solar: {
        enabled: solar ? solar.enabled : false,
        updated: s.updated,
        stale: ageMs != null && ageMs > 3 * 120 * 60000,
      },
      lookup: broker.getStatus(),
    });
  });

  app.get('/solar', (req, res) => res.json(latestSolar()));

  app.get('/solar/since', (req, res) => {
    res.json(getSolarSince(String(req.query.after || '')));
  });

  app.get('/lookup/status', (req, res) => res.json({ ...broker.getStatus(), cache: countCallsignCache() }));

  app.post('/lookup/pause', requireToken, (req, res) => { broker.pause(); res.json(broker.getStatus()); });
  app.post('/lookup/resume', requireToken, (req, res) => { broker.resume(); res.json(broker.getStatus()); });

  app.delete('/lookup/cache', requireToken, (req, res) => {
    if (req.headers['x-confirm'] !== 'yes') return res.status(400).json({ error: 'Missing X-Confirm: yes header' });
    return res.json({ cleared: clearCallsignCache() });
  });

  // Before /lookup/:call -- EXPORT is a valid-looking callsign.
  app.get('/lookup/export', (req, res) => {
    const afterTs = String(req.query.after_ts || '');
    const afterCall = String(req.query.after_call || '');
    if (afterTs && !TS_RE.test(afterTs)) return res.status(400).json({ error: 'after_ts: YYYY-MM-DD HH:MM:SS' });
    if (afterCall && !CALL_RE.test(afterCall)) return res.status(400).json({ error: 'after_call: a callsign' });
    const { rows, more } = exportCallsignCache({ afterTs, afterCall, limit: req.query.limit });
    const last = rows[rows.length - 1];
    return res.json({
      rows, more, next: last ? { ts: last.cached_at, call: last.call } : null, cache: countCallsignCache(),
    });
  });

  app.post('/lookup/import', requireToken, express.json({ limit: '8mb' }), (req, res) => {
    const list = req.body && Array.isArray(req.body.rows) ? req.body.rows : null;
    if (!list) return res.status(400).json({ error: 'body: { rows: [...] }' });
    if (list.length > MAX_IMPORT) return res.status(413).json({ error: `at most ${MAX_IMPORT} rows per import` });
    const nowMs = now();
    const ok = [];
    for (const r of list) {
      const v = validImportRow(r, nowMs);
      if (v) ok.push(v);
    }
    const applied = ok.length ? importCallsignCache(ok) : 0;
    return res.json({ received: list.length, applied, rejected: list.length - ok.length, cache: countCallsignCache() });
  });

  // contestonlinescore.com standings for one logger contest name, fetched
  // once for every scoreboard on the box (src/cosb/source.js caches the
  // scoreboard 2 min, the on-air list 10 min). No token: it's public data,
  // and hamdata listens on loopback only.
  app.get('/cosb/standings', async (req, res) => {
    if (!cosb) return res.status(503).json({ error: 'COSB not configured', code: 'disabled' });
    const contest = String(req.query.contest || '');
    const id = req.query.contest_id ? Number(req.query.contest_id) : null;
    if (!/^[A-Za-z0-9 ._/-]{0,40}$/.test(contest) || (id != null && !(Number.isInteger(id) && id > 0 && id < 1e6))) {
      return res.status(400).json({ error: 'invalid contest' });
    }
    if (!contest && !id) return res.status(400).json({ error: 'contest or contest_id required' });
    try {
      res.json(await cosb.standings({ contest, contestId: id }));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // The COSB contest list (ids + on-air status), stored in this hamdata's
  // settings and refreshed from COSB at most every 10 min; and one logger
  // contest's status, which the scoreboards' publishers check before
  // posting (COSB rejects posts to a contest that isn't on air).
  app.get('/cosb/contests', async (_req, res) => {
    if (!cosb) return res.status(503).json({ error: 'COSB not configured', code: 'disabled' });
    try { res.json(await cosb.contests()); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.get('/cosb/contest-status', async (req, res) => {
    if (!cosb) return res.status(503).json({ error: 'COSB not configured', code: 'disabled' });
    const contest = String(req.query.contest || '');
    const id = req.query.contest_id ? Number(req.query.contest_id) : null;
    if (!/^[A-Za-z0-9 ._/-]{0,40}$/.test(contest) || (id != null && !(Number.isInteger(id) && id > 0 && id < 1e6))) {
      return res.status(400).json({ error: 'invalid contest' });
    }
    if (!contest && !id) return res.status(400).json({ error: 'contest or contest_id required' });
    try { res.json(await cosb.contestStatus({ contest, contestId: id })); } catch (err) { res.status(502).json({ error: err.message }); }
  });

  app.get('/lookup/:call', async (req, res) => {
    const call = stripSuffix(req.params.call);
    if (!CALL_RE.test(call)) return res.status(400).json({ error: 'invalid callsign' });
    try {
      res.json(await broker.get(call));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message, ...(err.code === 'paused' || err.code === 'disabled' ? { code: err.code } : {}) });
    }
  });

  return app;
}

module.exports = { createApp, validImportRow };
