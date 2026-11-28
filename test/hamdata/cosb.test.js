// hamdata's GET /cosb/standings (one COSB reader per box) and the instance
// client that asks it. Real HTTP, a fake COSB source.
const http = require('node:http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../../hamdata/app');
const { createHamdataClient } = require('../../src/hamdata/client');

let server;
let base;
const asked = [];
const cosb = {
  standings: async (q) => {
    asked.push(q);
    if (q.contest === 'BOOM') throw new Error('COSB /contest/: HTTP 503');
    return { contest: { id: 56, name: 'CQ WW CW' }, sections: [] };
  },
  contestStatus: async (q) => {
    asked.push(q);
    return { contest: q.contest === 'CQ-WW-CW' ? { id: 56, name: 'CQ WW CW', status: 'on_air' } : null, fetched_at: 'x' };
  },
  contests: async () => ({ fetched_at: 'x', contests: [{ id: 56, name: 'CQ WW CW', status: 'on_air' }] }),
};

before(async () => {
  server = http.createServer(createApp({ broker: { getStatus: () => ({}) }, solar: null, cosb, env: {} }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await new Promise((r) => server.close(r)); });

describe('hamdata /cosb/standings', () => {
  it('passes the logger contest (and an optional id) to the source', async () => {
    const client = createHamdataClient({ url: base });
    const body = await client.cosbStandings({ contest: 'CQ-WW-CW' });
    assert.equal(body.contest.id, 56);
    await client.cosbStandings({ contest: 'X', contestId: 56 });
    assert.deepEqual(asked.slice(-2), [{ contest: 'CQ-WW-CW', contestId: null }, { contest: 'X', contestId: 56 }]);
  });

  it('rejects junk and reports a COSB failure as 502', async () => {
    assert.equal((await fetch(`${base}/cosb/standings?contest=${encodeURIComponent('<script>')}`)).status, 400);
    assert.equal((await fetch(`${base}/cosb/standings`)).status, 400);
    assert.equal((await fetch(`${base}/cosb/standings?contest_id=-1`)).status, 400);
    assert.equal((await fetch(`${base}/cosb/standings?contest=BOOM`)).status, 502);
  });

  it('503 when hamdata has no COSB source', async () => {
    const s = http.createServer(createApp({ broker: { getStatus: () => ({}) }, solar: null, env: {} }));
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const r = await fetch(`http://127.0.0.1:${s.address().port}/cosb/standings?contest=CQ-WW-CW`);
    assert.equal(r.status, 503);
    await new Promise((r2) => s.close(r2));
  });

  it('contest status and the stored list', async () => {
    const client = createHamdataClient({ url: base });
    assert.equal((await client.cosbContestStatus({ contest: 'CQ-WW-CW' })).contest.status, 'on_air');
    assert.equal((await client.cosbContestStatus({ contest: 'NAQP-CW' })).contest, null);
    assert.equal((await fetch(`${base}/cosb/contest-status`)).status, 400);
    const list = await (await fetch(`${base}/cosb/contests`)).json();
    assert.equal(list.contests[0].id, 56);
  });
});
