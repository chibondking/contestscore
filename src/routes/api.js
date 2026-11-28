const { Router } = require('express');
const {
  getQsos, clearQsos, getQsoRate,
  getRadios,
  getLatestScore, getScoreHistory,
  getNotFoundCalls, clearCallsignCache, countCallsignCache,
  getSolarForSession,
  getCachedLocation,
  getSetting, setSetting,
} = require('../db/queries');
const { getStatuses } = require('../state/bridgeStatus');
const { getVersionInfo } = require('../version');
const { resolveLookupConfig, stripSuffix } = require('../lookup');
const { getLookupService, getUdpListeners, getCosbService } = require('../udp');
const { resolveCosbConfig } = require('../cosb');
const { resolveSolarConfig, latestSolar } = require('../solar');
const { freqToBand, publicQso } = require('../parsers/util');
const { getDb } = require('../db');
const { resolveLatLonEnriched, ctyInfo } = require('../analyze/geo');
const { getTenant } = require('../tenant');
const { createHamdataClient } = require('../hamdata/client');

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
    cosb: { enabled: resolveCosbConfig().enabled },
    tenant: (() => { try { return getTenant(); } catch { return null; } })(),
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
// With a shared hamdata, also reports whether the box operator has stopped
// outgoing HamQTH lookups for everyone (`upstream_paused`) -- cached
// callsigns still resolve then, new ones don't.
// `cache` counts this scoreboard's own callsign_cache; `upstream_cache` the
// shared hamdata one (null when unreachable or an older hamdata).
router.get('/lookup/status', async (req, res) => {
  const svc = getLookupService();
  const status = svc ? svc.getStatus() : { provider: 'none', enabled: false, paused: false };
  status.cache = countCallsignCache();
  const lk = resolveLookupConfig();
  if (lk.provider === 'hamdata') {
    try {
      const up = await createHamdataClient({ url: lk.url, timeoutMs: 2000 }).lookupStatus();
      status.upstream_paused = Boolean(up.paused);
      // false = hamdata has no HamQTH account, so nothing new can be looked up
      status.upstream_enabled = up.enabled !== false;
      status.upstream_cache = up.cache || null;
    } catch {
      status.upstream_paused = null; // hamdata unreachable -- unknown
      status.upstream_enabled = null;
      status.upstream_cache = null;
    }
  }
  res.json(status);
});

// GET /api/cty -- which country file (cty.csv, country-files.com) this
// server resolves continent / DXCC / zone with: its release version, as
// stamped in the file, and how many entities it has. Public, like
// /api/version.
router.get('/cty', (req, res) => {
  res.json(ctyInfo());
});

// DELETE /api/lookup/cache -- forget every cached callsign lookup (busts
// panel included) so they're looked up afresh. Same token + X-Confirm
// posture as DELETE /api/db. Touches callsign_cache only -- never QSOs,
// never solar data.
router.delete('/lookup/cache', (req, res) => {
  if (!checkToken(req, res)) return;
  if (req.headers['x-confirm'] !== 'yes') {
    return res.status(400).json({ error: 'Missing X-Confirm: yes header' });
  }
  res.json({ cleared: clearCallsignCache() });
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
// shaped UTC strings ("YYYY-MM-DD HH:MM:SS"), led by the reading already in
// effect at `from` (see getSolarForSession). Powers the analyzer compare
// page's "conditions during this session" chart, for a from-live analysis
// saved before snapshots carried their own solar readings. Live-sourced
// only -- an uploaded log from an arbitrary past date has no captured solar
// (see docs/ANALYZER.md "Not done"). Public, same posture as reading a
// saved analysis: it's ambient station telemetry, not a write.
router.get('/solar/history', (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: 'from and to are required (UTC "YYYY-MM-DD HH:MM:SS")' });
  }
  res.json(getSolarForSession(from, to));
});

// GET /api/qsos  optional ?band=&mode=&operator=
// Each row also carries the world map's `lat`/`lon` (grid square if the
// exchange had one; else a HamQTH/lookup-service grid on file for the call;
// else the country file's entity center) -- computed here, not stored on
// the qsos table; see src/analyze/geo.js's resolveLatLonEnriched header
// comment.
router.get('/qsos', (req, res) => {
  const { band, mode, operator } = req.query;
  res.json(getQsos({ band, mode, operator }).map(withLatLon));
});

// A missing/disabled lookup provider, or a call it hasn't resolved yet,
// just means getCachedLocation() returns null -- resolveLatLonEnriched()
// already treats that the same as "no enrichment available" and falls back
// to the old country-file/call-area estimate on its own; nothing here needs
// to know which of those cases it is.
function withLatLon(qso) {
  const cached = qso.call ? getCachedLocation(stripSuffix(qso.call)) : null;
  // publicQso: never the exact rx_freq/tx_freq -- see src/parsers/util.js.
  return { ...publicQso(qso), ...(resolveLatLonEnriched(qso, cached) || {}) };
}

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

