// src/cosb/: the standings view, the poller's gating, the publisher's
// throttle and the COSB source's caching -- all with injected fetch/clock,
// no network.
process.env.DB_PATH = ':memory:';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createCosbService, buildView, dynamicResultsXml, sqliteMs } = require('../../src/cosb');
const { createCosbSource } = require('../../src/cosb/source');
const { parseScoreboard } = require('../../src/cosb/parse');

const fx = (f) => fs.readFileSync(path.join(__dirname, '../fixtures/cosb', f), 'utf8');
const BOARD = parseScoreboard(fx('scoreboard-cqww-cw.html'));
const ST = { contest: { id: 56, name: 'CQ WW CW', url: 'https://contestonlinescore.com/scoreboard/?contest_id=56' }, updated: BOARD.updated, fetched_at: 'x', sections: BOARD.sections };

describe('buildView', () => {
  it('our category: top 3, two either side of us, gaps to us', () => {
    const v = buildView(ST, 'k9ct');
    assert.equal(v.status, 'ok');
    assert.equal(v.section, 'M/2 HP');
    assert.equal(v.count, 37);
    assert.equal(v.rank, 11);
    assert.deepEqual(v.rows.map((r) => r.rank), [1, 2, 3, 9, 10, 11, 12, 13]);
    const me = v.rows.find((r) => r.me);
    assert.equal(me.call, 'K9CT');
    assert.equal(me.gap, 0);
    assert.ok(v.rows[0].gap > 0 && v.rows.at(-1).gap < 0);
    assert.equal(v.rows.find((r) => r.rank === 9).break, true);
    assert.equal(v.rows.find((r) => r.rank === 10).break, false);
    assert.equal(v.leader_gap, v.rows[0].gap);
  });

  it('near the top: no duplicate rows, no break', () => {
    const top = BOARD.sections.find((s) => s.label === 'M/2 HP').rows[1].call;
    const v = buildView(ST, top);
    assert.deepEqual(v.rows.map((r) => r.rank), [1, 2, 3, 4]);
    assert.ok(v.rows.every((r) => !r.break));
  });

  it('not on the board / no contest', () => {
    assert.equal(buildView(ST, 'N0CALL').status, 'not_listed');
    assert.equal(buildView({ contest: null }, 'K9CT').status, 'no_contest');
  });
});

describe('sqliteMs', () => {
  it('reads both the ISO stamp and the SQLite datetime as UTC', () => {
    const t = Date.parse('2026-11-28T07:10:19Z');
    assert.equal(sqliteMs('2026-11-28T07:10:19.000Z'), t);
    assert.equal(sqliteMs('2026-11-28 07:10:19'), t);
    assert.equal(sqliteMs('2026-11-28T08:10:19+01:00'), t);
    assert.ok(Number.isNaN(sqliteMs(null)));
  });
});

describe('dynamicResultsXml', () => {
  it('unwraps <rtc> and keeps the document as sent', () => {
    const x = dynamicResultsXml(Buffer.from('<?xml version="1.0"?><rtc><dynamicresults><call>K9CT</call></dynamicresults></rtc>'));
    assert.equal(x, '<?xml version="1.0"?>\n<dynamicresults><call>K9CT</call></dynamicresults>');
    assert.equal(dynamicResultsXml('<contactinfo/>'), null);
  });
});

function fakeSettings() {
  const m = new Map();
  return { getSetting: (k) => (m.has(k) ? m.get(k) : null), setSetting: (k, v) => m.set(k, String(v)), m };
}

// Settings with the board's standings switch on.
function on() {
  const st = fakeSettings();
  st.setSetting('cosb_standings', '1');
  return st;
}

