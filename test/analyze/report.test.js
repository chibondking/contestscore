const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { renderReport, renderReportText, dedupeQsos } = require('../../public/js/report');

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

// WAE: a QTC is a relayed traffic report about an earlier QSO, not a new
// contact -- N1MM marks it via exchange1 = "SQTC"/"RQTC", sharing the
// parent QSO's call/band/mode (real capture: several QTCs in a row, same
// station, seconds apart). None of these should count as an extra QSO,
// DXCC/section "worked", or inflate a rate record -- but their points
// still belong in the total, since WAE genuinely scores that traffic.
describe('QTC handling (WAE)', () => {
  const qsos = [
    qso({ call: 'RU1A', band: '21', mode: 'USB', countryprefix: 'UA', zone: '17', section: 'UA', points: 1, n1mm_timestamp: '2025-09-13 16:20:00' }),
    qso({ call: 'RU1A', band: '21', mode: 'USB', countryprefix: 'UA', zone: '17', section: 'UA', points: 1, exchange1: 'SQTC', n1mm_timestamp: '2025-09-13 16:20:05' }),
    qso({ call: 'RU1A', band: '21', mode: 'USB', countryprefix: 'UA', zone: '17', section: 'UA', points: 1, exchange1: 'SQTC', n1mm_timestamp: '2025-09-13 16:20:10' }),
    qso({ call: 'RU1A', band: '21', mode: 'USB', countryprefix: 'UA', zone: '17', section: 'UA', points: 1, exchange1: 'SQTC', n1mm_timestamp: '2025-09-13 16:20:15' }),
    qso({ call: 'PA6Y', band: '14', mode: 'USB', countryprefix: 'PA', zone: '14', section: 'PA', points: 1, n1mm_timestamp: '2025-09-13 17:00:00' }),
    qso({ call: 'PA6Y', band: '14', mode: 'USB', countryprefix: 'PA', zone: '14', section: 'PA', points: 1, exchange1: 'RQTC', n1mm_timestamp: '2025-09-13 17:00:05' }),
  ];
  const meta = { station_call: 'WT2P', has_points: true };

  it('excludes QTCs from the QSO count, but sums their points into the total', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /QSOs \.+ 2\n/); // 2 real QSOs -- RU1A and PA6Y
    assert.match(txt, /QTCs \.+ 4\n/); // 3 SQTC + 1 RQTC
    assert.match(txt, /Points \.+ 6\n/); // every row's points, QTCs included
  });

  it('shows the QTC count in the report sub-header, separate from QSOs', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /2 QSOs \+ 4 QTCs/);
    const html = renderReport({ meta, qsos });
    assert.match(html, /2 QSOs \+ 4 QTCs/);
  });

  it('gives the band/mode table its own QTC column instead of inflating Total-as-contacts', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /Band +PH +QTC +Total +Points\n/);
    assert.match(txt, /15m +1 +3 +4 +4\n/); // RU1A: 1 real QSO + 3 QTCs, 4 points
    assert.match(txt, /20m +1 +1 +2 +2\n/); // PA6Y: 1 real QSO + 1 QTC, 2 points
    assert.match(txt, /Total +2 +4 +6 +6\n/);
  });

  it('does not count QTCs toward DXCC/section "worked" totals', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /Top DXCC entities\nDXCC \(2 worked\)/);
    assert.match(txt, /Sections \/ exchanges worked — 2\nPA 1 +UA 1/);
  });

  it('does not let a QTC burst inflate the hourly/rate-record counts', () => {
    const txt = renderReportText({ meta, qsos });
    // Without the exclusion 16z would read "4 Q" (1 QSO + 3 QTCs seconds
    // apart) and Best 10 min would report a fake 4-in-10-minutes record.
    assert.match(txt, /16:00z +1 +1\n/);
    assert.match(txt, /17:00z +1 +2\n/);
    assert.match(txt, /Best 10 min \.+ 1 Q/);
  });
});

