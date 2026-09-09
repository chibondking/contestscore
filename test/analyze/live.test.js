const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeLiveQsos } = require('../../src/analyze');

// Rows shaped like src/db/queries.getQsos() output (a superset of what we
// use). The realtime feed already carries points / mult flags / operator /
// run status / the parsed exchange.
function row(o) {
  return {
    call: 'W1AW', band: '14', mode: 'CW', operator: 'WT2P', mycall: 'WT2P',
    contestname: 'CQ-WPX-CW', contestnr: '1',
    countryprefix: 'K', continent: 'NA', zone: '5', section: '',
    gridsquare: '', op_name: '', power: '', prec: '', ck: '',
    exchange1: '', rcv_nr: '0042', snt_nr: '0007',
    is_mult1: 1, is_mult2: 0, is_mult3: 0, points: 3, is_run_qso: 1, run1run2: '1',
    n1mm_timestamp: '2026-09-06 12:00:00', logged_at: '2026-09-06 12:00:00',
    ...o,
  };
}

describe('analyzeLiveQsos', () => {
  it('remaps rows and reports full fidelity (points / mults / operator / run)', () => {
    const { meta, qsos, excluded } = analyzeLiveQsos([
      row({ call: 'K3LR' }),
      row({ call: 'DL1XYZ', band: '7', operator: 'K3LR', continent: 'EU', zone: '14', countryprefix: 'DL', points: 6, is_mult1: 0, is_run_qso: 0 }),
    ]);

    assert.equal(meta.format, 'live');
    assert.equal(meta.contest, 'CQ-WPX-CW');
    assert.equal(meta.contest_key, 'CQ-WPX');
    assert.equal(meta.exchange_parsed, true);
    assert.equal(meta.station_call, 'WT2P');
    assert.equal(meta.qso_count, 2);
    assert.equal(meta.has_points, true);
    assert.equal(meta.has_mults, true);
    assert.equal(meta.has_operator, true);
    assert.equal(meta.has_run_flag, true);
    assert.ok(meta.operators.includes('WT2P') && meta.operators.includes('K3LR'));
    assert.deepEqual(excluded, []);

    assert.deepEqual(qsos.map((q) => q.call), ['K3LR', 'DL1XYZ']);
    assert.equal(qsos[0].points, 3);
    assert.equal(qsos[0].is_mult1, 1);
    assert.equal(qsos[0].is_run_qso, 1);
    assert.equal(qsos[1].continent, 'EU');
    assert.equal(qsos[1].n1mm_timestamp, '2026-09-06 12:00:00');
  });

  it('fills continent / zone / prefix left blank by an older logger', () => {
    const { qsos } = analyzeLiveQsos([
      row({ call: 'JA1ABC', continent: '', zone: '', countryprefix: '' }),
    ]);
    assert.equal(qsos[0].continent, 'AS');
    assert.equal(qsos[0].zone, '25');
    assert.equal(qsos[0].countryprefix, 'JA');
  });

  it('a plain non-contest feed reports has_points false', () => {
    const { meta } = analyzeLiveQsos([
      row({ contestname: '', points: 0, is_mult1: 0, is_run_qso: 0, operator: '' }),
    ]);
    assert.equal(meta.contest_key, null);
    assert.equal(meta.has_points, false);
    assert.equal(meta.has_operator, false);
  });
});
