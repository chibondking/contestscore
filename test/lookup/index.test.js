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
    assert.deepEqual(svc.getStatus(), { provider: 'none', enabled: false });
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
      deps: { ...NOOP_DEPS, client, getCachedCallsign: (c) => (cached.has(c) ? { call: c } : undefined) },
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