// A real bug, not hypothetical: confirmed live 2026-09-28 on a CQ WW RTTY
// log (no WAE QTC mechanism at all -- isQtc matches zero rows) that still
// reported "2 QTCs". qtcCount was computed as qsos.length minus the
// deduped, non-QTC count -- which also silently absorbs genuine
// same-call/band/mode repeat contacts (dedupeQsos's OWN job, nothing to do
// with QTCs) into that subtraction. The real cause: one station worked 3
// times on the same band/mode, N1MM correctly crediting only the first with
// points, and the other two got mislabeled "QTCs" by the subtraction.
describe('a genuine same-station repeat is never counted as a QTC', () => {
  const qsos = [
    // CR3W worked 3 times on the same band/mode -- 2 later repeats score 0,
    // same shape as the real capture. None of these carry exchange1 =
    // "QTC" -- isQtc must never match any of them.
    qso({ call: 'CR3W', band: '40', mode: 'RTTY', countryprefix: 'CT3', points: 3, n1mm_timestamp: '2026-09-26 08:23:26' }),
    qso({ call: 'CR3W', band: '40', mode: 'RTTY', countryprefix: 'CT3', points: 0, n1mm_timestamp: '2026-09-26 08:25:20' }),
    qso({ call: 'CR3W', band: '40', mode: 'RTTY', countryprefix: 'CT3', points: 0, n1mm_timestamp: '2026-09-27 21:37:19' }),
    // A real QTC, present in the same log, to prove the fix still counts an
    // actual QTC correctly rather than just returning 0 unconditionally.
    qso({ call: 'PA6Y', band: '20', mode: 'RTTY', countryprefix: 'PA', points: 1, n1mm_timestamp: '2026-09-26 09:00:00' }),
    qso({ call: 'PA6Y', band: '20', mode: 'RTTY', countryprefix: 'PA', points: 1, exchange1: 'RQTC', n1mm_timestamp: '2026-09-26 09:00:05' }),
  ];
  const meta = { station_call: 'WT9P', has_points: true };

  it('QSO/QTC counts reflect what isQtc actually matched, not a subtraction', () => {
    const txt = renderReportText({ meta, qsos });
    // 2 real QSOs (CR3W once, PA6Y once) -- the 2 CR3W repeats are dupes,
    // dropped from the count entirely, not relabeled.
    assert.match(txt, /QSOs \.+ 2\n/);
    assert.match(txt, /QTCs \.+ 1\n/); // only PA6Y's real RQTC row
  });

  it('the sub-header never says "2 QTCs" for zero real QTC rows plus two dupes', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /2 QSOs \+ 1 QTCs/);
    assert.doesNotMatch(txt, /\+ 2 QTCs/);
  });

  // The exact reported case, isolated: a contest with no QTC mechanism at
  // all (CQ WW RTTY), a log that happens to contain repeats. No QTC line,
  // tile, or column should appear anywhere -- not a QTC count of 2.
  it('a log with dupes but ZERO real QTCs shows no QTC count anywhere', () => {
    const noQtc = qsos.filter((q) => !/QTC/i.test(q.exchange1 || ''));
    const txt = renderReportText({ meta, qsos: noQtc });
    assert.doesNotMatch(txt, /QTCs/);
    assert.doesNotMatch(txt, /QTC/);
    const html = renderReport({ meta, qsos: noQtc });
    assert.doesNotMatch(html, /QTCs/);
  });
});

describe('dedupeQsos', () => {
  it('drops a genuine dupe (same call/band/mode worked twice), keeping the earlier QSO', () => {
    const first = qso({ n1mm_timestamp: '2025-05-24 12:00:00', points: 1, is_mult1: 1 });
    const second = qso({ n1mm_timestamp: '2025-05-24 12:10:00', points: 0, is_mult1: 0 }); // the dupe
    const out = dedupeQsos([first, second]);
    assert.equal(out.length, 1);
    assert.equal(out[0], first);
  });

  it('does not touch a re-work on a different band or mode', () => {
    const a = qso({ band: '14' });
    const b = qso({ band: '7' });
    assert.deepEqual(dedupeQsos([a, b]), [a, b]);
  });

  it('keeps a row with no parseable timestamp rather than risk dropping a real QSO', () => {
    const noTime = qso({ n1mm_timestamp: '', logged_at: '' });
    const anotherNoTime = qso({ n1mm_timestamp: '', logged_at: '' });
    assert.equal(dedupeQsos([noTime, anotherNoTime]).length, 2);
  });
});

