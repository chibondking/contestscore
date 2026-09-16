const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isQtc, modeGroup, dedupeForScoring } = require('../../public/js/stats.js');

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
    assert.equal(isQtc(qso({ exchange1: '' })), false);
  });
});

describe('modeGroup', () => {
  it('buckets CW, phone variants, and digital', () => {
    assert.equal(modeGroup('CW'), 'CW');
    assert.equal(modeGroup('SSB'), 'PH');
    assert.equal(modeGroup('USB'), 'PH');
    assert.equal(modeGroup('FT8'), 'DG');
    assert.equal(modeGroup('RTTY'), 'DG');
  });
});

// This is the fix for the live discrepancy reported 2026-09-16
// (scoreboard.wt2p.us, CW-OPS): the qsos table correctly keeps every logged
// contact including genuine dupes, but N1MM's own score and any per-band
// breakdown a viewer would transcribe onto a 3830 report both exclude
// them -- dedupeForScoring() is what makes stats.js match that.
describe('dedupeForScoring', () => {
  it('drops a genuine dupe (same call/band/mode worked twice), keeping the earlier QSO', () => {
    const first = qso({ logged_at: '2026-09-16 19:47:12', points: 1, is_mult1: 1 });
    const second = qso({ logged_at: '2026-09-16 19:56:34', points: 0, is_mult1: 0 }); // the actual dupe
    const out = dedupeForScoring([first, second]);
    assert.equal(out.length, 1);
    assert.equal(out[0], first);
  });

  it('does not touch two distinct QSOs (different calls)', () => {
    const a = qso({ call: 'N6NT' });
    const b = qso({ call: 'NM2A' });
    assert.deepEqual(dedupeForScoring([a, b]), [a, b]);
  });

  it('does not touch a re-work on a different band or mode', () => {
    const band20 = qso({ band: '20' });
    const band40 = qso({ band: '40' });
    const modeCW = qso({ mode: 'CW' });
    const modeSSB = qso({ mode: 'SSB' });
    assert.deepEqual(dedupeForScoring([band20, band40]), [band20, band40]);
    assert.deepEqual(dedupeForScoring([modeCW, modeSSB]), [modeCW, modeSSB]);
  });

  // The regression this guards against: a naive "same call/band/mode more
  // than once = dupe" rule would also catch a WAE QTC, which always shares
  // its parent QSO's call/band/mode by design (it's traffic *about* that
  // QSO, sent moments later) -- collapsing a real QSO + its QTCs down to
  // one row would silently drop real, separately-scored QTC traffic.
  it('never drops a QTC row, even though it shares its parent QSO\'s call/band/mode', () => {
    const realQso = qso({ logged_at: '2026-09-16 19:00:00', exchange1: '' });
    const qtc1 = qso({ logged_at: '2026-09-16 19:00:05', exchange1: 'SQTC' });
    const qtc2 = qso({ logged_at: '2026-09-16 19:00:10', exchange1: 'SQTC' });
    const out = dedupeForScoring([realQso, qtc1, qtc2]);
    assert.equal(out.length, 3);
    assert.ok(out.includes(realQso));
    assert.ok(out.includes(qtc1));
    assert.ok(out.includes(qtc2));
  });

  it('keeps a row with no parseable timestamp rather than risk dropping a real QSO', () => {
    const noTime = qso({ logged_at: '', n1mm_timestamp: undefined });
    const dupeOfNothing = qso({ logged_at: '', n1mm_timestamp: undefined });
    const out = dedupeForScoring([noTime, dupeOfNothing]);
    assert.equal(out.length, 2);
  });
});