describe('standings poller', () => {
  const NOW = Date.parse('2026-11-28T05:20:00Z');

  it('off by default: never asks until the board switches it on', async () => {
    const asked = [];
    const st = fakeSettings();
    const svc = createCosbService({
      env: {},
      deps: {
        now: () => NOW,
        source: { standings: async (q) => { asked.push(q); return ST; } },
        getLatestScore: () => ({ contest: 'CQ-WW-CW', call: 'K9CT', captured_at: '2026-11-28 05:19:00' }),
        ...st,
      },
    });
    assert.equal((await svc.poll()).status, 'off');
    assert.deepEqual(svc.getStandingsStatus(), { available: true, enabled: false });
    assert.equal(asked.length, 0);
    assert.equal((await svc.setStandings(true)).status, 'ok');
    assert.equal(asked.length, 1);
    assert.equal((await svc.setStandings(false)).status, 'off');
    assert.equal((await svc.poll()).status, 'off');
    assert.equal(asked.length, 1);
  });

  it('polls only while a score is recent, and builds our view', async () => {
    const asked = [];
    // ISO, as insertScoreBreakdown() stamps it (the live bug: this was
    // read as SQLite's format and never counted as recent).
    let captured = '2026-11-28T05:19:00.123Z';
    const svc = createCosbService({
      env: {},
      deps: {
        now: () => NOW,
        source: { standings: async (q) => { asked.push(q); return ST; } },
        getLatestScore: () => ({ contest: 'CQ-WW-CW', call: 'K9CT', captured_at: captured }),
        ...on(),
      },
    });
    const v = await svc.poll();
    assert.equal(v.status, 'ok');
    assert.equal(v.rank, 11);
    assert.deepEqual(asked, [{ contest: 'CQ-WW-CW', contestId: null }]);

    captured = '2026-11-28T04:00:00.000Z'; // contest over an hour ago
    assert.equal((await svc.poll()).status, 'idle');
    assert.equal(asked.length, 1);
  });

  it('keeps the last table on a failed refresh, flagged', async () => {
    let fail = false;
    const svc = createCosbService({
      env: { COSB_CONTEST_ID: '56' },
      deps: {
        now: () => NOW,
        source: { standings: async (q) => { if (fail) throw new Error('COSB /scoreboard: HTTP 502'); assert.equal(q.contestId, 56); return ST; } },
        getLatestScore: () => ({ contest: 'X', call: 'K9CT', captured_at: '2026-11-28 05:19:00' }),
        ...on(),
      },
    });
    await svc.poll();
    fail = true;
    const v = await svc.poll();
    assert.equal(v.status, 'ok');
    assert.equal(v.rank, 11);
    assert.match(v.error, /502/);
  });

  it('COSB_ENABLED=false: never asks', async () => {
    const svc = createCosbService({
      env: { COSB_ENABLED: 'false' },
      deps: { source: { standings: async () => assert.fail('asked') }, getLatestScore: () => null, ...on() },
    });
    assert.equal((await svc.poll()).status, 'disabled');
  });
});

describe('publisher', () => {
  const XML = Buffer.from('<?xml version="1.0"?><dynamicresults><contest>CQ-WW-CW</contest><call>K9CT</call><score>1</score></dynamicresults>');

  it('off by default; on with a login, posts the XML with Basic auth', async () => {
    let t = Date.parse('2026-11-28T05:20:00Z');
    const posts = [];
    const st = fakeSettings();
    const svc = createCosbService({
      env: {},
      deps: {
        now: () => t,
        source: { standings: async () => ST },
        getLatestScore: () => null,
        fetchImpl: async (url, opts) => {
          posts.push({ url, opts });
          return { ok: true, status: 200, text: async () => '{"status":200,"status_message":"OK-Full"}' };
        },
        ...st,
      },
    });
    svc.onScore({}, XML);
    assert.equal(posts.length, 0);
    assert.equal(svc.getPublishStatus().enabled, false);

    const s = svc.setPublish({ enabled: true, user: 'k9ct', password: 'pw' });
    assert.deepEqual([s.enabled, s.user, s.has_password], [true, 'K9CT', true]);
    assert.equal('password' in s, false);

    svc.onScore({}, XML);
    const r = await svc.flush();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://contestonlinescore.com/post/');
    assert.equal(posts[0].opts.headers.Authorization, `Basic ${Buffer.from('K9CT:pw').toString('base64')}`);
    assert.match(posts[0].opts.body, /^<\?xml version="1.0"\?>\n<dynamicresults>/);
    assert.deepEqual([r.ok, r.status, r.message], [true, 200, 'OK-Full']);
    svc.stop();
  });

  it('a COSB error status is reported, not thrown', async () => {
    const st = fakeSettings();
    const svc = createCosbService({
      env: { COSB_USER: 'K9CT', COSB_PASSWORD: 'pw' },
      deps: {
        source: { standings: async () => ST },
        getLatestScore: () => null,
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"status":404,"status_message":"Error! Contest is closed or is not valid"}' }),
        ...st,
      },
    });
    assert.equal(svc.getPublishStatus().from_env, true);
    svc.onScore({}, XML);
    const r = await svc.flush();
    assert.deepEqual([r.ok, r.status], [false, 404]);
    assert.match(r.message, /closed/);
    svc.stop();
  });
});

