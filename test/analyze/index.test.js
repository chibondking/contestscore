const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { analyzeLog, detectFormat, newId } = require('../../src/analyze');

const CABRILLO = `START-OF-LOG: 3.0
CALLSIGN: WT2P
CONTEST: CQ-WPX-CW
QSO: 14042 CW 2025-05-24 1200 WT2P 599 0001 K3LR 599 0044
QSO:  7025 CW 2025-05-24 1305 WT2P 599 0003 JA1ABC 599 0555
X-QSO: 14042 CW 2025-05-24 1200 WT2P 599 0001 DL1XYZ 599 0044
END-OF-LOG:
`;

const ADIF = `<EOH>
<CALL:4>K3LR<QSO_DATE:8>20250524<TIME_ON:6>120000<BAND:3>20m<MODE:2>CW<OPERATOR:4>WT2P<APP_N1MM_POINTS:1>2<EOR>
<CALL:6>JA1ABC<QSO_DATE:8>20250524<TIME_ON:6>130500<BAND:3>40m<MODE:2>CW<OPERATOR:4>WT2P<APP_N1MM_POINTS:1>3<EOR>
`;

describe('detectFormat', () => {
  it('recognises Cabrillo and ADIF, rejects junk', () => {
    assert.equal(detectFormat(CABRILLO), 'cabrillo');
    assert.equal(detectFormat(ADIF), 'adif');
    assert.equal(detectFormat('just some text\nnot a log'), null);
  });
});

describe('newId', () => {
  it('is a 10-char url-safe slug, unique across calls', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i += 1) {
      const id = newId();
      assert.match(id, /^[A-Za-z0-9]{10}$/);
      ids.add(id);
    }
    assert.equal(ids.size, 200);
  });
});

describe('analyzeLog', () => {
  it('parses Cabrillo, drops X-QSO, and enriches from cty.csv', () => {
    const { meta, qsos, excluded } = analyzeLog(CABRILLO, 'wt2p.cbr');
    assert.equal(meta.format, 'cabrillo');
    assert.equal(meta.filename, 'wt2p.cbr');
    assert.equal(meta.qso_count, 2);
    assert.equal(meta.excluded_count, 1);
    assert.equal(meta.has_points, false);
    // X-QSO surfaced as a compact removed-QSO row, not in the main array
    assert.equal(excluded.length, 1);
    assert.equal(excluded[0].call, 'DL1XYZ');
    assert.equal(excluded[0].band, '14');
    assert.ok(qsos.every((q) => q.call !== 'DL1XYZ'));
    // cty enrichment ran
    assert.equal(qsos[0].call, 'K3LR');
    assert.equal(qsos[0].continent, 'NA');
    assert.equal(qsos[0].countryprefix, 'K');
    assert.equal(qsos[1].continent, 'AS');
  });

  it('reports the matched contest key / exchange_parsed', () => {
    const { meta } = analyzeLog(CABRILLO, 'wt2p.cbr'); // CONTEST: CQ-WPX-CW
    assert.equal(meta.contest_key, 'CQ-WPX');
    assert.equal(meta.exchange_parsed, true);

    const unknown = analyzeLog(
      'CONTEST: LOCAL-CLUB-TEST\nQSO: 14042 CW 2025-05-24 1200 WT2P 599 001 K3LR 599 002\n',
      'x');
    assert.equal(unknown.meta.contest_key, null);
    assert.equal(unknown.meta.exchange_parsed, false);
  });

  it('parses ADIF and reports has_points', () => {
    const { meta, qsos } = analyzeLog(ADIF, 'wt2p.adi');
    assert.equal(meta.format, 'adif');
    assert.equal(meta.qso_count, 2);
    assert.equal(meta.has_points, true);
    assert.equal(qsos[0].points, 2);
  });

  it('throws BAD_FORMAT on unrecognised input', () => {
    assert.throws(() => analyzeLog('hello world', 'x.txt'), (err) => err.code === 'BAD_FORMAT');
  });

  it('every QSO has the full field shape the renderers expect', () => {
    const { qsos } = analyzeLog(CABRILLO, 'x');
    const required = ['call', 'band', 'mode', 'operator', 'points', 'is_mult1',
      'is_mult2', 'is_mult3', 'is_run_qso', 'continent', 'zone', 'countryprefix',
      'section', 'n1mm_timestamp', 'logged_at'];
    for (const q of qsos) {
      for (const k of required) assert.ok(k in q, `missing ${k}`);
      assert.equal('excluded' in q, false, 'excluded flag should be stripped');
      assert.equal('_exchTokens' in q, false, '_exchTokens scratch should be stripped');
    }
  });
});
