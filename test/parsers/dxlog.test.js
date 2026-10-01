// DXLog.net with its N1MM-compatible UDP broadcast on: real packets from a
// DXLog 2.6.37 capture (test/fixtures/dxlog/), run through the same parsers
// N1MM's packets use. See README "Using DXLog".
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRadio } = require('../../src/parsers/radio');
const { parseContact } = require('../../src/parsers/contact');
const { parseScore } = require('../../src/parsers/score');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '../fixtures/dxlog', name));

describe('DXLog (N1MM-compatible broadcast)', () => {
  it('RadioInfo: station name comes from <Station>, everything else as N1MM', async () => {
    const r = await parseRadio(fixture('radioinfo.xml'));
    assert.equal(r.station_name, 'WT2P_TP'); // DXLog's <Station>, not N1MM's <StationName>
    assert.equal(r.radio_nr, 1);
    assert.equal(r.freq, '7044000'); // tens of Hz, same as N1MM
    assert.equal(r.mode, 'CW');
    assert.equal(r.op_call, 'WT2P');
    assert.equal(r.is_running, 0);
    assert.equal(r.active_radio, 1);
  });

  it('a new QSO carries the fields the dashboard needs', async () => {
    const c = await parseContact(fixture('contactinfo.xml'));
    assert.equal(c.ext_id, '9909512b90c44f3d96672b9f07a547e8');
    assert.equal(c.call, 'K9CT');
    assert.equal(c.band, '7');
    assert.equal(c.operator, 'WT2P');
    assert.equal(c.station_name, 'WT2P_TP');
    assert.equal(c.is_mult1, 1);
    assert.equal(c.points, 1);
    assert.equal(c.is_claimed_qso, 1);
    assert.equal(c.snt_nr, '1');
  });

  it('an X-QSO arrives as a contactreplace for the same QSO, unclaimed', async () => {
    const c = await parseContact(fixture('contactreplace-xqso.xml'));
    assert.equal(c.ext_id, 'a2e8d7c44c2741b0bc26199ebf2da1ca'); // same ID as the original K9MMS
    assert.equal(c.call, 'K9MMS');
    assert.equal(c.is_claimed_qso, 0);
    assert.equal(c.points, 0);
    assert.equal(c.is_mult1, 0);
  });

  it('the score post parses unchanged', async () => {
    const s = await parseScore(fixture('dynamicresults.xml'));
    assert.equal(s.contest, 'CW-OPS');
    assert.equal(s.score_total, 6);
    assert.equal(s.grid6, 'EN51RP');
    assert.equal(s.soft, 'DXLog'); // drives the Score card's delayed-source chip
    const total = s.breakdown.find((b) => b.is_total);
    assert.deepEqual({ qsos: total.qsos, points: total.points, mults: total.mults }, { qsos: 3, points: 3, mults: 2 });
  });
});

describe("DXLog's native broadcast (its own format, not N1MM-compatible)", () => {
  it('a new QSO: mult, ID, station, serial and exchange from the native fields', async () => {
    const c = await parseContact(fixture('native-contactinfo.xml'));
    assert.equal(c.call, 'K3WW');
    assert.equal(c.ext_id, 'd048bc92b73341868d73305e4c630130'); // <guid>
    assert.equal(c.is_mult1, 1); // <mult1>K3WW</mult1>
    assert.equal(c.is_mult2, 0); // <mult2></mult2>
    assert.equal(c.station_name, 'WT2P_TP'); // <stationid>
    assert.equal(c.snt_nr, '8'); // <nr>
    assert.equal(c.exchange1, 'CHAS 178'); // <exch1> <exch2>
    assert.equal(c.is_run_qso, 0);
    assert.equal(c.is_original, 1); // <local>True
    assert.equal(c.is_claimed_qso, 1);
    assert.equal(c.points, 1);
    assert.equal(c.band, '7');
  });

  it('marking it X-QSO re-sends the same guid, unclaimed and no longer a mult', async () => {
    const c = await parseContact(fixture('native-contactinfo-xqso.xml'));
    assert.equal(c.ext_id, 'd048bc92b73341868d73305e4c630130');
    assert.equal(c.is_claimed_qso, 0); // <xqso>True
    assert.equal(c.is_mult1, 0);
    assert.equal(c.points, 0);
  });
});

