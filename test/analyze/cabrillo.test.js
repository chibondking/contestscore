const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCabrillo, freqToBand, normMode, toTimestamp } = require('../../src/analyze/cabrillo');

const LOG = `START-OF-LOG: 3.0
CALLSIGN: WT2P
CONTEST: CQ-WPX-CW
OPERATORS: WT2P K3LR
CLAIMED-SCORE: 123456
QSO: 14042 CW 2025-05-24 1200 WT2P 599 0001 K3LR 599 0044
QSO: 14043 CW 2025-05-24 1201 WT2P 599 0002 DL1XYZ 599 0102
QSO:  7025 CW 2025-05-24 1305 WT2P 599 0003 JA1ABC 599 0555
QSO: 21000 PH 2025-05-24 1400 WT2P 59 0004 VK3AA 59 0300
X-QSO: 14042 CW 2025-05-24 1200 WT2P 599 0001 K3LR 599 0044
END-OF-LOG:
`;

describe('parseCabrillo', () => {
  const { meta, qsos, flags } = parseCabrillo(LOG);

  it('reads header metadata', () => {
    assert.equal(meta.format, 'cabrillo');
    assert.equal(meta.contest, 'CQ-WPX-CW');
    assert.equal(meta.station_call, 'WT2P');
    assert.equal(meta.operators, 'WT2P K3LR');
    assert.equal(meta.claimed_score, 123456);
  });

  it('parses QSO lines and marks X-QSO as excluded', () => {
    assert.equal(qsos.length, 5);
    assert.equal(qsos.filter((q) => q.excluded).length, 1);
    assert.equal(qsos[qsos.length - 1].excluded, 1);
  });

  it('extracts the worked call from a symmetric exchange', () => {
    assert.deepEqual(qsos.slice(0, 4).map((q) => q.call), ['K3LR', 'DL1XYZ', 'JA1ABC', 'VK3AA']);
  });

  it('snaps frequency to a canonical band (14042 and 14043 both -> "14")', () => {
    assert.equal(qsos[0].band, '14');
    assert.equal(qsos[1].band, '14');
    assert.equal(qsos[2].band, '7');
    assert.equal(qsos[3].band, '21');
  });

  it('normalises mode and builds a UTC timestamp', () => {
    assert.equal(qsos[0].mode, 'CW');
    assert.equal(qsos[3].mode, 'SSB');
    assert.equal(qsos[0].n1mm_timestamp, '2025-05-24 12:00:00');
    assert.equal(qsos[0].logged_at, qsos[0].n1mm_timestamp);
  });

  it('leaves points / mults / operator / run empty and flags them false', () => {
    assert.equal(flags.has_points, false);
    assert.equal(flags.has_mults, false);
    assert.equal(flags.has_operator, false);
    assert.equal(flags.has_run_flag, false);
    assert.equal(qsos[0].points, 0);
    assert.equal(qsos[0].operator, '');
  });

  it('tolerates a trailing transmitter-id digit', () => {
    const { qsos: q } = parseCabrillo(
      'QSO: 14042 CW 2025-05-24 1200 WT2P 599 05 K3LR 599 05 0\n',
    );
    assert.equal(q[0].call, 'K3LR');
  });

  it('handles an RST-only exchange', () => {
    const { qsos: q } = parseCabrillo(
      'QSO: 7010 CW 2025-05-24 1200 WT2P 599 G3XYZ 599\n',
    );
    assert.equal(q[0].call, 'G3XYZ');
    assert.equal(q[0].band, '7');
  });

  it('freqToBand handles kHz, MHz tokens and junk', () => {
    assert.equal(freqToBand('14042'), '14');
    assert.equal(freqToBand('7025'), '7');
    assert.equal(freqToBand('50'), '50');
    assert.equal(freqToBand('144'), '144');
    assert.equal(freqToBand('LIGHT'), 'LIGHT');
  });

  it('normMode maps Cabrillo tokens', () => {
    assert.equal(normMode('PH'), 'SSB');
    assert.equal(normMode('RY'), 'RTTY');
    assert.equal(normMode('cw'), 'CW');
  });

  it('toTimestamp accepts dashed or bare dates', () => {
    assert.equal(toTimestamp('2025-05-24', '1200'), '2025-05-24 12:00:00');
    assert.equal(toTimestamp('20250524', '120059'), '2025-05-24 12:00:59');
    assert.equal(toTimestamp('bad', '1200'), '');
  });
});