describe('COSB source caching', () => {
  it('one scoreboard fetch per 2 min, shared by concurrent asks', async () => {
    let t = 0;
    const hits = [];
    const pages = {
      '/contest/': fx('contests.html'),
      '/settings/': fx('supported.html'),
      '/scoreboard/?contest_id=56': fx('scoreboard-cqww-cw.html'),
    };
    const src = createCosbSource({
      now: () => t,
      base: 'https://cosb.test',
      fetchImpl: async (url) => {
        const p = url.replace('https://cosb.test', '');
        hits.push(p);
        return { ok: true, status: 200, text: async () => pages[p] };
      },
    });
    const [a, b] = await Promise.all([src.standings({ contest: 'CQ-WW-CW' }), src.standings({ contest: 'CQ-WW-CW' })]);
    assert.equal(a.contest.id, 56);
    assert.equal(b.sections.length, 4);
    assert.equal(hits.filter((h) => h.startsWith('/scoreboard')).length, 1);

    t += 60000;
    await src.standings({ contest: 'CQ-WW-CW' });
    assert.equal(hits.filter((h) => h.startsWith('/scoreboard')).length, 1);
    t += 61000;
    await src.standings({ contest: 'CQ-WW-CW' });
    assert.equal(hits.filter((h) => h.startsWith('/scoreboard')).length, 2);
    assert.equal(hits.filter((h) => h === '/settings/').length, 1);

    assert.deepEqual(await src.standings({ contest: 'NAQP-CW' }), { contest: null });
  });
});

describe('publisher: only while the COSB contest is on air', () => {
  const XML = Buffer.from('<dynamicresults><contest>CQ-WW-CW</contest><call>K9CT</call></dynamicresults>');
  function svcWith(statusFn) {
    const posts = [];
    const svc = createCosbService({
      env: { COSB_USER: 'K9CT', COSB_PASSWORD: 'pw' },
      deps: {
        source: { standings: async () => ST, contestStatus: statusFn },
        getLatestScore: () => null,
        fetchImpl: async (url, opts) => { posts.push(opts.body); return { ok: true, status: 200, text: async () => '{"status":200,"status_message":"OK"}' }; },
        ...fakeSettings(),
      },
    });
    return { svc, posts };
  }

  it('skips (not fails) when the contest is closed or unknown, with the reason', async () => {
    const asked = [];
    const { svc, posts } = svcWith(async (q) => { asked.push(q); return { contest: { id: 56, name: 'CQ WW CW', status: 'closed' } }; });
    svc.onScore({}, XML);
    const r = await svc.flush();
    assert.equal(posts.length, 0);
    assert.deepEqual([r.ok, r.skipped, r.status], [false, true, 'not_on_air']);
    assert.match(r.message, /CQ WW CW is closed/);
    assert.deepEqual(asked, [{ contest: 'CQ-WW-CW', contestId: null }]);
    assert.equal(svc.getPublishStatus().contest.status, 'closed');
    svc.stop();

    const u = svcWith(async () => ({ contest: null }));
    u.svc.onScore({}, XML);
    assert.match((await u.svc.flush()).message, /no contest for CQ-WW-CW/);
    u.svc.stop();
  });

  it('posts when on air, and when the status check itself fails', async () => {
    const a = svcWith(async () => ({ contest: { id: 56, name: 'CQ WW CW', status: 'on_air' } }));
    a.svc.onScore({}, XML);
    assert.equal((await a.svc.flush()).ok, true);
    assert.equal(a.posts.length, 1);
    a.svc.stop();

    const b = svcWith(async () => { throw new Error('hamdata down'); });
    b.svc.onScore({}, XML);
    assert.equal((await b.svc.flush()).ok, true);
    assert.equal(b.posts.length, 1);
    b.svc.stop();
  });
});

describe('COSB source: contest list kept in the store', () => {
  it('persists the list, seeds a new source from it, and serves it while COSB is down', async () => {
    const st = fakeSettings();
    let t = 0;
    let up = true;
    const pages = { '/contest/': fx('contests.html'), '/settings/': fx('supported.html') };
    const fetchImpl = async (url) => {
      if (!up) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => pages[url.replace('https://cosb.test', '')] };
    };
    const a = createCosbSource({ now: () => t, base: 'https://cosb.test', fetchImpl, store: st });
    const s1 = await a.contestStatus({ contest: 'CQ-WW-CW' });
    assert.deepEqual([s1.contest.id, s1.contest.status], [56, 'on_air']);
    assert.ok(JSON.parse(st.getSetting('cosb_contests')).value.length > 0);

    up = false;
    t += 24 * 3600000; // a day later, COSB down, fresh process
    const b = createCosbSource({ now: () => t, base: 'https://cosb.test', fetchImpl, store: st });
    const s2 = await b.contestStatus({ contest: 'CQ-WW-CW' });
    assert.equal(s2.contest.id, 56);
    assert.equal((await b.contests()).contests.find((c) => c.id === 113).status, 'coming');
  });
});

