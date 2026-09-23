const { Router } = require('express');
const {
  getQsos, clearQsos, getQsoRate,
  getRadios,
  getLatestScore, getScoreHistory,
  getNotFoundCalls,
  getSolarInRange,
} = require('../db/queries');
const { getStatuses } = require('../state/bridgeStatus');
const { getVersionInfo } = require('../version');
const { resolveLookupConfig, stripSuffix } = require('../lookup');
const { getLookupService, getUdpListeners } = require('../udp');
const { resolveSolarConfig, latestSolar } = require('../solar');
const { freqToBand } = require('../parsers/util');
const { getDb } = require('../db');

const router = Router();

// GET /api/version -- when this instance was last deployed, so a viewer can
// tell whether they're looking at a cached/stale page (the timestamp only
// changes on a real deploy, never on its own).
router.get('/version', (req, res) => {
  res.json(getVersionInfo());
});

// GET /api/health -- liveness + diagnostics for an external monitor (the
// ops dashboard). `status` is strictly about whether contestscore itself
// is functioning -- DB reachable, the three UDP sockets actually bound --
// not about whether a contest happens to be producing data right now,
// which this server has no way to know and isn't this server's fault
// either way. The bridge/lookup/solar blocks are informational diagnostics
// alongside that, for a monitor that wants the fuller picture, not inputs
// to `status`.
router.get('/health', (req, res) => {
  const checks = { db: { ok: false }, udp_listeners: { radio: null, contact: null, score: null } };

  try {
    getDb().prepare('SELECT 1').get();
    checks.db.ok = true;
  } catch (err) {
    checks.db.ok = false;
    checks.db.error = err.message;
  }

  const listeners = getUdpListeners();
  if (listeners) {
    checks.udp_listeners = {
      radio: !!listeners.radio.bound,
      contact: !!listeners.contact.bound,
      score: !!listeners.score.bound,
    };
  }

  const listenersOk = !listeners
    || (checks.udp_listeners.radio && checks.udp_listeners.contact && checks.udp_listeners.score);
  const status = checks.db.ok && listenersOk ? 'ok' : 'degraded';

  const solar = latestSolar();
  // solar.updated is a datetime('now')-shaped UTC string with no zone
  // marker ("YYYY-MM-DD HH:MM:SS") -- new Date() on that would parse it as
  // *local* time in Node, same gotcha handled the same way throughout
  // compare.js/report.js (see e.g. qTime()).
  const solarStaleMs = solar && solar.updated
    ? Date.now() - new Date(solar.updated.replace(' ', 'T') + 'Z').getTime()
    : null;
  const lk = getLookupService();

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    checks,
    bridges: getStatuses(),
    lookup: lk ? lk.getStatus() : { provider: 'none', enabled: false, paused: false },
    solar: {
      updated: solar ? solar.updated : null,
      // resolveSolarConfig().refreshMinutes isn't exposed per-instance here;
      // 3x the documented 120-min default poll interval is a reasonable
      // "something's actually wrong, not just between polls" threshold.
      stale: solarStaleMs != null && solarStaleMs > 3 * 120 * 60000,
    },
  });
});

// GET /api/features -- runtime feature switches the dashboard needs to know
// about so it can show/hide optional panels (e.g. the busts panel only
// exists when callsign lookup is enabled). Read live from env each call.
router.get('/features', (req, res) => {
  const lk = resolveLookupConfig();
  res.json({
    lookup: { provider: lk.enabled ? lk.provider : 'none', enabled: lk.enabled },
    solar: { enabled: resolveSolarConfig().enabled },
  });
});

// GET /api/solar -- the most recent space-weather reading (SFI / A / K /
// sunspots) for the header. `{ updated: null }` until the first fetch lands.
router.get('/solar', (req, res) => {
  res.json(latestSolar());
});

// Same optional-bearer-token posture as DELETE /api/db: required whenever
// CONTESTSCORE_API_TOKEN is set, a no-op on a LAN-only install with no
// token configured. Unlike DB reset, this is fully reversible (resume()
// undoes it instantly), so no X-Confirm header is needed on top.
function checkToken(req, res) {
  const requiredToken = process.env.CONTESTSCORE_API_TOKEN;
  if (!requiredToken) return true;
  const auth = req.headers['authorization'] || '';
  if (auth === `Bearer ${requiredToken}`) return true;
  res.status(401).json({ error: 'Missing or invalid bearer token' });
  return false;
}

// GET /api/lookup/status -- live callsign-lookup state, including whether
// it's currently paused. Distinct from /api/features' lookup block (config-
// only, read even when the UDP listeners -- and so the lookup service
// itself -- were never started, e.g. under test): this reflects the actual
// running queue, or a quiet { enabled: false } if there isn't one.
router.get('/lookup/status', (req, res) => {
  const svc = getLookupService();
  res.json(svc ? svc.getStatus() : { provider: 'none', enabled: false, paused: false });
});

// POST /api/lookup/pause -- immediate kill switch for HamQTH lookups,
// reachable from the admin console mid-contest without a restart (e.g. a
// busy multi-op deciding the lookup traffic itself needs to stop). Drops
// whatever's already queued, not just future calls -- see lookup/index.js
// pause()'s own comment. A no-op (still 200) when there's no live service
// to pause, same as if it were already stopped.
router.post('/lookup/pause', (req, res) => {
  if (!checkToken(req, res)) return;
  const svc = getLookupService();
  if (svc) svc.pause();
  res.json(svc ? svc.getStatus() : { provider: 'none', enabled: false, paused: false });
});

// POST /api/lookup/resume -- undoes /api/lookup/pause.
router.post('/lookup/resume', (req, res) => {
  if (!checkToken(req, res)) return;
  const svc = getLookupService();
  if (svc) svc.resume();
  res.json(svc ? svc.getStatus() : { provider: 'none', enabled: false, paused: false });
});

// GET /api/solar/history?from=&to=  -- readings between two datetime('now')-
// shaped UTC strings ("YYYY-MM-DD HH:MM:SS"). Powers the analyzer compare
// page's "conditions during this session" chart for a from-live analysis
// only -- an uploaded log from an arbitrary past date has no captured solar
// (see docs/ANALYZER.md "Not done"). Public, same posture as reading a
// saved analysis: it's ambient station telemetry, not a write.
router.get('/solar/history', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to are required (UTC "YYYY-MM-DD HH:MM:SS")' });
  }
  res.json(getSolarInRange(from, to));
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

// GET /api/busts -- logged QSOs whose callsign HamQTH doesn't recognise
// (a likely miscopy). `{ enabled: false, busts: [] }` when lookup is off,
// so the dashboard can hide the panel entirely. Derived fresh from the
// current qsos + cache, so a call corrected in the logger simply stops
// matching on the next fetch. Matches on the suffix-stripped call, since
// that's what the lookup queue keys the cache by.
router.get('/busts', (req, res) => {
  if (!resolveLookupConfig().enabled) return res.json({ enabled: false, busts: [] });

  const notFound = new Set(getNotFoundCalls());
  const seen = new Set();
  const busts = [];
  if (notFound.size) {
    for (const q of getQsos()) {
      if (!notFound.has(stripSuffix(q.call))) continue;
      const key = `${q.call}|${q.band}|${q.mode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      busts.push({
        call: q.call, band: q.band, mode: q.mode,
        operator: q.operator || '', logged_at: q.logged_at,
      });
    }
  }
  res.json({ enabled: true, busts });
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
