const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const bridgeStatus = require('../../src/state/bridgeStatus');

beforeEach(() => bridgeStatus.resetForTests());

describe('recordHeartbeat', () => {
  it('a fresh heartbeat is always realtime', () => {
    const report = bridgeStatus.recordHeartbeat('shack1');
    assert.equal(report.station_id, 'shack1');
    assert.equal(report.status, 'realtime');
    assert.ok(report.last_seen_at);
  });

  it('getStatuses reflects every station that has ever reported', () => {
    bridgeStatus.recordHeartbeat('shack1');
    bridgeStatus.recordHeartbeat('shack2');
    const ids = bridgeStatus.getStatuses().map((s) => s.station_id).sort();
    assert.deepEqual(ids, ['shack1', 'shack2']);
  });
});

describe('getStatuses -- freshly recomputed from elapsed time', () => {
  it('realtime within STALE_AFTER_MS', () => {
    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.STALE_AFTER_MS - 1000);
    const s = bridgeStatus.getStatuses().find((r) => r.station_id === 'shack1');
    assert.equal(s.status, 'realtime');
  });

  it('stale between STALE_AFTER_MS and OFFLINE_AFTER_MS', () => {
    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.STALE_AFTER_MS + 1000);
    const s = bridgeStatus.getStatuses().find((r) => r.station_id === 'shack1');
    assert.equal(s.status, 'stale');
  });

  it('offline beyond OFFLINE_AFTER_MS', () => {
    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.OFFLINE_AFTER_MS + 1000);
    const s = bridgeStatus.getStatuses().find((r) => r.station_id === 'shack1');
    assert.equal(s.status, 'offline');
  });
});

describe('checkForChanges', () => {
  it('reports nothing when no station has crossed a threshold', () => {
    bridgeStatus.recordHeartbeat('shack1'); // just now -- still realtime
    assert.deepEqual(bridgeStatus.checkForChanges(), []);
  });

  it('detects a realtime -> stale transition caused purely by elapsed time', () => {
    // Simulates: heartbeat landed and was recorded realtime, then enough
    // time passed with no further heartbeat for it to now read as stale --
    // exactly the case that can't be caught by any incoming event.
    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.STALE_AFTER_MS + 1000);
    const changed = bridgeStatus.checkForChanges();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].station_id, 'shack1');
    assert.equal(changed[0].status, 'stale');
  });

  it('detects a stale -> offline transition', () => {
    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.STALE_AFTER_MS + 1000);
    bridgeStatus.checkForChanges(); // first call: realtime -> stale, updates cached status

    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.OFFLINE_AFTER_MS + 1000);
    const changed = bridgeStatus.checkForChanges();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].status, 'offline');
  });

  it('does not re-report a station whose status has not changed since the last check', () => {
    bridgeStatus._setLastSeenForTests('shack1', bridgeStatus.STALE_AFTER_MS + 1000);
    const first = bridgeStatus.checkForChanges();
    assert.equal(first.length, 1);

    const second = bridgeStatus.checkForChanges(); // nothing new happened
    assert.deepEqual(second, []);
  });

  it('only reports the station(s) that actually changed', () => {
    bridgeStatus.recordHeartbeat('fresh'); // stays realtime
    bridgeStatus._setLastSeenForTests('gone-quiet', bridgeStatus.STALE_AFTER_MS + 1000);

    const changed = bridgeStatus.checkForChanges();
    assert.equal(changed.length, 1);
    assert.equal(changed[0].station_id, 'gone-quiet');
  });
});