// A genuine dupe (not a QTC -- see the isQtc block above, which already
// covers that case) reported live: 64 rows logged, 2 of them a repeat
// working of the same station on the same band/mode, N1MM's own score
// correctly counting 62. Before dedupeQsos, every "how many QSOs/contacts"
// figure in the report (headline, band/mode table, DXCC/section tallies,
// rate records) counted the raw 64, which wouldn't match what you'd
// actually claim on a 3830 report.
describe('genuine dupe handling (non-QTC)', () => {
  const qsos = [
    qso({ call: 'N6NT', band: '7', mode: 'CW', countryprefix: 'K', zone: '4', section: 'OH', points: 1, is_mult1: 1, n1mm_timestamp: '2025-05-24 19:47:12' }),
    qso({ call: 'N6NT', band: '7', mode: 'CW', countryprefix: 'K', zone: '4', section: 'OH', points: 0, is_mult1: 0, n1mm_timestamp: '2025-05-24 19:56:34' }), // dupe
    qso({ call: 'NM2A', band: '7', mode: 'CW', countryprefix: 'K', zone: '4', section: 'OH', points: 1, is_mult1: 1, n1mm_timestamp: '2025-05-24 19:28:29' }),
    qso({ call: 'NM2A', band: '7', mode: 'CW', countryprefix: 'K', zone: '4', section: 'OH', points: 0, is_mult1: 0, n1mm_timestamp: '2025-05-24 19:37:25' }), // dupe
  ];
  const meta = { station_call: 'WT2P', has_points: true, has_mults: true };

  it('excludes dupes from the QSO count in the report sub-header', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /2 QSOs/); // 4 logged rows, 2 real QSOs
    const html = renderReport({ meta, qsos });
    assert.match(html, />2<\/b><span>QSOs/);
  });

  it('does not count a dupe toward the band/mode table\'s Q column', () => {
    const txt = renderReportText({ meta, qsos });
    assert.match(txt, /40m +2 +2/); // 2 real QSOs on 40m CW, not 4
    assert.match(txt, /Total +2 +2/);
  });
});

