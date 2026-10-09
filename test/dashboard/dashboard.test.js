const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseContact } = require('../../src/parsers/contact');

// dashboard.js is a plain classic script (no module.exports, by design -- see
// CLAUDE.md), so load it the way a browser would and pull the `dashboard`
// factory off the resulting global scope. Only the factory is defined at load
// time; io/Chart/Alpine are touched inside init(), which these tests never call.
const src = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const sandbox = {};
vm.runInNewContext(src, sandbox);
const dashboard = sandbox.dashboard;
assert.equal(typeof dashboard, 'function', 'dashboard.js should define dashboard()');

function qso(overrides) {
  return {
    call: 'DL1ABC', band: '20', mode: 'CW', exchange1: '', operator: 'WT2P',
    mycall: 'WT9P', is_mult1: 0, is_mult2: 0, is_mult3: 0,
    ...overrides,
  };
}

describe('isMult', () => {
  const d = dashboard();

  it('lights for any of the three N1MM multiplier flags', () => {
    assert.equal(d.isMult(qso({ is_mult1: 1 })), true);
    assert.equal(d.isMult(qso({ is_mult2: 1 })), true);
    assert.equal(d.isMult(qso({ is_mult3: 1 })), true);
  });

  it('ignores a QSO the logger did not flag -- the logger is the authority', () => {
    assert.equal(d.isMult(qso()), false);
    assert.equal(d.isMult({ call: 'DL1ABC' }), false); // flag fields absent entirely
  });

  it('does not depend on the station call, operator or contest', () => {
    for (const mycall of ['WT9P', 'K9CT', 'WT2P', '']) {
      assert.equal(d.isMult(qso({ mycall, is_mult1: 1 })), true);
      assert.equal(d.isMult(qso({ mycall })), false);
    }
    assert.equal(d.isMult(qso({ operator: 'K9AA', contestname: 'CQ-WW-CW', is_mult2: 1 })), true);
  });

  describe('WAE QTCs', () => {
    it('never shows a QTC as a mult, even if the packet flags it', () => {
      for (const exchange1 of ['SQTC', 'RQTC', 'sqtc', 'rqtc']) {
        assert.equal(d.isMult(qso({ exchange1, is_mult1: 1 })), false, exchange1);
        assert.equal(d.isMult(qso({ exchange1, is_mult2: 1 })), false, exchange1);
        assert.equal(d.isMult(qso({ exchange1, is_mult3: 1 })), false, exchange1);
        assert.equal(d.isMult(qso({ exchange1, is_mult1: 1, is_mult2: 1, is_mult3: 1 })), false, exchange1);
      }
    });

    it('still flags an ordinary QSO whose exchange is not a QTC', () => {
      assert.equal(d.isMult(qso({ exchange1: '599 OH', is_mult1: 1 })), true);
    });

    it('a real QSO and its QTC in the same log: only the QSO can carry the chip', () => {
      const realQso = qso({ call: 'DL1ABC', exchange1: '001', is_mult1: 1 });
      const sentQtc = qso({ call: 'DL1ABC', exchange1: 'SQTC', is_mult1: 1 });
      assert.equal(d.isMult(realQso), true);
      assert.equal(d.isMult(sentQtc), false);
    });

    it('holds end to end: a QTC packet as N1MM sends it, through the parser', async () => {
      const xml = (exchange1) => `<?xml version="1.0"?>
<contactinfo>
  <app>N1MM</app>
  <contestname>WAE-CW</contestname>
  <mycall>WT9P</mycall>
  <operator>WT2P</operator>
  <call>DL1ABC</call>
  <band>14</band>
  <mode>CW</mode>
  <exchange1>${exchange1}</exchange1>
  <ismultiplier1>True</ismultiplier1>
  <ismultiplier2>False</ismultiplier2>
  <ismultiplier3>False</ismultiplier3>
</contactinfo>`;

      const qtc = await parseContact(Buffer.from(xml('SQTC')));
      assert.equal(qtc.is_mult1, 1, 'precondition: the packet really is flagged');
      assert.equal(d.isMult(qtc), false);

      const ordinary = await parseContact(Buffer.from(xml('001')));
      assert.equal(d.isMult(ordinary), true);
    });
  });
});

