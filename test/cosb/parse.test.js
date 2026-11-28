// COSB page parsers against pages captured live from contestonlinescore.com
// during CQ WW CW 2026 (test/fixtures/cosb/, trimmed: the scoreboard keeps
// its first four category tables, the supported list a dozen rows).
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseContestList, parseSupported, parseScoreboard, resolveContest, contestKey,
} = require('../../src/cosb/parse');

const fx = (f) => fs.readFileSync(path.join(__dirname, '../fixtures/cosb', f), 'utf8');

describe('parseScoreboard', () => {
  const sb = parseScoreboard(fx('scoreboard-cqww-cw.html'));

  it('reads the board time and one section per category table', () => {
    assert.equal(sb.updated, '28 Nov 2026 05:19 UTC');
    assert.deepEqual(sb.sections.map((s) => [s.label, s.rows.length]), [
      ['M/M Distributed HP', 3], ['M/M HP', 18], ['M/2 HP', 37], ['M/2 LP', 1],
    ]);
  });

  it('reads a station row: rank, call, score, QSOs, mults, last, club, logger', () => {
    const k9ct = sb.sections.find((s) => s.label === 'M/2 HP').rows.find((r) => r.call === 'K9CT');
    assert.deepEqual(k9ct, {
      rank: 11, call: 'K9CT', op: null, score: 630978, qsos: 833,
      mult: 309, mults: [232, 77], last: '00:01',
      club: 'Society of Midwest Contesters', log: 'N+',
    });
  });

  it('ranks run 1..n within each section', () => {
    for (const s of sb.sections) assert.deepEqual(s.rows.map((r) => r.rank), s.rows.map((_, i) => i + 1));
  });

  it('a page with no tables is no sections, not an error', () => {
    assert.deepEqual(parseScoreboard('<html>maintenance</html>'), { updated: null, sections: [] });
  });

  it('splits the operator out of "CALL (OP)"', () => {
    const html = `<tr class="title5"><td> SO-ALL HP</td><td>Score</td></tr><tr class="tbl1" >
      <td>1</td><td><a href ="/tools/rate/?call=TI7W"><strong>TI7W (N4YDU)</strong></a></td>
      <td>705,180 &nbsp; </td><td><strong>1,431&nbsp;</strong></td>
      <td><table><tr><td><strong>210</strong></td><td>143</td><td>67</td></tr></table></td>
      <td></td><td>00:00</td><td></td><td>Potomac Valley Radio Club</td><td></td><td>DX</td></tr>`;
    const r = parseScoreboard(html).sections[0].rows[0];
    assert.equal(r.call, 'TI7W');
    assert.equal(r.op, 'N4YDU');
    assert.equal(r.mult, 210);
    assert.equal(r.club, 'Potomac Valley Radio Club');
  });
});

describe('contest list + matching', () => {
  const list = parseContestList(fx('contests.html'));
  const sup = parseSupported(fx('supported.html'));

  it('reads the picker with each contest status', () => {
    assert.deepEqual(list.find((c) => c.id === 56), { id: 56, name: 'CQ WW CW', status: 'on_air' });
    assert.equal(list.find((c) => c.id === 113).status, 'coming');
    assert.ok(list.some((c) => c.status === 'closed'));
  });

  it('reads the supported table: COSB name -> logger contest id', () => {
    assert.ok(sup.some((s) => s.name === 'CQ WW CW' && s.loggerId === 'CQ-WW-CW'));
    assert.equal(sup.filter((s) => s.loggerId === 'CW-Ops').length, 4);
  });

  it("maps the logger's contest to the on-air COSB contest", () => {
    assert.equal(resolveContest('CQ-WW-CW', list, sup).id, 56);
    assert.equal(resolveContest('cq ww cw', list, sup).id, 56);
    assert.equal(resolveContest('ARRL-160', list, sup), null); // coming, not on air
    assert.equal(resolveContest('', list, sup), null);
  });

  it('one logger id, several COSB contests: picks the one on air', () => {
    const l = [
      { id: 4, name: 'CWops Mini-CWT 1', status: 'closed' },
      { id: 34, name: 'CWops Mini-CWT 2', status: 'on_air' },
    ];
    assert.equal(resolveContest('CW-Ops', l, sup).id, 34);
  });

  it('contestKey ignores case and punctuation', () => {
    assert.equal(contestKey('CQ-WW-CW'), contestKey('cq ww cw'));
  });
});
