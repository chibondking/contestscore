const { Router } = require('express');
const { emitter } = require('../udp');
const { handleAnyBuffer } = require('../udp/dispatch');
const { recordHeartbeat } = require('../state/bridgeStatus');

const router = Router();

// Raw N1MM XML bytes, exactly as broadcast over UDP -- same payload shape
// the dgram listeners receive, just carried over HTTPS instead of LAN UDP.
// No Content-Type assumption: the bridge just forwards whatever N1MM sent.
const rawBody = require('express').raw({ type: () => true, limit: '64kb' });

// Unlike DELETE /api/db (which stays usable with no token configured, for a
// pure LAN install with no reverse proxy), ingest has no LAN-only fallback
// story -- it exists specifically for a bridge relaying bytes in from off
// the LAN, so an unconfigured token means "not set up", not "trust anyone":
// fail closed rather than silently accepting unauthenticated writes.
function requireToken(req, res, next) {
  const token = process.env.CONTESTSCORE_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Ingest disabled: CONTESTSCORE_API_TOKEN is not set' });
  }
  if (req.headers['authorization'] !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Missing or invalid bearer token' });
  }
  next();
}

router.use(requireToken);

// POST /api/ingest/{radio,contact,score}  body: raw N1MM XML bytes. All
// three routes dispatch by the packet's own root element (see
// udp/dispatch.js), not by which of the three it was POSTed to -- a live
// capture showed a Score broadcast landing on ContestPulse's local "radio"
// port, and it forwards whatever it receives on a port to that port's own
// ingest route, so trusting the route name here would repeat the exact same
// mistake server-side. Any of the three routes can correctly handle any
// known packet type.
router.post('/radio', rawBody, (req, res) => {
  handleAnyBuffer(req.body, emitter, `bridge:${req.ip}`);
  res.status(202).end();
});

router.post('/contact', rawBody, (req, res) => {
  handleAnyBuffer(req.body, emitter, `bridge:${req.ip}`);
  res.status(202).end();
});

router.post('/score', rawBody, (req, res) => {
  handleAnyBuffer(req.body, emitter, `bridge:${req.ip}`);
  res.status(202).end();
});

// POST /api/ingest/heartbeat   body: { "station_id": "..." } (JSON --
// app.js's global express.json() already parses this; the routes above
// deliberately avoid that Content-Type so their raw XML bytes pass through
// untouched instead).
router.post('/heartbeat', (req, res) => {
  const stationId = req.body && req.body.station_id;
  if (!stationId) {
    return res.status(400).json({ error: 'Missing station_id' });
  }
  const report = recordHeartbeat(stationId);
  const io = req.app.get('io');
  if (io) io.emit('bridge:status', report);
  res.status(202).json(report);
});

module.exports = router;
