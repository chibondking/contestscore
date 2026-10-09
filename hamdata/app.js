// hamdata's HTTP API. Bound to 127.0.0.1 by server.js -- no tunnel route,
// nothing public; the only callers are contestscore instances on the same
// box and the ops dashboard's health check.
//
//   GET  /health                 liveness + solar/lookup diagnostics
//   GET  /solar                  latest reading (same shape as contestscore's /api/solar)
//   GET  /solar/since?after=     solar_snapshots rows newer than `after`, oldest first
//   GET  /lookup/status
//   GET  /lookup/:call           cached-or-fetched record, see broker.js
//   POST /lookup/pause|resume    bearer HAMDATA_TOKEN (503 if unset -- fail closed):
//                                stop/start ALL outgoing HamQTH lookups (persisted)
//   DELETE /lookup/cache         bearer HAMDATA_TOKEN + X-Confirm: yes -- clear the
//                                shared callsign cache (never solar data)

const express = require('express');
const { getDb } = require('../src/db');
const { getSolarSince, clearCallsignCache } = require('../src/db/queries');
const { latestSolar } = require('../src/solar');
const { stripSuffix } = require('../src/lookup');

const CALL_RE = /^[A-Z0-9]{3,15}$/;

function createApp({ broker, solar, env = process.env }) {
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

  app.get('/lookup/status', (req, res) => res.json(broker.getStatus()));

  app.post('/lookup/pause', requireToken, (req, res) => { broker.pause(); res.json(broker.getStatus()); });
  app.post('/lookup/resume', requireToken, (req, res) => { broker.resume(); res.json(broker.getStatus()); });

  app.delete('/lookup/cache', requireToken, (req, res) => {
    if (req.headers['x-confirm'] !== 'yes') return res.status(400).json({ error: 'Missing X-Confirm: yes header' });
    return res.json({ cleared: clearCallsignCache() });
  });

  app.get('/lookup/:call', async (req, res) => {
    const call = stripSuffix(req.params.call);
    if (!CALL_RE.test(call)) return res.status(400).json({ error: 'invalid callsign' });
    try {
      res.json(await broker.get(call));
    } catch (err) {
      res.status(err.status || 502).json({ error: err.message, ...(err.code === 'paused' ? { code: 'paused' } : {}) });
    }
  });

  return app;
}

module.exports = { createApp };
