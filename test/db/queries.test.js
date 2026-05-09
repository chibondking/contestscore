// Uses an in-memory SQLite DB so no files are created.
process.env.DB_PATH = ':memory:';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements } = require('../../src/db/queries');
const q = require('../../src/db/queries');

const QSO = {
  call: 'DL1ABC', band: '20', mode: 'CW', operator: 'K1TTT',
  mycall: 'K1TTT', contestname: 'CQ-WPX-CW',
  srx: '001', stx: '001', snt: '599', rcv: '599',
  mult1: 'DL', mult2: '', is_mult1: 1, is_mult2: 0,
  points: 1, exchange1: '', section: '', rover_loc: '',
  radio_nr: 1, comp_nr: 1,
};

const RADIO = {
  radio_nr: 1, station_name: 'K1TTT-1',
  freq: '14025000', tx_freq: '14025000',
  mode: 'CW', op_call: 'K1TTT',
  is_running: 1, is_transmitting: 0,  // extra field — should be silently ignored
  focus_entry: 1, antenna: '1', rotator: '90',
  focus_radio: 1, active_radio: 1,     // extra field — should be silently ignored
};

const SCORE = {
  contest: 'CQ-WPX-CW', call: 'K1TTT', operators: 'K1TTT',
  power: 'HIGH', assisted: 0, transmitted: 'ALL',
  band: 'ALL', mode: 'CW',
  qsos: 42, points: 126, mults: 15, mults2: 0, total: 1890,
};

before(() => initDb());
after(() => { resetStatements(); closeDb(); });

describe('QSOs', () => {
  it('inserts a QSO and retrieves it', () => {
    const info = q.insertQso(QSO);
    assert.equal(info.changes, 1);
    const rows = q.getQsos();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'DL1ABC');
  });

  it('INSERT OR IGNORE silently drops a duplicate', () => {
    const info = q.insertQso(QSO);
    assert.equal(info.changes, 0);
    assert.equal(q.getQsos().length, 1);
  });

  it('inserts a second QSO with different call', () => {
    q.insertQso({ ...QSO, call: 'JA1YXZ', mult1: 'JA' });
    assert.equal(q.getQsos().length, 2);
  });

  it('filters by band', () => {
    q.insertQso({ ...QSO, call: 'OH2BH', band: '40' });
    const rows = q.getQsos({ band: '40' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'OH2BH');
  });

  it('filters by mode', () => {
    q.insertQso({ ...QSO, call: 'VK2BNG', mode: 'SSB' });
    const rows = q.getQsos({ mode: 'SSB' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'VK2BNG');
  });

  it('filters by operator', () => {
    q.insertQso({ ...QSO, call: 'PA0RCT', operator: 'W1OP' });
    const rows = q.getQsos({ operator: 'W1OP' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].call, 'PA0RCT');
  });

  it('combines multiple filters', () => {
    const rows = q.getQsos({ band: '20', mode: 'CW' });
    // DL1ABC, JA1YXZ (both 20m CW) — OH2BH is 40m, VK2BNG is SSB, PA0RCT has different op
    assert.ok(rows.every((r) => r.band === '20' && r.mode === 'CW'));
  });

  it('deletes a QSO', () => {
    const before = q.getQsos().length;
    q.deleteQso({ call: 'JA1YXZ', band: '20', mode: 'CW', contestname: 'CQ-WPX-CW', mycall: 'K1TTT' });
    assert.equal(q.getQsos().length, before - 1);
    assert.ok(!q.getQsos().find((r) => r.call === 'JA1YXZ'));
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

  it('ignores extra parser fields (is_transmitting, active_radio) without error', () => {
    // If extra fields caused an error the upsert above would have thrown.
    assert.ok(true);
  });
});

describe('score_snapshots', () => {
  it('inserts a score snapshot', () => {
    q.insertScore(SCORE);
    const s = q.getLatestScore();
    assert.ok(s);
    assert.equal(s.contest, 'CQ-WPX-CW');
    assert.equal(s.qsos, 42);
    assert.equal(s.total, 1890);
  });

  it('getLatestScore returns the most recent row', () => {
    q.insertScore({ ...SCORE, qsos: 50, points: 150, total: 2250 });
    const s = q.getLatestScore();
    assert.equal(s.qsos, 50);
    assert.equal(s.total, 2250);
  });

  it('getScoreHistory returns all rows in chronological order', () => {
    const history = q.getScoreHistory();
    assert.ok(history.length >= 2);
    // Must be ascending by captured_at
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i].captured_at >= history[i - 1].captured_at);
    }
  });

  it('clearQsos also clears score_snapshots', () => {
    q.clearQsos();
    assert.equal(q.getLatestScore(), null);
    assert.equal(q.getScoreHistory().length, 0);
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