describe('following other stations', () => {
  const NOW = Date.parse('2026-11-28T05:20:00Z');
  const m2 = BOARD.sections.find((s) => s.label === 'M/2 HP').rows;
  const mm = BOARD.sections.find((s) => s.label === 'M/M HP').rows;

  it('finds each followed call in any category, with its gap to us', () => {
    const k9ct = m2.find((r) => r.call === 'K9CT');
    const v = buildView(ST, 'K9CT', [m2[0].call, mm[0].call, 'N0CALL']);
    assert.equal(v.follow.length, 3);
    const [a, b, c] = v.follow;
    assert.deepEqual([a.found, a.section, a.rank, a.gap], [true, 'M/2 HP', 1, m2[0].score - k9ct.score]);
    assert.deepEqual([b.section, b.count], ['M/M HP', mm.length]);
    assert.deepEqual(c, { call: 'N0CALL', found: false });
  });

  it('still lists them when we are not on the board -- no gap', () => {
    const v = buildView(ST, 'N0CALL', [m2[0].call]);
    assert.equal(v.status, 'not_listed');
    assert.equal(v.follow[0].found, true);
    assert.equal(v.follow[0].gap, null);
  });

  it('setFollow stores up to three, deduped, and updates the view at once', async () => {
    const st = on();
    const svc = createCosbService({
      env: {},
      deps: {
        now: () => NOW,
        source: { standings: async () => ST },
        getLatestScore: () => ({ contest: 'CQ-WW-CW', call: 'K9CT', captured_at: '2026-11-28T05:19:00Z' }),
        ...st,
      },
    });
    await svc.poll();
    assert.deepEqual(svc.getView().follow, []);
    const list = svc.setFollow(['k1abc', 'K1ABC', m2[0].call.toLowerCase(), 'W1X', 'W2X']);
    assert.deepEqual(list, ['K1ABC', m2[0].call, 'W1X']);
    assert.deepEqual(svc.getFollow(), list);
    assert.equal(svc.getView().follow[1].rank, 1); // no poll needed
  });
});

describe('scoped standings view', () => {
  const NOW = Date.parse('2026-11-28T05:20:00Z');
  it('getView(scope) ranks within the scope; the pushed view stays the whole board', async () => {
    // Everyone in M/2 HP is "NA" except calls starting with D (EU).
    const locate = (c) => ({ continent: c.startsWith('D') ? 'EU' : 'NA', zone: c.startsWith('D') ? 14 : 5 });
    const svc = createCosbService({
      env: {},
      deps: {
        now: () => NOW, locate,
        source: { standings: async () => ST },
        getLatestScore: () => ({ contest: 'CQ-WW-CW', call: 'K9CT', captured_at: '2026-11-28T05:19:00Z' }),
        ...on(),
      },
    });
    const world = await svc.poll();
    assert.equal(world.scope, 'world');
    assert.ok(world.scopes.continents.some((o) => o.scope === 'cont:NA'));
    const m2 = BOARD.sections.find((s) => s.label === 'M/2 HP').rows;
    const naAhead = m2.filter((r) => r.score > m2.find((x) => x.call === 'K9CT').score && !r.call.startsWith('D')).length;
    const na = svc.getView('cont:NA');
    assert.equal(na.rank, naAhead + 1);
    assert.equal(na.scope_label, 'NA');
    const eu = svc.getView('cont:EU');
    assert.equal(eu.outside, true);
    assert.equal(eu.rank, null);
    assert.equal(svc.getView('bogus').scope, 'world');
    assert.equal(svc.getView().rank, 11);
  });
});

describe('scoped standings: our own zone', () => {
  it("comes from the logger's score, not the country file's default", async () => {
    const locate = () => ({ continent: 'NA', zone: 5 }); // cty: every W is zone 5
    const svc = createCosbService({
      env: {},
      deps: {
        now: () => Date.parse('2026-11-28T05:20:00Z'), locate,
        source: { standings: async () => ST },
        getLatestScore: () => ({ contest: 'CQ-WW-CW', call: 'K9CT', cq_zone: '4', captured_at: '2026-11-28T05:19:00Z' }),
        ...on(),
      },
    });
    const v = await svc.poll();
    assert.ok(v.scopes.zones.some((o) => o.scope === 'zone:4' && o.count === 1));
    const z4 = svc.getView('zone:4');
    assert.deepEqual([z4.rank, z4.count, z4.outside], [1, 1, false]);
    assert.equal(svc.getView('zone:5').outside, true);
  });
});
