const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildManualCabrillo, parseManualLines } = require('../../public/js/manual');
const { analyzeLog } = require('../../src/analyze');

describe('parseManualLines', () => {
  it('accepts a bare callsign', () => {
    assert.deepEqual(parseManualLines('W1AW'), [{ call: 'W1AW', band: '', time: '', exch: '' }]);
  });

  it('reads an optional leading HHMM and a band token', () => {
    assert.deepEqual(parseManualLines('1307 40m K5ZD RANDY MA'), [
      { call: 'K5ZD', band: '40m', time: '1307', exch: 'RANDY MA' },
    ]);
    assert.deepEqual(parseManualLines('903 W1AW'), [
      { call: 'W1AW', band: '', time: '0903', exch: '' },
    ]);
  });

  it('passes raw QSO: / ADIF lines straight through', () => {
    const r = parseManualLines('QSO: 14000 CW 2025-01-01 1300 K3LR 599 W1AW 599\n<call:4>K5ZD<eor>');
    assert.equal(r[0].passthrough, true);
    assert.equal(r[1].passthrough, true);
  });

  it('skips blank lines, comments and junk', () => {
    assert.deepEqual(parseManualLines('\n# a note\nnot-a-call here\nW1AW'), [
      { call: 'W1AW', band: '', time: '', exch: '' },
    ]);
  });
});

describe('buildManualCabrillo -> analyzeLog round trip', () => {
  it('a CWT session entered as "call name spc" comes back with exchange parsed', () => {
    const cbr = buildManualCabrillo({
      contest: 'CWT', mycall: 'k3lr', myexch: 'TIM PA',
      band: '20m', mode: 'CW', date: '2026-09-09',
      qsos: 'W1AW BOB CT\n1307 K5ZD RANDY MA\n40m DL1XYZ HANS DL',
    });
    const { meta, qsos } = analyzeLog(cbr, 'manual.cbr');

    assert.equal(meta.format, 'cabrillo');
    assert.equal(meta.contest_key, 'CWT');
    assert.equal(meta.exchange_parsed, true);
    assert.equal(meta.station_call, 'K3LR');
    assert.equal(qsos.length, 3);

    assert.deepEqual(qsos.map((q) => q.call), ['W1AW', 'K5ZD', 'DL1XYZ']);
    assert.deepEqual(qsos.map((q) => q.band), ['14', '14', '7']); // 40m override on line 3
    assert.equal(qsos[0].op_name, 'BOB');
    assert.equal(qsos[0].section, 'CT');
    assert.equal(qsos[1].n1mm_timestamp, '2026-09-09 13:07:00');
    // cty enrichment still runs on the synthesized log
    assert.equal(qsos[2].continent, 'EU');
    assert.equal(qsos[2].countryprefix, 'DL');
  });

  it('defaults sent exchange to 599 and works for an unknown contest', () => {
    const cbr = buildManualCabrillo({
      contest: 'CLUB-TEST', mycall: 'K3LR', band: '40m', mode: 'CW', date: '2026-01-01',
      qsos: 'W1AW\nK5ZD',
    });
    const { meta, qsos } = analyzeLog(cbr, 'm.cbr');
    assert.equal(meta.contest_key, null);
    assert.equal(qsos.length, 2);
    assert.equal(qsos[0].band, '7');
  });

  it('honours passthrough QSO: lines alongside shorthand', () => {
    const cbr = buildManualCabrillo({
      mycall: 'K3LR', band: '20m', mode: 'CW', date: '2026-01-01',
      qsos: 'W1AW\nQSO: 7025 CW 2026-01-01 0100 K3LR 599 05 JA1ABC 599 25',
    });
    const { qsos } = analyzeLog(cbr, 'm.cbr');
    assert.equal(qsos.length, 2);
    assert.ok(qsos.some((q) => q.call === 'JA1ABC' && q.band === '7'));
  });
});
