const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { contactPacket, guidHex, splitRcvd } = require('../../tools/dxlog-backfill');
const { parseContact } = require('../../src/parsers/contact');

// A real qsodata + qsodatacalc row (DXLog.net .dxn, DBVersion 7, CQ WW SSB
// 2026-10-25), as node:sqlite returns it.
const ROW = {
  idqso: 1, band: '20', period: 1, frequency: 14237.0, mode: 'SSB',
  qsotime: '2026-10-25 22:29:27.6126261Z', callsign: 'P40L', sent: '59', nr: 1,
  rcvd: '59  09', recinfo: '', recinfo2: '', recinfo3: '', stn: 'R',
  originstnid: 'WT2P_R1', xqso: 0, operator: 'WT2P',
  qsoguid: Buffer.from('a48c2aafbfacbb498e8f7d1f32ac0ebe', 'hex'),
  points: 3, mult1: 'P4', mult2: '09', mult3: '', dxcc: 'P4', invalidqso: 0, multkey: 3,
};

const parse = (row) => parseContact(Buffer.from(contactPacket(row, { mycall: 'K9CT', contest: 'CQ World Wide' })));

describe('dxlog-backfill', () => {
  it('reads qsoguid in .NET byte order (a v4 GUID), not as stored', () => {
    assert.equal(guidHex(ROW.qsoguid), 'af2a8ca4acbf49bb8e8f7d1f32ac0ebe');
  });

  it('round-trips a .dxn row through the real contact parser', async () => {
    const q = await parse(ROW);
    assert.equal(q.ext_id, 'af2a8ca4acbf49bb8e8f7d1f32ac0ebe');
    assert.equal(q.call, 'P40L');
    assert.equal(q.band, '14');             // from 14237 kHz, not the "20" (meters) column
    assert.equal(q.rx_freq, '14237000');
    assert.equal(q.rcv, '59');
    assert.equal(q.exchange1, '09');
    assert.equal(q.station_name, 'WT2P_R1');
    assert.equal(q.points, 3);
    assert.equal(q.is_mult1, 1);
    assert.equal(q.is_mult2, 1);
    assert.equal(q.is_claimed_qso, 1);
    assert.equal(q.n1mm_timestamp, '2026-10-25 22:29:27');
    assert.equal(q.logged_at, '2026-10-25 22:29:27');
  });

  it('a mult column only counts when multkey says it was new', async () => {
    // VC3R: VE already worked on 40m, zone 04 new -> multkey 2
    const q = await parse({ ...ROW, callsign: 'VC3R', mult1: 'VE', mult2: '04', multkey: 2 });
    assert.equal(q.is_mult1, 0);
    assert.equal(q.is_mult2, 1);
    const none = await parse({ ...ROW, multkey: 0 });
    assert.equal(none.is_mult1 + none.is_mult2 + none.is_mult3, 0);
  });

  it('an X-QSO (xqso or invalidqso) is unclaimed and scores nothing', async () => {
    for (const flags of [{ xqso: 1 }, { invalidqso: 1 }]) {
      const q = await parse({ ...ROW, ...flags });
      assert.equal(q.is_claimed_qso, 0);
      assert.equal(q.points, 0);
    }
  });

  it('splits a leading RST off the received exchange', () => {
    assert.deepEqual(splitRcvd('59  09'), { rcv: '59', exch: '09' });
    assert.deepEqual(splitRcvd('599 05'), { rcv: '599', exch: '05' });
    assert.deepEqual(splitRcvd('CHAS 178'), { rcv: '', exch: 'CHAS 178' });
  });
});
