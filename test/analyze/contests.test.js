const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeLog } = require('../../src/analyze');
const { specForContest, normalizeContest } = require('../../src/analyze/contests');

// Minimal Cabrillo: a CONTEST header + QSO lines. analyzeLog runs the full
// pipeline (parse -> exchange spec -> cty enrich), which is what matters.
function log(contest, ...qsoLines) {
  return [`CONTEST: ${contest}`, 'CALLSIGN: K3LR', ...qsoLines].join('\n');
}
function first(contest, ...lines) {
  return analyzeLog(log(contest, ...lines), 'x.cbr');
}

describe('specForContest / normalizeContest', () => {
  it('normalises spaces and underscores to dashes', () => {
    assert.equal(normalizeContest('CQ WW CW'), 'CQ-WW-CW');
    assert.equal(normalizeContest('cq_wpx_cw'), 'CQ-WPX-CW');
  });
  it('matches known keys, misses unknown', () => {
    assert.equal(specForContest('CQ-WW-CW').key, 'CQ-WW');
    assert.equal(specForContest('ARRL-DX-SSB').key, 'ARRL-DX');
    assert.equal(specForContest('CALIFORNIA-QSO-PARTY').key, 'QSO-PARTY');
    assert.equal(specForContest('SOME-RANDOM-THING'), null);
  });
});

