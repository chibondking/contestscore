// Uses an in-memory SQLite DB so no files are created.
process.env.DB_PATH = ':memory:';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb, getDb } = require('../../src/db/index');
const { resetStatements } = require('../../src/db/queries');
const q = require('../../src/db/queries');

const QSO = {
  ext_id: 'id-0001',
  call: 'DL1ABC', band: '20', mode: 'CW', operator: 'K1TTT',
  mycall: 'K1TTT', contestname: 'CQ-WPX-CW', contestnr: '73',
  snt: '599', snt_nr: '001', rcv: '599', rcv_nr: '001',
  is_mult1: 1, is_mult2: 0,
  points: 1, exchange1: '', section: '', rover_loc: '',
  radio_nr: 1, comp_nr: 1,
};

const RADIO = {
  radio_nr: 1, station_name: 'K1TTT-1',
  freq: '14025000', tx_freq: '14025000',
  mode: 'CW', op_call: 'K1TTT',
  is_running: 1, is_transmitting: 0,
  focus_entry: 1, antenna: '1', rotator: '90',
  focus_radio: 1, active_radio: 1,
};

function scoreBatch(qsos, points) {
  return {
    contest: 'CQ-WPX-CW', call: 'K1TTT', ops: 'K1TTT',
    power: 'HIGH', assisted: 0, transmitter: 'ONE',
    category_ops: 'SINGLE-OP', category_bands: 'ALL', category_mode: 'CW',
    score_total: points,
    breakdown: [
      { band: '20', mode: 'CW', qsos, points, mults: null, is_total: false },
      { band: 'total', mode: 'ALL', qsos, points, mults: null, is_total: true },
    ],
  };
}

before(() => initDb());
after(() => { resetStatements(); closeDb(); });

