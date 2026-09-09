const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderReport } = require('../../public/js/report');

function qso(o) {
  return {
    call: 'W1AW', band: '14', mode: 'CW', operator: '', points: 0,
    is_mult1: 0, is_mult2: 0, is_mult3: 0, is_run_qso: 0,
    continent: 'NA', zone: '5', countryprefix: 'K', section: '',
    n1mm_timestamp: '2025-05-24 12:00:00', logged_at: '2025-05-24 12:00:00',
    ...o,
  };
}

describe('renderReport', () => {
  const qsos = [
    qso({ call: 'K3LR', n1mm_timestamp: '2025-05-24 12:00:00' }),
    qso({ call: 'DL1XYZ', band: '7', mode: 'SSB', countryprefix: 'DL', continent: 'EU', zone: '14', section: 'BW', n1mm_timestamp: '2025-05-24 12:40:00' }),
    qso({ call: 'JA1ABC', band: '7', mode: 'CW', countryprefix: 'JA', continent: 'AS', zone: '25', section: 'TKY', n1mm_timestamp: '2025-05-24 13:10:00' }),
  ];

  it('produces a self-contained HTML document with the headline numbers', () => {
    const html = renderReport({ meta: { station_call: 'K3LR', contest: 'CQ-WPX-CW', filename: 'k3lr.cbr' }, qsos });
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<style>/); // inline CSS, no external refs
    assert.doesNotMatch(html, /<link|<script/i);
    assert.match(html, /CQ-WPX-CW — K3LR/);
    assert.match(html, />3<\/b><span>QSOs/); // 3 QSOs tile
    assert.match(html, /DXCC/);
    assert.match(html, /20m/); // band label rendered
    assert.match(html, /40m/);
  });

  it('omits points/mults tiles + column when the source lacks them', () => {
    const noPts = renderReport({ meta: { station_call: 'K3LR' }, qsos });
    assert.doesNotMatch(noPts, /<span>Points<\/span>/);

    const withPts = renderReport({
      meta: { station_call: 'K3LR', has_points: true, has_mults: true },
      qsos: qsos.map((q, i) => ({ ...q, points: i + 1, is_mult1: i % 2 })),
    });
    assert.match(withPts, /<span>Points<\/span>/);
    assert.match(withPts, /<span>Mults<\/span>/);
  });

  it('lists sections worked when present', () => {
    const html = renderReport({ meta: { station_call: 'K3LR' }, qsos });
    assert.match(html, /Sections \/ exchanges worked — 2/);
    assert.match(html, /<b>BW<\/b>/);
    assert.match(html, /<b>TKY<\/b>/);
  });

  it('escapes untrusted meta fields', () => {
    const html = renderReport({ meta: { station_call: '<script>x</script>', contest: 'A&B' }, qsos });
    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /A&amp;B/);
  });
});
