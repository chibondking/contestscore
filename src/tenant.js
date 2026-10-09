// Tenant mode: this instance is one club's scoreboard on a shared VPS
// (ops repo CLAUDE.md Section 23), not a station's own install.
//
// CONTESTSCORE_TENANT=<call> switches it on; CONTESTSCORE_TENANT_NAME is an
// optional display name ("K9CT Contest Club") for operators' tooling
// (contestscore-tenant list, the ops dashboard) -- the public page header
// stays "ContestPulse"; the station call already shows in the score panel.
// Read from env on every call, same as /api/features.
//
// What tenant mode changes (and nothing else):
//  * server.js refuses to start without CONTESTSCORE_API_TOKEN (the club's
//    own token) or without HAMDATA_URL. The Admin page stays available --
//    each club resets its own contest data and switches its own lookups
//    on/off (CJ, 2026-10-09) -- and every admin action needs that token, so
//    a hosted instance can never run with its admin actions open.
//  * no UDP sockets (src/udp/index.js) -- data only arrives over
//    ContestPulse's authenticated HTTPS ingest.
//  * GET /api/features carries { tenant: { call, name } }.

const CALL_RE = /^[a-z0-9]{3,10}$/i;

function getTenant(env = process.env) {
  const raw = String(env.CONTESTSCORE_TENANT || '').trim();
  if (!raw) return null;
  if (!CALL_RE.test(raw)) throw new Error(`CONTESTSCORE_TENANT "${raw}" is not a callsign-like id (3-10 letters/digits)`);
  const call = raw.toUpperCase();
  const name = String(env.CONTESTSCORE_TENANT_NAME || '').trim() || call;
  return { call, name };
}

module.exports = { getTenant };
