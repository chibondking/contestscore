const { Router } = require('express');
const {
  getQsos, clearQsos, getQsoRate,
  getRadios,
  getLatestScore, getScoreHistory,
} = require('../db/queries');
const { getStatuses } = require('../state/bridgeStatus');
const { getVersionInfo } = require('../version');
const { freqToBand } = require('../parsers/util');

const router = Router();

// GET /api/version -- when this instance was last deployed, so a viewer can
// tell whether they're looking at a cached/stale page (the timestamp only
// changes on a real deploy, never on its own).
router.get('/version', (req, res) => {
  res.json(getVersionInfo());
});

// GET /api/qsos  optional ?band=&mode=&operator=
router.get('/qsos', (req, res) => {
  const { band, mode, operator } = req.query;
  res.json(getQsos({ band, mode, operator }));
});

// GET /api/score
// Reshapes the raw score_snapshots row to match the socket `score:update`
// payload's field names (src/udp/index.js) -- notably `total` for the raw
// row's `score_total` column. The frontend (dashboard.js, admin.js) reads
// `.total`, since that's what arrives live over the socket; without this
// alias, the REST-only initial page load (before any live update lands)
// shows the score total as blank/zero even though the DB has real data.
router.get('/score', (req, res) => {
  const score = getLatestScore();
  if (!score) return res.json({});
  res.json({ ...score, total: score.score_total });
});

// GET /api/score/history
router.get('/score/history', (req, res) => {
  res.json(getScoreHistory());
});

// GET /api/radios
// Never returns the exact freq/tx_freq columns -- see freqToBand()'s own
// comment (src/parsers/util.js) and the matching scrub on the radio:update
// socket payload (src/udp/index.js). The exact value stays in radio_state
// (still useful server-side); it just never leaves the server toward a
// browser, whether that's this REST endpoint or the live socket feed.
router.get('/radios', (req, res) => {
  res.json(getRadios().map(({ freq, tx_freq, ...rest }) => ({ ...rest, band: freqToBand(freq) })));
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
