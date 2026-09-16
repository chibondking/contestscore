const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isQtc, modeGroup, dedupeForCharting } = require('../../public/js/charts.js');

function qso(overrides) {
  return {
    call: 'W1AW', band: '20', mode: 'CW', exchange1: '', points: 1,
    is_mult1: 0, is_mult2: 0, is_mult3: 0, logged_at: '2026-09-16 19:00:00',
    ...overrides,
  };
}

describe('isQtc', () => {
  it('matches N1MM\'s SQTC/RQTC exchange1 values, case-insensitively', () => {
    assert.equal(isQtc(qso({ exchange1: 'SQTC' })), true);
    assert.equal(isQtc(qso({ exchange1: 'rqtc' })), true);
  });
  it('does not match an ordinary exchange value', () => {
    assert.equal(isQtc(qso({ exchange1: '599 OH' })), false);
  });
});

describe('modeGroup', () => {
  it('buckets CW, phone variants, and digital', () => {
    assert.equal(modeGroup('CW'), 'CW');
    assert.equal(modeGroup('SSB'), 'PH');
    assert.equal(modeGroup('FT8'), 'DG');
  });
});

// Same fix as stats.js's dedupeForScoring() / report.js's dedupeQsos() --
// see either's comment for the live incident (scoreboard.wt2p.us, CW-OPS
// 2026-09-16). charts.js had no QTC or dupe awareness at all before this.
describe('dedupeForCharting', () => {
  it('drops a genuine dupe (same call/band/mode worked twice), keeping the earlier QSO', () => {
    const first = qso({ logged_at: '2026-09-16 19:47:12', points: 1, is_mult1: 1 });
    const second = qso({ logged_at: '2026-09-16 19:56:34', points: 0, is_mult1: 0 }); // the dupe
    const out = dedupeForCharting([first, second]);
    assert.equal(out.length, 1);
    assert.equal(out[0], first);
  });

  it('does not touch two distinct QSOs (different calls)', () => {
    const a = qso({ call: 'N6NT' });
    const b = qso({ call: 'NM2A' });
    assert.deepEqual(dedupeForCharting([a, b]), [a, b]);
  });

  it('does not touch a re-work on a different band or mode', () => {
    const band20 = qso({ band: '20' });
    const band40 = qso({ band: '40' });
    assert.deepEqual(dedupeForCharting([band20, band40]), [band20, band40]);
  });

  // The regression this guards against: a naive "same call/band/mode more
  // than once = dupe" rule would also catch a WAE QTC, which always shares
  // its parent QSO's call/band/mode by design.
  it('never drops a QTC row, even though it shares its parent QSO\'s call/band/mode', () => {
    const realQso = qso({ logged_at: '2026-09-16 19:00:00', exchange1: '' });
    const qtc1 = qso({ logged_at: '2026-09-16 19:00:05', exchange1: 'SQTC' });
    const out = dedupeForCharting([realQso, qtc1]);
    assert.equal(out.length, 2);
    assert.ok(out.includes(realQso));
    assert.ok(out.includes(qtc1));
  });

  it('keeps a row with no parseable timestamp rather than risk dropping a real QSO', () => {
    const noTime = qso({ logged_at: '' });
    const anotherNoTime = qso({ logged_at: '' });
    assert.equal(dedupeForCharting([noTime, anotherNoTime]).length, 2);
  });
});