describe('QSOs', () => {
  it('inserts a QSO and retrieves it', () => {
    const info = q.upsertQso(QSO);
    assert.equal(info.changes, 1);
    const rows = q.getQsos();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'DL1ABC');
  });

  it('upserts by ext_id: a re-sent (edited) contactinfo updates the row in place', () => {
    q.upsertQso({ ...QSO, points: 3, exchange1: 'corrected' });
    const rows = q.getQsos();
    assert.equal(rows.length, 1); // still one row, not a duplicate
    assert.equal(rows[0].points, 3);
    assert.equal(rows[0].exchange1, 'corrected');
  });

  it('inserts a second QSO with different call', () => {
    q.upsertQso({ ...QSO, ext_id: 'id-0002', call: 'JA1YXZ' });
    assert.equal(q.getQsos().length, 2);
  });

  it('without an ext_id, falls back to INSERT OR IGNORE natural-key dedupe', () => {
    const noId = { ...QSO, ext_id: null, call: 'OH2BH', band: '40' };
    const first = q.upsertQso(noId);
    assert.equal(first.changes, 1);
    const dupe = q.upsertQso(noId);
    assert.equal(dupe.changes, 0);
    assert.equal(q.getQsos({ call: undefined }).filter((r) => r.call === 'OH2BH').length, 1);
  });

  it('filters by band', () => {
    const rows = q.getQsos({ band: '40' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'OH2BH');
  });

  it('filters by mode', () => {
    q.upsertQso({ ...QSO, ext_id: 'id-0003', call: 'VK2BNG', mode: 'SSB' });
    const rows = q.getQsos({ mode: 'SSB' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'VK2BNG');
  });

  it('filters by operator', () => {
    q.upsertQso({ ...QSO, ext_id: 'id-0004', call: 'PA0RCT', operator: 'W1OP' });
    const rows = q.getQsos({ operator: 'W1OP' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'PA0RCT');
  });

  it('combines multiple filters', () => {
    const rows = q.getQsos({ band: '20', mode: 'CW' });
    assert.ok(rows.every((r) => r.band === '20' && r.mode === 'CW'));
  });

  it('deletes a QSO by ext_id', () => {
    const before = q.getQsos().length;
    q.deleteQso({ ext_id: 'id-0002' });
    assert.equal(q.getQsos().length, before - 1);
    assert.ok(!q.getQsos().find((r) => r.call === 'JA1YXZ'));
  });

  it('deletes a QSO without ext_id via the natural-key fallback', () => {
    const before = q.getQsos().length;
    q.deleteQso({ ext_id: null, call: 'OH2BH', band: '40', mycall: 'K1TTT', contestnr: '73' });
    assert.equal(q.getQsos().length, before - 1);
    assert.ok(!q.getQsos().find((r) => r.call === 'OH2BH'));
  });

  it('the natural-key fallback never deletes a row that has an ext_id', () => {
    const before = q.getQsos().length;
    // DL1ABC (id-0001) matches on call/band/mycall/contestnr, but has an ext_id.
    q.deleteQso({ ext_id: null, call: 'DL1ABC', band: '20', mycall: 'K1TTT', contestnr: '73' });
    assert.equal(q.getQsos().length, before);
    assert.ok(q.getQsos().find((r) => r.call === 'DL1ABC'));
  });

  it('clearQsos removes all QSOs atomically', () => {
    q.clearQsos();
    assert.equal(q.getQsos().length, 0);
  });
});

describe('radio_state', () => {
  it('inserts a new radio row', () => {
    q.upsertRadio(RADIO);
    const radios = q.getRadios();
    assert.equal(radios.length, 1);
    assert.equal(radios[0].radio_nr, 1);
    assert.equal(radios[0].freq, '14025000');
    assert.equal(radios[0].mode, 'CW');
    assert.equal(radios[0].is_running, 1);
    assert.equal(radios[0].is_transmitting, 0);
    assert.equal(radios[0].active_radio, 1);
  });

  it('upserts (updates) existing radio without creating a duplicate', () => {
    q.upsertRadio({ ...RADIO, freq: '21025000', mode: 'SSB', is_running: 0 });
    const radios = q.getRadios();
    assert.equal(radios.length, 1);
    assert.equal(radios[0].freq, '21025000');
    assert.equal(radios[0].mode, 'SSB');
    assert.equal(radios[0].is_running, 0);
  });

  it('stores multiple radios ordered by radio_nr', () => {
    q.upsertRadio({ ...RADIO, radio_nr: 2, freq: '14025000', mode: 'CW', is_running: 0 });
    const radios = q.getRadios();
    assert.equal(radios.length, 2);
    assert.equal(radios[0].radio_nr, 1);
    assert.equal(radios[1].radio_nr, 2);
  });
});

describe('score_snapshots', () => {
  it('inserts a score breakdown as one coherent batch', () => {
    q.insertScoreBreakdown(scoreBatch(42, 84));
    const s = q.getLatestScore();
    assert.ok(s);
    assert.equal(s.contest, 'CQ-WPX-CW');
    assert.equal(s.qsos, 42);
    assert.equal(s.points, 84);
    assert.equal(s.is_total, 1);
  });

  it('getLatestScore returns the total row, not just whichever band arrived last', () => {
    q.insertScoreBreakdown(scoreBatch(50, 100));
    const s = q.getLatestScore();
    assert.equal(s.band, 'total');
    assert.equal(s.mode, 'ALL');
    assert.equal(s.qsos, 50);
    assert.equal(s.points, 100);
  });

  it('getScoreBreakdown returns the latest row per band/mode, excluding the total', () => {
    const breakdown = q.getScoreBreakdown();
    assert.ok(breakdown.every((b) => b.is_total === 0));
    const b20 = breakdown.find((b) => b.band === '20' && b.mode === 'CW');
    assert.ok(b20);
    assert.equal(b20.qsos, 50);
  });

  it('getScoreHistory returns only total rows, in chronological order', () => {
    const history = q.getScoreHistory();
    assert.ok(history.length >= 2);
    assert.ok(history.every((h) => h.is_total === 1));
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].captured_at >= history[i - 1].captured_at);
    }
  });

  it('clearQsos also clears score_snapshots', () => {
    q.clearQsos();
    assert.equal(q.getLatestScore(), null);
    assert.equal(q.getScoreHistory().length, 0);
    assert.equal(q.getScoreBreakdown().length, 0);
  });
});

