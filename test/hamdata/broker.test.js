const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createLookupBroker } = require('../../hamdata/broker');
const { FOUND_TTL_MS, NOT_FOUND_TTL_MS } = require('../../src/lookup/ttl');

// In-memory stand-in for callsign_cache: same row shape as getCachedCallsign.
function memCache(clock) {
  const rows = new Map();
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  return {
    rows,
    getCached: (call) => rows.get(call),
    cache: (call, data, source) => rows.set(call, { call, data: JSON.stringify(data), source, cached_at: iso(clock.t) }),
  };
}

function setup({ lookup } = {}) {
  const clock = { t: Date.parse('2026-10-08T12:00:00Z') };
  const calls = [];
  const client = lookup === null ? null : {
    lookup: lookup || (async (c) => { calls.push(c); return { call: c, found: true, grid: 'EN61' }; }),
  };
  const mem = memCache(clock);
  const broker = createLookupBroker({
    client, getCached: mem.getCached, cache: mem.cache, now: () => clock.t, sleep: async () => {}, betweenMs: 0,
  });
  return { broker, clock, calls, mem };
}

describe('hamdata lookup broker', () => {
  it('fetches once, then serves from the shared cache', async () => {
    const { broker, calls } = setup();
    const a = await broker.get('K9CT');
    const b = await broker.get('K9CT');
    assert.deepEqual(calls, ['K9CT']);
    assert.equal(a.source, 'hamqth');
    assert.equal(b.grid, 'EN61');
    assert.equal(broker.getStatus().hits, 1);
  });

  it('collapses concurrent requests for the same call into one upstream lookup', async () => {
    const { broker, calls } = setup();
    await Promise.all([broker.get('NW8S'), broker.get('NW8S'), broker.get('NW8S')]);
    assert.deepEqual(calls, ['NW8S']);
  });

  it('refetches a found record after its TTL, a not-found one sooner', async () => {
    let found = true;
    const seen = [];
    const { broker, clock } = setup({ lookup: async (c) => { seen.push(c); return { call: c, found }; } });
    await broker.get('W1AW');
    clock.t += FOUND_TTL_MS - 1000;
    await broker.get('W1AW');
    assert.equal(seen.length, 1);
    clock.t += 2000;
    found = false;
    await broker.get('W1AW');
    assert.equal(seen.length, 2);
    clock.t += NOT_FOUND_TTL_MS + 1000;
    await broker.get('W1AW');
    assert.equal(seen.length, 3);
  });

  it('ignores cache rows from other sources (e.g. n1mm)', async () => {
    const { broker, calls, mem } = setup();
    mem.cache('K1ABC', { call: 'K1ABC', found: true }, 'n1mm');
    await broker.get('K1ABC');
    assert.deepEqual(calls, ['K1ABC']);
  });

  it('the global stop is persisted, and a stopped broker says why (code: paused)', async () => {
    const settings = {};
    const mk = () => createLookupBroker({
      client: { lookup: async (c) => ({ call: c, found: true }) },
      getCached: () => undefined, cache: () => {}, betweenMs: 0, sleep: async () => {},
      getSetting: (k) => settings[k] ?? null, setSetting: (k, v) => { settings[k] = v; },
    });
    mk().pause();
    const restarted = mk();
    assert.equal(restarted.getStatus().paused, true);
    await assert.rejects(restarted.get('K9CT'), (e) => e.status === 503 && e.code === 'paused');
    restarted.resume();
    assert.equal(mk().getStatus().paused, false);
  });

  it('503s while paused or with no credentials, but still serves cache hits', async () => {
    const { broker } = setup();
    await broker.get('K9CT');
    broker.pause();
    assert.equal((await broker.get('K9CT')).call, 'K9CT');
    await assert.rejects(broker.get('NW8S'), (e) => e.status === 503);
    broker.resume();
    await broker.get('NW8S');

    const off = setup({ lookup: null }).broker;
    await assert.rejects(off.get('K9CT'), (e) => e.status === 503 && e.code === 'disabled');
    assert.equal(off.getStatus().enabled, false);
  });

  it('an upstream failure is a 502 and is not cached', async () => {
    let fail = true;
    const { broker, mem } = setup({ lookup: async (c) => { if (fail) throw new Error('HamQTH down'); return { call: c, found: true }; } });
    await assert.rejects(broker.get('K9CT'), (e) => e.status === 502);
    assert.equal(mem.rows.size, 0);
    fail = false;
    assert.equal((await broker.get('K9CT')).found, true);
  });
});
