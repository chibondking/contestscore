const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { contactPacket, qtcKind, rowSummary } = require('../../tools/n1mm-backfill');
const { parseContact } = require('../../src/parsers/contact');

// A real DXLOG row (N1MM+ .s3db, ICWC-MST 2026-09-29), as node:sqlite returns it.
const ROW = {
  TS: '2026-09-29 03:04:37', Call: 'KI6OY', Freq: 7036.5, QSXFreq: 7036.5, Mode: 'CW',
  ContestName: 'ICWC-MST', SNT: '599', RCV: '599', CountryPrefix: 'K', StationPrefix: 'WT2P',
  QTH: '', Name: 'LEE', Comment: '', NR: 3, Sect: '', Prec: '', CK: 0, ZN: 3, SentNr: 1,
  Points: 1, IsMultiplier1: 1, IsMultiplier2: 0, Power: '', Band: 7.0, WPXPrefix: 'KI6',
  Exchange1: '', RadioNR: 1, ContestNR: 34, isMultiplier3: 0, MiscText: 'KI6OY', IsRunQSO: 1,
  ContactType: ' ', Run1Run2: 1, GridSquare: ' ', Operator: 'WT2P', Continent: 'NA',
  RoverLocation: ' ', RadioInterfaced: 1, NetworkedCompNr: 0, NetBiosName: 'WT2P-THINKPAD',
  IsOriginal: 1, ID: 'a738b31bc2d04ec3b02b32b01e9c6143', CLAIMEDQSO: 1,
};

describe('n1mm-backfill contactPacket', () => {
  it('round-trips a DXLOG row through the real contact parser', async () => {
    const q = await parseContact(Buffer.from(contactPacket(ROW, { mycall: 'K9CT', sentExchange: '' })));
    assert.equal(q.ext_id, 'a738b31bc2d04ec3b02b32b01e9c6143');
    assert.equal(q.call, 'KI6OY');
    assert.equal(q.band, '7');          // DXLOG's float 7.0, sent the way N1MM broadcasts it
    assert.equal(q.rx_freq, '7036500'); // kHz in the DB -> tens of Hz on the wire -> Hz
    assert.equal(q.mycall, 'K9CT');
    assert.equal(q.contestnr, '34');
    assert.equal(q.is_mult1, 1);
    assert.equal(q.is_run_qso, 1);
    assert.equal(q.station_name, 'WT2P-THINKPAD');
    assert.equal(q.gridsquare, '');     // N1MM pads empty fields with a space
    assert.equal(q.n1mm_timestamp, '2026-09-29 03:04:37');
    assert.equal(q.logged_at, '2026-09-29 03:04:37');
  });

  it('a non-claimed (X-) QSO stays non-claimed', async () => {
    const q = await parseContact(Buffer.from(contactPacket({ ...ROW, CLAIMEDQSO: 0 }, { mycall: 'K9CT' })));
    assert.equal(q.is_claimed_qso, 0);
  });

  it('only a backfill packet sets logged_at; a live N1MM one leaves it to the server', async () => {
    const live = contactPacket(ROW, { mycall: 'K9CT' }).replace(/<app>[^<]*<\/app>/, '<app>N1MM</app>');
    assert.equal((await parseContact(Buffer.from(live))).logged_at, null);
  });
});

// Real DXLOG QTC row shape (WT2P WAE SSB 2026-09-13): each QTC is its own
// row with its own ID; Exchange1 says which way it went.
const QTC = {
  ...ROW, TS: '2026-09-13 16:20:53', Call: 'LZ5R', Band: 21, Freq: 21250, QSXFreq: 21250, Mode: 'USB',
  ContestName: 'WAESSB', ContestNR: 27, Exchange1: 'SQTC', MiscText: '5/9', SentNr: 326, NR: 25,
  Points: 1, IsMultiplier1: 0, ID: '4c741a1c56af4af9a52e188fba230955',
};

describe('n1mm-backfill QTCs', () => {
  for (const kind of ['SQTC', 'RQTC']) {
    it(`a ${kind} row reaches the server as a QTC with its own ID`, async () => {
      const q = await parseContact(Buffer.from(contactPacket({ ...QTC, Exchange1: kind }, { mycall: 'WT2P' })));
      assert.equal(q.exchange1, kind);
      assert.match(q.exchange1, /QTC/i); // the dashboard's isQtc()
      assert.equal(q.ext_id, '4c741a1c56af4af9a52e188fba230955');
      assert.equal(q.call, 'LZ5R');
      assert.equal(q.points, 1);
    });
  }

  it('qtcKind tells sent from received, and a QSO from either', () => {
    assert.equal(qtcKind({ Exchange1: 'SQTC' }), 'sent');
    assert.equal(qtcKind({ Exchange1: 'rqtc ' }), 'received');
    assert.equal(qtcKind({ Exchange1: '' }), null);
    assert.equal(qtcKind({ Exchange1: null }), null);
  });

  it('rowSummary counts QSOs and QTCs separately', () => {
    assert.equal(rowSummary([ROW, ROW]), '2 QSOs');
    assert.equal(rowSummary([ROW, { Exchange1: 'SQTC' }, { Exchange1: 'RQTC' }, { Exchange1: 'RQTC' }]),
      '1 QSOs + 3 QTCs (1 sent, 2 received)');
  });
});