describe('settings', () => {
  it('stores and retrieves a setting', () => {
    q.setSetting('contest', 'CQ-WPX-CW');
    assert.equal(q.getSetting('contest'), 'CQ-WPX-CW');
  });

  it('updates an existing setting', () => {
    q.setSetting('contest', 'CQWW-CW');
    assert.equal(q.getSetting('contest'), 'CQWW-CW');
  });

  it('returns null for a missing key', () => {
    assert.equal(q.getSetting('no_such_key'), null);
  });
});

describe('callsign_cache', () => {
  const LOOKUP = { call: 'DL1ABC', name: 'Test', country: 'Germany', cqzone: '14' };

  it('stores and retrieves a lookup result', () => {
    q.cacheCallsign('DL1ABC', LOOKUP, 'hamdb');
    const row = q.getCachedCallsign('DL1ABC');
    assert.ok(row);
    assert.equal(row.call, 'DL1ABC');
    assert.equal(row.source, 'hamdb');
    assert.deepEqual(JSON.parse(row.data), LOOKUP);
  });

  it('upserts (replaces) an existing cache entry', () => {
    q.cacheCallsign('DL1ABC', { ...LOOKUP, name: 'Updated' }, 'qrz');
    const row = q.getCachedCallsign('DL1ABC');
    assert.equal(JSON.parse(row.data).name, 'Updated');
    assert.equal(row.source, 'qrz');
  });

  it('returns undefined for an uncached callsign', () => {
    assert.equal(q.getCachedCallsign('ZZ9ZZZ'), undefined);
  });

  it('clearQsos also wipes the callsign cache', () => {
    q.clearQsos();
    assert.equal(q.getCachedCallsign('DL1ABC'), undefined);
  });
});

describe('getQsoRate', () => {
  // logged_at only has a DEFAULT (datetime('now')) at insert time -- it's
  // not a settable field on upsertQso -- so ages are simulated the same way
  // the Go agent's own tests do it: insert normally, then back-date the row
  // directly, rather than sleeping through real minutes in a test.
  function backdate(extId, minutesAgo) {
    const ts = new Date(Date.now() - minutesAgo * 60000).toISOString().slice(0, 19).replace('T', ' ');
    getDb().prepare('UPDATE qsos SET logged_at = ? WHERE ext_id = ?').run(ts, extId);
  }

  it('an empty log reports zero for every window', () => {
    q.clearQsos();
    const rate = q.getQsoRate();
    assert.deepEqual(rate.map((r) => r.minutes), [10, 30, 60]);
    assert.ok(rate.every((r) => r.qsos === 0 && r.rate_per_hour === 0));
  });

  it('a QSO logged just now counts toward every window', () => {
    q.clearQsos();
    q.upsertQso({ ...QSO, ext_id: 'rate-fresh' });
    const rate = q.getQsoRate();
    assert.ok(rate.every((r) => r.qsos === 1));
    // 1 QSO in a 10-minute window extrapolates to 6/hr.
    assert.equal(rate.find((r) => r.minutes === 10).rate_per_hour, 6);
  });

  it('a QSO older than a window falls out of it, but not the wider ones', () => {
    q.clearQsos();
    q.upsertQso({ ...QSO, ext_id: 'rate-old' });
    backdate('rate-old', 45); // outside the 10 and 30 min windows, inside 60

    const rate = q.getQsoRate();
    assert.equal(rate.find((r) => r.minutes === 10).qsos, 0);
    assert.equal(rate.find((r) => r.minutes === 30).qsos, 0);
    assert.equal(rate.find((r) => r.minutes === 60).qsos, 1);
  });

  it('a QSO older than every window is excluded entirely', () => {
    q.clearQsos();
    q.upsertQso({ ...QSO, ext_id: 'rate-ancient' });
    backdate('rate-ancient', 90);

    const rate = q.getQsoRate();
    assert.ok(rate.every((r) => r.qsos === 0));
  });
});
