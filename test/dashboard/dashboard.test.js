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