describe('exchange parsing per contest', () => {
  it('CQ WW — RST + zone', () => {
    const { meta, qsos } = first('CQ-WW-CW',
      'QSO: 14042 CW 2024-11-23 1200 K3LR 599 05 DL1XYZ 599 14');
    assert.equal(meta.contest_key, 'CQ-WW');
    assert.equal(meta.exchange_parsed, true);
    assert.equal(qsos[0].call, 'DL1XYZ');
    assert.equal(qsos[0].zone, '14'); // from the exchange, not cty's default
  });

  it('CQ WPX — RST + serial', () => {
    const { qsos } = first('CQ-WPX-SSB',
      'QSO: 14042 PH 2025-05-24 1200 K3LR 59 001 DL1XYZ 59 102');
    assert.equal(qsos[0].call, 'DL1XYZ');
    assert.equal(qsos[0].rcv_nr, '102');
  });

  it('WAE — RST + serial', () => {
    const { meta, qsos } = first('WAEDC-CW',
      'QSO: 7025 CW 2025-08-09 1200 K3LR 599 0001 DL1XYZ 599 0042');
    assert.equal(meta.contest_key, 'WAE');
    assert.equal(qsos[0].rcv_nr, '0042');
  });

  it('CQ 160 — RST + location', () => {
    const { qsos } = first('CQ-160-CW',
      'QSO: 1825 CW 2025-01-24 0200 K3LR 599 PA W1AW 599 CT');
    assert.equal(qsos[0].call, 'W1AW');
    assert.equal(qsos[0].section, 'CT');
  });

  it('ARRL Sweepstakes — serial / prec / check / section', () => {
    const { meta, qsos } = first('ARRL-SS-CW',
      'QSO: 14042 CW 2024-11-02 2100 K3LR 12 A 72 WPA W1AW 34 B 74 CT');
    assert.equal(meta.contest_key, 'ARRL-SS');
    assert.equal(qsos[0].call, 'W1AW');
    assert.equal(qsos[0].rcv_nr, '34');
    assert.equal(qsos[0].prec, 'B');
    assert.equal(qsos[0].ck, '74');
    assert.equal(qsos[0].section, 'CT');
  });

  it('ARRL Field Day — class + section (no RST)', () => {
    const { qsos } = first('ARRL-FIELD-DAY',
      'QSO: 14042 CW 2025-06-28 1800 K3LR 3A WPA W1AW 5A EMA');
    assert.equal(qsos[0].call, 'W1AW');
    assert.equal(qsos[0].exchange1, '5A');
    assert.equal(qsos[0].section, 'EMA');
  });

  it('ARRL DX — asymmetric: a US station receives DX power', () => {
    // K3LR resolves to a K prefix -> domestic -> we send state, receive power
    const { qsos } = first('ARRL-DX-CW',
      'QSO: 14042 CW 2025-02-15 1200 K3LR 599 PA DL1XYZ 599 1000');
    assert.equal(qsos[0].call, 'DL1XYZ');
    assert.equal(qsos[0].power, '1000');
    assert.equal(qsos[0].section, ''); // not a section contest from this side
  });

  it('ARRL DX — a DX station receives US state', () => {
    const { qsos } = analyzeLog(
      ['CONTEST: ARRL-DX-CW', 'CALLSIGN: DL1XYZ',
        'QSO: 14042 CW 2025-02-15 1200 DL1XYZ 599 1000 K3LR 599 PA'].join('\n'),
      'dx.cbr');
    assert.equal(qsos[0].call, 'K3LR');
    assert.equal(qsos[0].section, 'PA');
  });

  it('ARRL RTTY Roundup — state vs serial per token', () => {
    const a = first('ARRL-RTTY-ROUNDUP',
      'QSO: 14085 RY 2025-01-04 1800 K3LR 599 PA W1AW 599 CT');
    assert.equal(a.qsos[0].section, 'CT');
    const b = first('ARRL-RTTY-ROUNDUP',
      'QSO: 14085 RY 2025-01-04 1800 K3LR 599 PA DL1XYZ 599 123');
    assert.equal(b.qsos[0].rcv_nr, '123');
  });

  it('NAQP — name + location, no RST', () => {
    const { meta, qsos } = first('NAQP-CW',
      'QSO: 7025 CW 2025-01-11 1900 K3LR TIM PA W1AW BOB CT');
    assert.equal(meta.contest_key, 'NAQP');
    assert.equal(qsos[0].call, 'W1AW');
    assert.equal(qsos[0].op_name, 'BOB');
    assert.equal(qsos[0].section, 'CT');
  });

  it('NA Sprint — serial + name + location', () => {
    const { qsos } = first('NA-SPRINT-CW',
      'QSO: 7025 CW 2025-02-01 0100 K3LR 12 TIM PA W1AW 34 BOB CT');
    assert.equal(qsos[0].call, 'W1AW');
    assert.equal(qsos[0].rcv_nr, '34');
    assert.equal(qsos[0].op_name, 'BOB');
    assert.equal(qsos[0].section, 'CT');
  });

  it('IARU HF — zone or HQ abbreviation', () => {
    const z = first('IARU-HF',
      'QSO: 14042 CW 2025-07-12 1200 K3LR 599 08 DL1XYZ 599 28');
    assert.equal(z.qsos[0].zone, '28');
    const hq = first('IARU-HF',
      'QSO: 14042 CW 2025-07-12 1200 K3LR 599 08 DA0HQ 599 DARC');
    assert.equal(hq.qsos[0].section, 'DARC');
  });

  it('Stew Perry — grid only', () => {
    const { meta, qsos } = first('STEW-PERRY',
      'QSO: 1825 CW 2024-12-28 0300 K3LR FN00 W1AW FN31');
    assert.equal(meta.contest_key, 'STEW-PERRY');
    assert.equal(qsos[0].call, 'W1AW');
    assert.equal(qsos[0].gridsquare, 'FN31');
  });

  it('State QSO Party — flexible: RST, serial, county/state', () => {
    const { meta, qsos } = first('NEW-YORK-QSO-PARTY',
      'QSO: 7025 CW 2025-10-18 1600 K3LR 599 0012 PA W2XYZ 599 0034 ONO');
    assert.equal(meta.contest_key, 'QSO-PARTY');
    assert.equal(qsos[0].call, 'W2XYZ');
    assert.equal(qsos[0].rcv_nr, '0034');
    assert.equal(qsos[0].section, 'ONO');
  });

  it('unknown contest — heuristic call, no exchange fields, flags false', () => {
    const { meta, qsos } = first('SOME-CLUB-TEST',
      'QSO: 14042 CW 2025-03-01 1200 K3LR 599 001 DL1XYZ 599 002');
    assert.equal(meta.contest_key, null);
    assert.equal(meta.exchange_parsed, false);
    assert.equal(qsos[0].call, 'DL1XYZ'); // symmetric-split heuristic still works
  });

  it('tolerates a trailing transmitter-id after a known exchange', () => {
    const { qsos } = first('CQ-WW-CW',
      'QSO: 14042 CW 2024-11-23 1200 K3LR 599 05 DL1XYZ 599 14 0');
    assert.equal(qsos[0].call, 'DL1XYZ');
    assert.equal(qsos[0].zone, '14');
  });

  it('strips the internal _exchTokens scratch field', () => {
    const { qsos } = first('CQ-WW-CW',
      'QSO: 14042 CW 2024-11-23 1200 K3LR 599 05 DL1XYZ 599 14');
    assert.equal('_exchTokens' in qsos[0], false);
  });
});
