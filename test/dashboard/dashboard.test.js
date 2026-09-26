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
