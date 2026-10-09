const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { createLookupService, resolveLookupConfig, stripSuffix } = require('../../src/lookup');

describe('stripSuffix', () => {
  const cases = [
    ['w1aw', 'W1AW'],
    ['W1AW/4', 'W1AW'],
    ['OK2CQR/P', 'OK2CQR'],
    ['K1ABC/QRP', 'K1ABC'],
    ['DL1ABC/MM', 'DL1ABC'],
    ['VP2E/W1ABC', 'W1ABC'],   // portable-in-entity: keep the full call
    ['HB9/DL1ABC', 'DL1ABC'],
    ['W1AW', 'W1AW'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    it(`${input || '(empty)'} -> ${want || '(empty)'}`, () => {
      assert.equal(stripSuffix(input), want);
    });
  }
});

describe('resolveLookupConfig', () => {
  const baseConfig = { lookup: { provider: 'none', prg: 'contestscore', hamqth: { username: '', password: '' } } };

  it('is disabled by default', () => {
    assert.deepEqual(resolveLookupConfig({}, baseConfig), { provider: 'none', enabled: false, prg: 'contestscore' });
  });

  it('an unknown provider resolves to none', () => {
    assert.equal(resolveLookupConfig({ LOOKUP_PROVIDER: 'qrz' }, baseConfig).provider, 'none');
  });

  it('hamqth without credentials is selected but not enabled', () => {
    const r = resolveLookupConfig({ LOOKUP_PROVIDER: 'hamqth' }, baseConfig);
    assert.equal(r.provider, 'hamqth');
    assert.equal(r.enabled, false);
  });

  it('env credentials enable hamqth and win over config', () => {
    const r = resolveLookupConfig(
      { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'W1AW', HAMQTH_PASSWORD: 'x' },
      baseConfig,
    );
    assert.deepEqual(r, { provider: 'hamqth', enabled: true, prg: 'contestscore', username: 'W1AW', password: 'x' });
  });

  it('reads credentials from config when env is unset', () => {
    const cfg = { lookup: { provider: 'hamqth', hamqth: { username: 'CFG', password: 'CFGPW' } } };
    assert.equal(resolveLookupConfig({}, cfg).enabled, true);
  });
});

// A fake HamQTH client that records the calls it gets and answers from a map.
function fakeClient(answers = {}) {
  const seen = [];
  return {
    seen,
    lookup: async (call) => {
      seen.push(call);
      const a = answers[call];
      if (a instanceof Error) throw a;
      return a || { call, found: false };
    },
  };
}

// A callsign_cache row cached just now (src/lookup/ttl.js decides freshness).
const sqlNow = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const freshRow = (call, found = true, ms) => ({ call, data: JSON.stringify({ call, found }), source: 'hamqth', cached_at: sqlNow(ms) });

const NOOP_DEPS = { sleep: () => Promise.resolve(), betweenMs: 0, getCachedCallsign: () => undefined, getQsos: () => [] };

describe('createLookupService', () => {
  it('is inert when no provider is configured', async () => {
    const emitter = new EventEmitter();
    const hits = [];
    emitter.on('lookup:result', (d) => hits.push(d));
    const svc = createLookupService({ emitter, env: {}, config: { lookup: { provider: 'none' } }, deps: NOOP_DEPS });

    svc.enqueue('W1AW');
    await svc.idle();
    assert.equal(hits.length, 0);
    assert.deepEqual(svc.getStatus(), { provider: 'none', enabled: false, paused: false });
  });

  it('looks up a new call and emits lookup:result with source + found', async () => {
    const emitter = new EventEmitter();
    const hits = [];
    emitter.on('lookup:result', (d) => hits.push(d));
    const client = fakeClient({ W1AW: { call: 'W1AW', found: true, name: 'ARRL HQ', cqzone: '5' } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client },
    });

    svc.enqueue('W1AW/4');           // suffix stripped before the lookup
    await svc.idle();
    assert.deepEqual(client.seen, ['W1AW']);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].call, 'W1AW');
    assert.equal(hits[0].source, 'hamqth');
    assert.equal(hits[0].found, true);
    assert.equal(hits[0].name, 'ARRL HQ');
  });

  it('emits found:false for a call HamQTH does not know', async () => {
    const emitter = new EventEmitter();
    const hits = [];
    emitter.on('lookup:result', (d) => hits.push(d));
    const client = fakeClient({ WT2ZZZ: { call: 'WT2ZZZ', found: false } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client },
    });

    svc.enqueue('WT2ZZZ');
    await svc.idle();
    assert.equal(hits[0].found, false);
    assert.equal(hits[0].source, 'hamqth');
  });

  it('de-dupes queued + in-flight + already-cached calls', async () => {
    const emitter = new EventEmitter();
    const client = fakeClient({ W1AW: { call: 'W1AW', found: true }, K3LR: { call: 'K3LR', found: true } });
    const cached = new Set(['K3LR']);
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client, getCachedCallsign: (c) => (cached.has(c) ? freshRow(c) : undefined) },
    });

    svc.enqueue('W1AW');
    svc.enqueue('W1AW/1'); // same base call, still queued
    svc.enqueue('K3LR');   // already cached
    await svc.idle();
    assert.deepEqual(client.seen, ['W1AW']);
  });

  it('processes the queue serially and in order', async () => {
    const emitter = new EventEmitter();
    const client = fakeClient({ AA1A: { found: true }, BB2B: { found: true }, CC3C: { found: true } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client },
    });

    svc.enqueue('AA1A'); svc.enqueue('BB2B'); svc.enqueue('CC3C');
    await svc.idle();
    assert.deepEqual(client.seen, ['AA1A', 'BB2B', 'CC3C']);
  });

  it('survives a client error and keeps serving later calls', async () => {
    const emitter = new EventEmitter();
    const hits = [];
    emitter.on('lookup:result', (d) => hits.push(d.call));
    const client = fakeClient({ BAD: new Error('boom'), GOOD: { call: 'GOOD', found: true } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client },
    });

    svc.enqueue('BAD');
    await svc.idle();
    svc.enqueue('GOOD');
    await svc.idle();
    assert.deepEqual(hits, ['GOOD']);
  });

  it('pause() stops new enqueues and getStatus() reflects it', async () => {
    const emitter = new EventEmitter();
    const client = fakeClient({ W1AW: { found: true } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client },
    });

    svc.pause();
    assert.deepEqual(svc.getStatus(), { provider: 'hamqth', enabled: true, paused: true });

    svc.enqueue('W1AW');
    await svc.idle();
    assert.deepEqual(client.seen, [], 'a paused service must not perform new lookups');
  });

  it('pause() drops whatever is already queued, not just future enqueues', async () => {
    const emitter = new EventEmitter();
    const client = fakeClient({ AA1A: { found: true }, BB2B: { found: true } });
    // A non-empty betweenMs delay so pause() has a chance to run while
    // BB2B is still sitting in the queue rather than already in flight --
    // NOOP_DEPS' betweenMs: 0 would let the whole queue drain synchronously
    // before this test's own code gets a turn.
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client, betweenMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    });

    svc.enqueue('AA1A');
    svc.enqueue('BB2B');
    await new Promise((r) => setTimeout(r, 5)); // let AA1A start; BB2B stays queued
    svc.pause();
    await svc.idle();

    assert.deepEqual(client.seen, ['AA1A'], 'BB2B should have been dropped by pause(), never looked up');
  });

  it('resume() lets a call dropped mid-queue by pause() be looked up again', async () => {
    const emitter = new EventEmitter();
    const client = fakeClient({ AA1A: { found: true }, BB2B: { found: true } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: { ...NOOP_DEPS, client, betweenMs: 20, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    });

    svc.enqueue('AA1A');
    svc.enqueue('BB2B');
    await new Promise((r) => setTimeout(r, 5)); // AA1A starts; BB2B still queued (see the drop test above)
    svc.pause();
    await svc.idle();
    assert.deepEqual(client.seen, ['AA1A'], 'sanity check: BB2B was dropped, not looked up');

    svc.resume();
    svc.enqueue('BB2B'); // must not be stuck "already pending" from the dropped attempt above
    await svc.idle();
    assert.deepEqual(client.seen, ['AA1A', 'BB2B']);
  });

  it('prime() back-fills uncached calls from the existing QSO table', async () => {
    const emitter = new EventEmitter();
    const client = fakeClient({ W1AW: { found: true }, K3LR: { found: true }, N5DX: { found: true } });
    const svc = createLookupService({
      emitter,
      env: { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      deps: {
        ...NOOP_DEPS,
        client,
        getQsos: () => [{ call: 'W1AW' }, { call: 'K3LR' }, { call: 'W1AW' }, { call: 'N5DX/4' }],
      },
    });

    svc.prime();
    await svc.idle();
    assert.deepEqual([...client.seen].sort(), ['K3LR', 'N5DX', 'W1AW']);
  });
});

