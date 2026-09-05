const { Router } = require('express');
const { emitter } = require('../udp');
const { handleRadioBuffer } = require('../udp/radioListener');
const { handleContactBuffer } = require('../udp/contactListener');
const { handleScoreBuffer } = require('../udp/scoreListener');
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

// POST /api/ingest/radio    body: raw RadioInfo XML bytes
router.post('/radio', rawBody, (req, res) => {
  handleRadioBuffer(req.body, emitter, `bridge:${req.ip}`);
  res.status(202).end();
});

// POST /api/ingest/contact  body: raw contactinfo/contactreplace/
//                                 contactdelete/lookupinfo XML bytes
router.post('/contact', rawBody, (req, res) => {
  handleContactBuffer(req.body, emitter, `bridge:${req.ip}`);
  res.status(202).end();
});

// POST /api/ingest/score    body: raw dynamicresults (Score) XML bytes
router.post('/score', rawBody, (req, res) => {
  handleScoreBuffer(req.body, emitter, `bridge:${req.ip}`);
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
