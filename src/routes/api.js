const { Router } = require('express');
const {
  getQsos, clearQsos, getQsoRate,
  getRadios,
  getLatestScore, getScoreHistory,
} = require('../db/queries');
const { getStatuses } = require('../state/bridgeStatus');

const router = Router();

// GET /api/qsos  optional ?band=&mode=&operator=
router.get('/qsos', (req, res) => {
  const { band, mode, operator } = req.query;
  res.json(getQsos({ band, mode, operator }));
});

// GET /api/score
router.get('/score', (req, res) => {
  res.json(getLatestScore() || {});
});

// GET /api/score/history
router.get('/score/history', (req, res) => {
  res.json(getScoreHistory());
});

// GET /api/radios
router.get('/radios', (req, res) => {
  res.json(getRadios());
});

// GET /api/rate -- N1MM-style rate meter: QSO count and extrapolated
// QSOs/hour for each of the last 10/30/60 minutes. Pure function of
// wall-clock time, so the dashboard should poll this rather than only
// refreshing it on contact:new (a lull should visibly decay the rate).
router.get('/rate', (req, res) => {
  res.json(getQsoRate());
});

// GET /api/bridges -- realtime/stale/offline status of every ContestPulse
// (or other bridge) instance that has sent a heartbeat, for the dashboard's
// initial load. Live updates after that arrive via the bridge:status
// socket event.
router.get('/bridges', (req, res) => {
  res.json(getStatuses());
});

// DELETE /api/db  requires X-Confirm: yes, plus a bearer token whenever
// CONTESTSCORE_API_TOKEN is set. On a LAN-only install with no token
// configured this behaves exactly as before; on a publicly reachable
// deployment, set the token (and see deploy/ for restricting this route to
// trusted source IPs at the reverse-proxy layer too).
router.delete('/db', (req, res) => {
  const requiredToken = process.env.CONTESTSCORE_API_TOKEN;
  if (requiredToken) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${requiredToken}`) {
      return res.status(401).json({ error: 'Missing or invalid bearer token' });
    }
  }
  if (req.headers['x-confirm'] !== 'yes') {
    return res.status(400).json({ error: 'Missing X-Confirm: yes header' });
  }
  clearQsos();
  const io = req.app.get('io');
  if (io) io.emit('db:cleared');
  res.json({ cleared: true });
});

module.exports = router;