// GET /api/score/history            every total-score broadcast, oldest first
// GET /api/score/history?changes=1  only the ones where the score moved --
// what a chart needs (see getScoreHistory's changesOnly).
router.get('/score/history', (req, res) => {
  res.json(getScoreHistory({ changesOnly: req.query.changes === '1' }));
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
//
// `hidden: true` (and an empty list) when the club has switched the panel
// off on the Admin page (settings.busts_hidden). Withheld here, not just
// hidden in the page, so the list can't be read off the API either -- the
// point is a club entering a contest where correcting calls from a database
// counts as log washing (CQ WW, Section IX.9) can make sure nobody uses
// this list to fix the log after the contest. Lookups keep running (the map
// uses their grids); only the bust list is withheld.
const BUSTS_HIDDEN_KEY = 'busts_hidden';
const bustsHidden = () => getSetting(BUSTS_HIDDEN_KEY) === '1';

router.get('/busts', (req, res) => {
  if (!resolveLookupConfig().enabled) return res.json({ enabled: false, hidden: bustsHidden(), busts: [] });
  if (bustsHidden()) return res.json({ enabled: true, hidden: true, busts: [] });

  const notFound = new Set(getNotFoundCalls());
  const seen = new Set();
  const busts = [];
  if (notFound.size) {
    for (const q of getQsos()) {
      // An X-QSO the operator already struck out isn't a bust to chase.
      if (q.is_claimed_qso != null && Number(q.is_claimed_qso) === 0) continue;
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
  res.json({ enabled: true, hidden: false, busts });
});

// POST /api/busts/hide | /api/busts/show -- the Admin page's Possible Busts
// switch. Same optional-token posture as pausing lookups (reversible, so no
// X-Confirm). Persisted in settings, so it survives a restart and a
// DELETE /api/db -- it's the club's choice, not contest data.
function setBustsHidden(hidden) {
  return (req, res) => {
    if (!checkToken(req, res)) return;
    setSetting(BUSTS_HIDDEN_KEY, hidden ? '1' : '0');
    res.json({ hidden });
  };
}
router.post('/busts/hide', setBustsHidden(true));
router.post('/busts/show', setBustsHidden(false));

// GET /api/cosb -- this station's contestonlinescore.com standings (see
// src/cosb/) plus the publishing status. Never includes the COSB password.
router.get('/cosb', (req, res) => {
  const svc = getCosbService();
  if (!svc) return res.json({ standings: { status: 'disabled' }, standings_switch: null, publish: null });
  res.json({ standings: svc.getView(), standings_switch: svc.getStandingsStatus(), publish: svc.getPublishStatus() });
});

// POST /api/cosb/standings { enabled } -- the Admin page's per-board switch
// for the COSB Standings card (off by default). Token as the other switches.
router.post('/cosb/standings', async (req, res) => {
  if (!checkToken(req, res)) return;
  const svc = getCosbService();
  if (!svc) return res.status(503).json({ error: 'COSB service not running' });
  if (!svc.getStandingsStatus().available) {
    return res.status(409).json({ error: 'COSB is turned off for this server (COSB_ENABLED=false)' });
  }
  await svc.setStandings(Boolean((req.body || {}).enabled)).catch(() => {});
  res.json({ ...svc.getStandingsStatus(), standings: svc.getView() });
});

// POST /api/cosb/publish { enabled, user, password? } -- the Admin page's
// "Publish to COSB" switch and login. Same optional-token posture as the
// other Admin switches. An empty password keeps the stored one. Refused
// when COSB_USER/COSB_PASSWORD are set in the environment (they win).
router.post('/cosb/publish', (req, res) => {
  if (!checkToken(req, res)) return;
  const svc = getCosbService();
  if (!svc) return res.status(503).json({ error: 'COSB service not running' });
  if (svc.getPublishStatus().from_env) {
    return res.status(409).json({ error: 'Set by COSB_USER/COSB_PASSWORD in the environment' });
  }
  const b = req.body || {};
  const user = b.user == null ? undefined : String(b.user).trim();
  if (user !== undefined && user !== '' && !/^[A-Z0-9/]{3,15}$/i.test(user)) {
    return res.status(400).json({ error: 'COSB login should be a callsign' });
  }
  if (b.password != null && String(b.password).length > 200) {
    return res.status(400).json({ error: 'Password too long' });
  }
  const enabled = b.enabled == null ? undefined : Boolean(b.enabled);
  const cur = svc.getPublishStatus();
  if (enabled && !(user || cur.user)) return res.status(400).json({ error: 'Set the COSB login first' });
  if (enabled && !(b.password || cur.has_password)) return res.status(400).json({ error: 'Set the COSB password first' });
  res.json(svc.setPublish({ enabled, user, password: b.password ? String(b.password) : '' }));
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