describe('stationCall', () => {
  it('is the transmitted call, not any of several operators', () => {
    const d = dashboard();
    d.qsos = [qso({ mycall: 'WT9P', operator: 'WT2P' }), qso({ mycall: 'WT9P', operator: 'K9AA' })];
    d.score = { ops: 'WT2P K9AA' };
    assert.equal(d.stationCall(), 'WT9P');
  });

  it('skips QSOs with a blank mycall, then falls back to the score call', () => {
    const d = dashboard();
    d.qsos = [qso({ mycall: '' }), qso({ mycall: 'WT9P' })];
    d.score = {};
    assert.equal(d.stationCall(), 'WT9P');

    d.qsos = [];
    d.score = { call: 'WT9P', ops: 'WT2P' };
    assert.equal(d.stationCall(), 'WT9P');
  });

  it('is empty rather than falling back to an operator when nothing is known', () => {
    const d = dashboard();
    d.qsos = [qso({ mycall: '', operator: 'WT2P' })];
    d.score = { ops: 'WT2P' };
    assert.equal(d.stationCall(), '');
  });
});

describe('world map: night mask shape', () => {
  // Pulls every "x,y" vertex out of an SVG path string.
  const vertices = (d) => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

  it('pads past the left/right edges so the blurred mask stays solid at the map edges', () => {
    const d = dashboard();
    d.now = Date.UTC(2026, 5, 21, 12, 0, 0); // June solstice
    const xs = vertices(d.nightPolygonPath()).map(([x]) => x);
    assert.equal(Math.min(...xs), -40);
    assert.equal(Math.max(...xs), 1040);
  });

  it('closes past whichever pole is dark: north in December, south in June', () => {
    const d = dashboard();
    d.now = Date.UTC(2026, 11, 21, 12, 0, 0); // December solstice: north pole dark
    let ys = vertices(d.nightPolygonPath()).map(([, y]) => y);
    assert.equal(Math.min(...ys), -40);
    d.now = Date.UTC(2026, 5, 21, 12, 0, 0);  // June solstice: south pole dark
    ys = vertices(d.nightPolygonPath()).map(([, y]) => y);
    assert.equal(Math.max(...ys), 540);
  });

  it('starts and ends the terminator at the same height (lon -180 and 180 are one meridian)', () => {
    const d = dashboard();
    d.now = Date.UTC(2026, 8, 29, 3, 30, 0);
    const v = vertices(d.nightPolygonPath());
    assert.deepEqual(v[0], [-40, v[1][1]]); // padded start sits level with lon -180
    const right = v.find(([x]) => x === 1040);
    assert.equal(right[1], v[1][1]);
  });
});