describe('lookup via hamdata', () => {
  it('HAMDATA_URL wins over HamQTH credentials', () => {
    const r = resolveLookupConfig(
      { HAMDATA_URL: 'http://127.0.0.1:3100/', LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' },
      { lookup: {} },
    );
    assert.deepEqual(r, { provider: 'hamdata', enabled: true, prg: 'contestscore', url: 'http://127.0.0.1:3100' });
  });

  it('keeps the record\'s own source so cache rows and busts match a direct lookup', async () => {
    const emitter = new EventEmitter();
    const hits = [];
    emitter.on('lookup:result', (d) => hits.push(d));
    const client = { lookup: async (call) => ({ call, found: false, source: 'hamqth' }) };
    const svc = createLookupService({
      emitter, env: { HAMDATA_URL: 'http://127.0.0.1:3100' }, config: { lookup: {} }, deps: { ...NOOP_DEPS, client },
    });
    assert.equal(svc.getStatus().provider, 'hamdata');
    svc.enqueue('X1XX');
    await svc.idle();
    assert.equal(hits[0].source, 'hamqth');
    assert.equal(hits[0].found, false);
  });
});

describe('lookup cache freshness + persisted pause', () => {
  const { FOUND_TTL_MS, NOT_FOUND_TTL_MS } = require('../../src/lookup/ttl');
  const hamqthEnv = { LOOKUP_PROVIDER: 'hamqth', HAMQTH_USERNAME: 'u', HAMQTH_PASSWORD: 'p' };

  it('re-looks-up a found call after ~6 months and a not-found one after a day', async () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const rows = {
      FRESH: freshRow('FRESH', true, now - FOUND_TTL_MS + 3600e3),
      OLD: freshRow('OLD', true, now - FOUND_TTL_MS - 3600e3),
      BUST: freshRow('BUST', false, now - NOT_FOUND_TTL_MS - 3600e3),
      NEWBUST: freshRow('NEWBUST', false, now - 3600e3),
    };
    const client = fakeClient({});
    const svc = createLookupService({
      emitter: new EventEmitter(), env: hamqthEnv,
      deps: { ...NOOP_DEPS, client, now: () => now, getCachedCallsign: (c) => rows[c] },
    });
    for (const c of Object.keys(rows)) svc.enqueue(c);
    await svc.idle();
    assert.deepEqual(client.seen.sort(), ['BUST', 'OLD']);
  });

  it('pause/resume is saved and restored across restarts', async () => {
    const settings = {};
    const deps = { ...NOOP_DEPS, getSetting: (k) => settings[k] ?? null, setSetting: (k, v) => { settings[k] = v; } };
    const a = createLookupService({ emitter: new EventEmitter(), env: hamqthEnv, deps: { ...deps, client: fakeClient({}) } });
    a.pause();
    assert.equal(settings.lookup_paused, '1');
    const b = createLookupService({ emitter: new EventEmitter(), env: hamqthEnv, deps: { ...deps, client: fakeClient({}) } });
    assert.equal(b.getStatus().paused, true);
    b.resume();
    const c = createLookupService({ emitter: new EventEmitter(), env: hamqthEnv, deps: { ...deps, client: fakeClient({}) } });
    assert.equal(c.getStatus().paused, false);
  });
});
