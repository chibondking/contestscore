// Tracks liveness of ContestPulse (or any future bridge) instances via
// their heartbeat pings, and derives a realtime/stale/offline status per
// station_id for the dashboard. In-memory only -- this is operational
// state, not contest data, so losing it on a server restart is fine; the
// next heartbeat (at most a few seconds later) re-establishes it.
//
// Two ways a status is produced:
//  - On heartbeat arrival (routes/ingest.js calls recordHeartbeat): always
//    "realtime" at that instant, by definition.
//  - On the periodic sweep (checkForChanges, driven by startMonitor's
//    timer): catches a station going quiet, which by its nature can't be
//    detected by any incoming event -- silence is the condition itself.
//
// Thresholds default to 1.5x / 3x ContestPulse's own default 10s heartbeat
// interval. Override via env vars if a deployment configures a different
// interval on the bridge side.

const STALE_AFTER_MS = Number(process.env.BRIDGE_STALE_AFTER_MS) || 15000;
const OFFLINE_AFTER_MS = Number(process.env.BRIDGE_OFFLINE_AFTER_MS) || 30000;

// station_id -> { lastSeenAt: <ms epoch>, lastStatus: 'realtime'|'stale'|'offline' }
const stations = new Map();

function statusForAge(ageMs) {
  if (ageMs <= STALE_AFTER_MS) return 'realtime';
  if (ageMs <= OFFLINE_AFTER_MS) return 'stale';
  return 'offline';
}

function toReport(stationId, s) {
  return {
    station_id: stationId,
    last_seen_at: new Date(s.lastSeenAt).toISOString(),
    status: s.lastStatus,
  };
}

// Records a heartbeat and returns its report (always 'realtime' -- a
// heartbeat that just arrived is age zero by definition).
function recordHeartbeat(stationId) {
  const now = Date.now();
  const s = { lastSeenAt: now, lastStatus: 'realtime' };
  stations.set(stationId, s);
  return toReport(stationId, s);
}

// Current status of every known station, recomputed fresh from elapsed
// time (not just the cached lastStatus) -- used for the initial dashboard
// load via GET /api/bridges, where "fresh as of right now" matters more
// than "fresh as of the last heartbeat or sweep".
function getStatuses() {
  const now = Date.now();
  return [...stations.entries()].map(([stationId, s]) =>
    toReport(stationId, { ...s, lastStatus: statusForAge(now - s.lastSeenAt) })
  );
}

// Re-evaluates every known station's status and updates the cached
// lastStatus in place, returning only the ones that changed. Meant to be
// called on a timer (see startMonitor) so a transition into "stale" or
// "offline" is caught even though nothing new arrived to trigger it.
function checkForChanges() {
  const now = Date.now();
  const changed = [];
  for (const [stationId, s] of stations) {
    const status = statusForAge(now - s.lastSeenAt);
    if (status !== s.lastStatus) {
      s.lastStatus = status;
      changed.push(toReport(stationId, s));
    }
  }
  return changed;
}

let monitorHandle = null;

function startMonitor(io, intervalMs = 5000) {
  stopMonitor();
  monitorHandle = setInterval(() => {
    for (const report of checkForChanges()) io.emit('bridge:status', report);
  }, intervalMs);
  // Don't hold the process open just for this timer (e.g. during tests).
  if (typeof monitorHandle.unref === 'function') monitorHandle.unref();
  return monitorHandle;
}

function stopMonitor() {
  if (monitorHandle) {
    clearInterval(monitorHandle);
    monitorHandle = null;
  }
}

// Test-only: clear all tracked stations between test cases.
function resetForTests() {
  stations.clear();
}

// Test-only: back-date a station's last-seen time, as if its heartbeat
// (which always records as "realtime" -- see recordHeartbeat) arrived msAgo
// milliseconds ago and nothing has re-evaluated it since. This is what lets
// a test exercise checkForChanges()'s actual job -- noticing that enough
// time has now passed to change the status -- without sleeping through
// STALE_AFTER_MS/OFFLINE_AFTER_MS in real time. Same idea as the Go agent's
// tests forcing LastUpdate backwards directly on the struct.
function _setLastSeenForTests(stationId, msAgo) {
  stations.set(stationId, { lastSeenAt: Date.now() - msAgo, lastStatus: 'realtime' });
}

module.exports = {
  recordHeartbeat,
  getStatuses,
  checkForChanges,
  startMonitor,
  stopMonitor,
  resetForTests,
  _setLastSeenForTests,
  STALE_AFTER_MS,
  OFFLINE_AFTER_MS,
};