describe('world map: time zones', () => {
  const svg = dashboard().mapZonesSvg();

  it('has a badge for every zone from -11 to +11 (the dateline zones are split by the map edge)', () => {
    const labels = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
    assert.equal(labels.length, 23);
    assert.equal(labels[0], '-11');
    assert.equal(labels[11], '0');
    assert.equal(labels[22], '+11');
  });

  it('draws a boundary every 15 degrees, centered on each zone meridian', () => {
    const xs = [...svg.matchAll(/<line x1="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.equal(xs.length, 24);
    assert.ok(xs.includes(479.17) && xs.includes(520.83)); // +/-7.5 deg around Greenwich
  });
});

describe('world map: show/hide', () => {
  it('toggles, and a missing localStorage (private window, this sandbox) is not an error', () => {
    const d = dashboard();
    assert.equal(d.showWorldMap, true);
    d.toggleWorldMap();
    assert.equal(d.showWorldMap, false);
    d.toggleWorldMap();
    assert.equal(d.showWorldMap, true);
  });
});

describe('world map: band filter', () => {
  const located = (o) => qso({ lat: 50, lon: 10, ...o });

  it('offers each band in the log once, lowest frequency first', () => {
    const d = dashboard();
    d.qsos = [located({ band: '14' }), located({ band: '7' }), located({ band: '14' }), located({ band: '1.8' })];
    assert.deepEqual([...d.mapBands()], ['1.8', '7', '14']);
    assert.deepEqual([...d.mapBands()].map((b) => d.bandLabel(b)), ['160m', '40m', '20m']);
  });

  it('All shows every band; a picked band shows only that band', () => {
    const d = dashboard();
    d.qsos = [located({ call: 'A1A', band: '7' }), located({ call: 'B1B', band: '14' })];
    assert.equal(d.mapPoints().length, 2);
    d.mapBand = '14';
    assert.deepEqual([...d.mapPoints()].map((p) => p.call), ['B1B']);
  });

  it('is the last 30 on that band, not the last 30 overall narrowed down', () => {
    const d = dashboard();
    // newest-first: 40 recent 20m QSOs, then 5 older 40m ones
    d.qsos = [
      ...Array.from({ length: 40 }, (_, i) => located({ call: `K${i}A`, band: '14' })),
      ...Array.from({ length: 5 }, (_, i) => located({ call: `W${i}B`, band: '7' })),
    ];
    assert.equal(d.mapPoints().filter((p) => p.band === '7').length, 0);
    d.mapBand = '7';
    assert.equal(d.mapPoints().length, 5);
  });
});

describe('world map: overlapping dots', () => {
  const located = (o) => qso({ lat: 40.5, lon: -75, ...o });

  it('one station worked on several bands is one dot, listing every QSO newest first', () => {
    const d = dashboard();
    // Seen live: N3AD's newer 160m QSO hidden under its older 80m mult.
    d.qsos = [located({ call: 'N3AD', band: '1.8' }), located({ call: 'N3AD', band: '3.5', is_mult1: 1 })];
    const pts = d.mapPoints();
    assert.equal(pts.length, 1);
    assert.equal(pts[0].band, '1.8'); // the newest QSO's
    assert.equal(pts[0].mult, true);  // any mult makes it a mult dot
    assert.match(d.mapDotsSvg(), /<title>N3AD — 160m CW, 80m CW MULT<\/title>/);
  });

  it('draws the newest station on top where different stations overlap (mults still above all)', () => {
    const d = dashboard();
    d.qsos = [located({ call: 'NEW1' }), located({ call: 'OLD1' })]; // newest-first
    assert.deepEqual([...d.mapPoints()].map((p) => p.call), ['OLD1', 'NEW1']);
    d.qsos = [located({ call: 'NEW1' }), located({ call: 'OLD1', is_mult1: 1 })];
    assert.deepEqual([...d.mapPoints()].map((p) => p.call), ['NEW1', 'OLD1']);
  });

  it('a station at two different spots (rover) keeps a dot per spot', () => {
    const d = dashboard();
    d.qsos = [located({ call: 'K1R/R', lat: 42 }), located({ call: 'K1R/R', lat: 41 })];
    assert.equal(d.mapPoints().length, 2);
  });
});

describe('X-QSOs (is_claimed_qso 0)', () => {
  const located = (o) => qso({ lat: 40, lon: -80, logged_at: '2026-09-30 00:58:00', points: 1, ...o });

  it('stay in the list for Recent QSOs but count toward nothing', () => {
    const d = dashboard();
    d.qsos = [
      located({ call: 'K9MMS', ext_id: 'x', is_claimed_qso: 0, points: 0, continent: 'NA' }),
      located({ call: 'K3LR', ext_id: 'a', continent: 'NA' }),
      located({ call: 'W1AW', ext_id: 'b', is_claimed_qso: null, continent: 'NA' }), // no flag = counts
    ];
    assert.equal(d.qsos.length, 3);
    assert.deepEqual([...d.countedQsos()].map((q) => q.call), ['K3LR', 'W1AW']);
    assert.equal(d.isXQso(d.qsos[0]), true);
    assert.equal(d.isXQso(d.qsos[1]), false);
    assert.deepEqual([...d.mapPoints()].map((p) => p.call).sort(), ['K3LR', 'W1AW']);
  });

  it('never appear in a map band filter on their own', () => {
    const d = dashboard();
    d.qsos = [located({ call: 'K9MMS', band: '3.5', is_claimed_qso: 0 }), located({ call: 'K3LR', band: '7' })];
    assert.deepEqual([...d.mapBands()], ['7']);
  });
});

describe('Score card: delayed score source (DXLog)', () => {
  const at = (min) => new Date(Date.UTC(2026, 8, 30, 1, 0, 0) + min * 60000).toISOString();

  it('flags a DXLog score as delayed, with no chip for N1MM', () => {
    const d = dashboard();
    d.score = { soft: 'DXLog', total: 6 };
    assert.equal(d.scoreIsDelayed(), true);
    assert.equal(d.scoreSourceChip(), 'DXLog · delayed'); // no interval measured yet
    d.score = { soft: '', total: 6 };
    assert.equal(d.scoreIsDelayed(), false);
    assert.equal(d.scoreSourceChip(), '');
  });

  it('shows the measured interval: median of recent gaps, ignoring pauses and manual pushes', () => {
    const d = dashboard();
    d.score = { soft: 'DXLog' };
    // 5-min timer; a 50-min pause (DXLog closed) and a manual push 30s after
    // a timed post are neither the interval.
    d.scoreHistory = [0, 5, 10, 60, 60.5, 65, 70, 76].map((m) => ({ soft: 'DXLog', captured_at: at(m) }));
    assert.equal(d.scoreIntervalMinutes(), 5);
    assert.equal(d.scoreSourceChip(), 'DXLog · every ~5 min');
  });

  it('handles both ends of DXLog\'s 2-30 min timer setting', () => {
    const d = dashboard();
    d.score = { soft: 'DXLog' };
    d.scoreHistory = [0, 2, 4, 6].map((m) => ({ soft: 'DXLog', captured_at: at(m) }));
    assert.equal(d.scoreIntervalMinutes(), 2);
    d.scoreHistory = [0, 30, 60, 90].map((m) => ({ soft: 'DXLog', captured_at: at(m) }));
    assert.equal(d.scoreIntervalMinutes(), 30);
  });

  it('needs at least two gaps before quoting an interval', () => {
    const d = dashboard();
    d.score = { soft: 'DXLog' };
    d.scoreHistory = [0, 5].map((m) => ({ soft: 'DXLog', captured_at: at(m) }));
    assert.equal(d.scoreIntervalMinutes(), null);
  });

  it('never shows "catching up" for DXLog -- the lag is its reporting interval', () => {
    const d = dashboard();
    d.now = Date.UTC(2026, 8, 30, 1, 10, 0);
    d.qsos = [qso({ logged_at: '2026-09-30 01:05:00' })];
    d.score = { soft: 'DXLog', captured_at: at(0) };
    assert.equal(d.scoreStale(), false);
    d.score = { soft: '', captured_at: at(0) }; // same lag from N1MM is still flagged
    assert.equal(d.scoreStale(), true);
  });
});


describe('tenantLabel (footer)', () => {
  it('is empty on a standalone install', () => {
    const d = dashboard();
    d.features = { lookup: {}, solar: {}, tenant: null };
    assert.equal(d.tenantLabel('scoreboard.example.org'), '');
    d.features = {};
    assert.equal(d.tenantLabel('k9ct-score.wt2p.us'), '');
  });

  it("is the hostname's first label on the club's own hostname", () => {
    const d = dashboard();
    d.features = { tenant: { call: 'K9CT', name: 'K9CT Club' } };
    assert.equal(d.tenantLabel('k9ct-score.wt2p.us'), 'k9ct-score');
  });

  it('names the tenant on an alias hostname', () => {
    const d = dashboard();
    d.features = { tenant: { call: 'WT2P', name: 'WT2P' } };
    assert.equal(d.tenantLabel('scoreboard.wt2p.us'), 'tenant wt2p');
  });
});
