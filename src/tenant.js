// Tenant mode: this instance is one club's scoreboard on a shared VPS
// (ops repo CLAUDE.md Section 23), not a station's own install.
//
// CONTESTSCORE_TENANT=<call> switches it on; CONTESTSCORE_TENANT_NAME is an
// optional display name ("K9CT Contest Club") for operators' tooling
// (contestscore-tenant list, the ops dashboard) -- the public page header
// stays "ContestPulse"; the station call already shows in the score panel. Read from env on every call,
// same as /api/features, so tests can flip it per request.
//
// What changes in tenant mode (and nothing else):
//  * BLOCKED routes 404 -- the admin page and the two admin actions behind
//    it. Tenant dashboards are public; wiping the contest DB or pausing a
//    lookup service the whole box shares has no place there.
//  * GET /api/features carries { tenant: { call, name } } so the shared
//    page chrome can drop the Admin link.
//  * server.js refuses to start without HAMDATA_URL (a tenant never talks
//    to hamqsl/HamQTH itself).
// The analyzer stays on: uploads are gated by this tenant's own
// CONTESTSCORE_API_TOKEN, like ingest.

const CALL_RE = /^[a-z0-9]{3,10}$/i;

const BLOCKED = [
  ['GET', '/admin.html'],
  ['GET', '/admin'],
  ['GET', '/js/admin.js'],
  ['DELETE', '/api/db'],
  ['POST', '/api/lookup/pause'],
  ['POST', '/api/lookup/resume'],
];

function getTenant(env = process.env) {
  const raw = String(env.CONTESTSCORE_TENANT || '').trim();
  if (!raw) return null;
  if (!CALL_RE.test(raw)) throw new Error(`CONTESTSCORE_TENANT "${raw}" is not a callsign-like id (3-10 letters/digits)`);
  const call = raw.toUpperCase();
  const name = String(env.CONTESTSCORE_TENANT_NAME || '').trim() || call;
  return { call, name };
}

function isBlocked(method, path) {
  const m = method === 'HEAD' ? 'GET' : method;
  return BLOCKED.some(([bm, bp]) => bm === m && bp === path);
}

// Express middleware, mounted before express.static and the routers.
function tenantGuard(req, res, next) {
  let tenant = null;
  try { tenant = getTenant(); } catch { tenant = null; }
  if (tenant && isBlocked(req.method, req.path)) {
    return res.status(404).json({ error: 'Not available on a hosted scoreboard' });
  }
  return next();
}

module.exports = { getTenant, tenantGuard, isBlocked, BLOCKED };