describe('Callsigns worked on the most bands', () => {
  const t = (m) => `2025-05-24 12:${String(m).padStart(2, '0')}:00`;
  const qsos = [
    // K3LR: 3 bands (20/40/80), logged out of band order
    qso({ call: 'K3LR', band: '14', n1mm_timestamp: t(0) }),
    qso({ call: 'K3LR', band: '3.5', n1mm_timestamp: t(1) }),
    qso({ call: 'K3LR', band: '7', n1mm_timestamp: t(2) }),
    // W1AW: 2 bands, but 3 Q (two modes on 20m)
    qso({ call: 'W1AW', band: '14', mode: 'CW', n1mm_timestamp: t(3) }),
    qso({ call: 'W1AW', band: '14', mode: 'SSB', n1mm_timestamp: t(4) }),
    qso({ call: 'W1AW', band: '21', n1mm_timestamp: t(5) }),
    // N2IC: 2 bands, 2 Q -- ranks below W1AW on the Q tie-break
    qso({ call: 'N2IC', band: '14', n1mm_timestamp: t(6) }),
    qso({ call: 'N2IC', band: '28', n1mm_timestamp: t(7) }),
    // DL1XYZ: one band only -- not listed
    qso({ call: 'DL1XYZ', band: '14', n1mm_timestamp: t(8) }),
  ];

  it('lists multi-band calls in the text summary, most bands first, ties by Q', () => {
    const txt = renderReportText({ meta: { station_call: 'WT2P' }, qsos });
    const block = txt.split('\nCallsigns worked on the most bands\n')[1];
    assert.ok(block, 'section present');
    const lines = block.split('\n');
    assert.match(lines[0], /^Call +Bands +Q +Which Bands$/);
    assert.match(lines[2], /^K3LR +3 +3 +80m, 40m, 20m$/); // low-to-high band order
    assert.match(lines[3], /^W1AW +2 +3 +20m, 15m$/);
    assert.match(lines[4], /^N2IC +2 +2 +20m, 10m$/);
    assert.doesNotMatch(block.split('\n\n')[0], /DL1XYZ/);
  });

  it('left-aligns the band list (it is text, not a number)', () => {
    const txt = renderReportText({ meta: { station_call: 'WT2P' }, qsos });
    const block = txt.split('\nCallsigns worked on the most bands\n')[1].split('\n');
    const col = block[0].indexOf('Which Bands');
    assert.equal(block[2].indexOf('80m'), col);
    assert.equal(block[4].indexOf('20m'), col);
  });

  it('renders the same table in the HTML report, band list not in a numeric cell', () => {
    const html = renderReport({ meta: { station_call: 'WT2P' }, qsos });
    assert.match(html, /<h2>Callsigns worked on the most bands<\/h2>/);
    assert.match(html, /<td>K3LR<\/td><td class="n">3<\/td><td class="n">3<\/td><td>80m, 40m, 20m<\/td>/);
    assert.match(html, /<th>Which Bands<\/th>/);
    assert.doesNotMatch(html, /<td>DL1XYZ<\/td><td class="n">1<\/td>/);
  });

  it('places the section after Top DXCC and before Sections, in both renderers', () => {
    const withSec = qsos.map((q) => ({ ...q, section: 'NY' }));
    const txt = renderReportText({ meta: { station_call: 'WT2P' }, qsos: withSec });
    const iDx = txt.indexOf('\nTop DXCC entities\n');
    const iMb = txt.indexOf('\nCallsigns worked on the most bands\n');
    const iSec = txt.indexOf('\nSections / exchanges worked');
    assert.ok(iDx < iMb && iMb < iSec);
    const html = renderReport({ meta: { station_call: 'WT2P' }, qsos: withSec });
    assert.ok(html.indexOf('Top DXCC entities') < html.indexOf('Callsigns worked on the most bands'));
    assert.ok(html.indexOf('Callsigns worked on the most bands') < html.indexOf('Sections / exchanges worked'));
  });

  it('omits the section when no call was worked on more than one band', () => {
    const single = [qso({ call: 'K3LR', band: '14' }), qso({ call: 'W1AW', band: '7' })];
    assert.doesNotMatch(renderReportText({ meta: {}, qsos: single }), /most bands/);
    assert.doesNotMatch(renderReport({ meta: {}, qsos: single }), /most bands/);
  });

  it('does not count dupes or QTCs toward Q, and caps the list at 25', () => {
    const extra = [
      qso({ call: 'K3LR', band: '14', n1mm_timestamp: t(30) }),                    // dupe of the 20m CW QSO
      qso({ call: 'K3LR', band: '7', exchange1: 'SQTC', n1mm_timestamp: t(31) }),  // QTC
    ];
    const txt = renderReportText({ meta: {}, qsos: [...qsos, ...extra] });
    assert.match(txt, /\nK3LR +3 +3 +80m, 40m, 20m\n/);

    const many = [];
    for (let i = 0; i < 30; i += 1) {
      many.push(qso({ call: `K${i}AA`, band: '14', n1mm_timestamp: t(i) }));
      many.push(qso({ call: `K${i}AA`, band: '7', n1mm_timestamp: t(i) }));
    }
    const rows = renderReportText({ meta: {}, qsos: many })
      .split('\nCallsigns worked on the most bands\n')[1].split('\n\n')[0].split('\n');
    assert.equal(rows.length - 2, 25); // header + rule + 25 rows
  });
});
