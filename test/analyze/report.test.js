const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderReport, renderReportText } = require('../../public/js/report');

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

describe('renderReportText', () => {
  const qsos = [
    qso({ call: 'K3LR', n1mm_timestamp: '2025-05-24 12:00:00' }),
    qso({ call: 'DL1XYZ', band: '7', mode: 'SSB', countryprefix: 'DL', continent: 'EU', zone: '14', section: 'BW', n1mm_timestamp: '2025-05-24 12:40:00' }),
    qso({ call: 'JA1ABC', band: '7', mode: 'CW', countryprefix: 'JA', continent: 'AS', zone: '25', section: 'TKY', n1mm_timestamp: '2025-05-24 13:10:00' }),
  ];

  it('is plain text -- no markup, no HTML entities', () => {
    const txt = renderReportText({ meta: { station_call: 'K3LR', contest: 'CQ-WPX-CW', filename: 'k3lr.cbr' }, qsos });
    assert.doesNotMatch(txt, /[<>]|&amp;|&middot;|&lt;/);
    assert.equal(typeof txt, 'string');
  });

  it('leads with the title and the same headline numbers as the HTML report', () => {
    const txt = renderReportText({ meta: { station_call: 'K3LR', contest: 'CQ-WPX-CW' }, qsos });
    assert.match(txt, /^CQ-WPX-CW — K3LR\n=+\n/);
    assert.match(txt, /QSOs \.+ 3/);
    assert.match(txt, /DXCC \.+ 3/);
    assert.match(txt, /Bands \.+ 2/);
  });

  it('renders an At a Glance block like the stats page (Avg rate, Elapsed)', () => {
    const txt = renderReportText({ meta: { station_call: 'K3LR' }, qsos });
    assert.match(txt, /\nAt a Glance\nQSOs \.+ 3\n/);
    assert.match(txt, /Avg rate \.+ \d+\/h/);
    assert.match(txt, /Hours active \.+ 2/);
    assert.match(txt, /Elapsed \.+ 1h 10m/); // 12:00z -> 13:10z
  });

  it('renders a Rate Records block: first/last, best windows, longest gap', () => {
    const txt = renderReportText({ meta: { station_call: 'K3LR' }, qsos });
    assert.match(txt, /\nRate Records\n/);
    assert.match(txt, /First QSO \.+ 05\/24 12:00z/);
    assert.match(txt, /Last QSO \.+ 05\/24 13:10z/);
    assert.match(txt, /Best clock hour \.+ 2 Q \(12:00z\)/);
    assert.match(txt, /Best 60 min \.+ 2 Q \(from 05\/24 12:00z\)/);
    assert.match(txt, /Longest gap \.+ 40m \(from 05\/24 12:00z\)/);
  });

  it('omits Rate Records when there are not two timestamps', () => {
    const txt = renderReportText({
      meta: { station_call: 'K3LR' },
      qsos: [qso({ n1mm_timestamp: '', logged_at: '' })],
    });
    assert.doesNotMatch(txt, /\nRate Records\n/);
    assert.match(txt, /\nAt a Glance\n/); // still present
  });

  it('renders fixed-width band/mode, hourly and DXCC tables', () => {
    const txt = renderReportText({ meta: { station_call: 'K3LR' }, qsos });
    assert.match(txt, /QSOs by band & mode\nBand +CW +PH +Total\n-+\n/);
    assert.match(txt, /40m +1 +1 +2/);
    assert.match(txt, /20m +1 +0 +1/);
    assert.match(txt, /Total +2 +1 +3/);
    assert.match(txt, /\nHourly\nHour \(UTC\) +Q +Cum\n/);
    assert.match(txt, /\nTop DXCC entities\nDXCC \(3 worked\) +Q +Bands\n/);
  });

  it('adds a Points column only when the source has points', () => {
    const noPts = renderReportText({ meta: { station_call: 'K3LR' }, qsos });
    assert.doesNotMatch(noPts, /Points/);
    assert.doesNotMatch(noPts, /Pts \/ QSO/);

    const withPts = renderReportText({
      meta: { station_call: 'K3LR', has_points: true, has_mults: true },
      qsos: qsos.map((q, i) => ({ ...q, points: (i + 1) * 2, is_mult1: i % 2 })),
    });
    assert.match(withPts, /Band +CW +PH +Total +Points\n/);
    assert.match(withPts, /Points \.+ 12/);
    assert.match(withPts, /Mults \.+ 1/);
  });

  it('lists sections worked, wrapped, when present; omits the block otherwise', () => {
    const txt = renderReportText({ meta: { station_call: 'K3LR' }, qsos });
    assert.match(txt, /Sections \/ exchanges worked — 2\nBW 1 +TKY 1/);

    const noSec = renderReportText({
      meta: { station_call: 'K3LR' },
      qsos: qsos.map((q) => ({ ...q, section: '' })),
    });
    assert.doesNotMatch(noSec, /Sections \/ exchanges worked/);
  });

  it('drops the hourly / DXCC blocks when the data is absent', () => {
    const bare = renderReportText({
      meta: { station_call: 'K3LR' },
      qsos: [qso({ n1mm_timestamp: '', logged_at: '', countryprefix: '' })],
    });
    assert.doesNotMatch(bare, /\nHourly\n/);
    assert.doesNotMatch(bare, /\nTop DXCC entities\n/);
    assert.match(bare, /QSOs by band & mode/); // this one always renders
  });
});
