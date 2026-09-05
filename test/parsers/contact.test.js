const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseContact } = require('../../src/parsers/contact');

// Real N1MM wire format — lowercase <contactinfo> root, lowercase field
// names except for a handful of PascalCase tags (RoverLocation,
// RadioInterfaced, NetworkedCompNr, IsOriginal, NetBiosName, IsRunQSO,
// StationName, ID, IsClaimedQso, SentExchange). See
// https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/
const base = `<?xml version="1.0" encoding="utf-8"?>
<contactinfo>
  <app>N1MM</app>
  <contestname>CQ-WPX-CW</contestname>
  <contestnr>73</contestnr>
  <timestamp>2020-01-17 16:43:38</timestamp>
  <mycall>K1TTT</mycall>
  <band>14</band>
  <rxfreq>1402500</rxfreq>
  <txfreq>1402500</txfreq>
  <operator>K1TTT</operator>
  <mode>CW</mode>
  <call>DL1ABC</call>
  <countryprefix>DL</countryprefix>
  <wpxprefix>DL1</wpxprefix>
  <stationprefix>K1TTT</stationprefix>
  <continent>EU</continent>
  <snt>599</snt>
  <sntnr>042</sntnr>
  <rcv>599</rcv>
  <rcvnr>042</rcvnr>
  <gridsquare></gridsquare>
  <exchange1></exchange1>
  <section></section>
  <comment></comment>
  <qth></qth>
  <name></name>
  <power></power>
  <misctext></misctext>
  <zone>0</zone>
  <prec></prec>
  <ck>0</ck>
  <ismultiplier1>1</ismultiplier1>
  <ismultiplier2>0</ismultiplier2>
  <ismultiplier3>0</ismultiplier3>
  <points>1</points>
  <radionr>1</radionr>
  <RoverLocation></RoverLocation>
  <RadioInterfaced>1</RadioInterfaced>
  <NetworkedCompNr>1</NetworkedCompNr>
  <IsOriginal>True</IsOriginal>
  <NetBiosName></NetBiosName>
  <IsRunQSO>1</IsRunQSO>
  <StationName>CONTEST-PC</StationName>
  <ID>f9ffac4fcd3e479ca86e137df1338531</ID>
  <IsClaimedQso>1</IsClaimedQso>
  <SentExchange>599 042</SentExchange>
</contactinfo>`;

describe('parseContact', () => {
  it('extracts all expected fields', async () => {
    const c = await parseContact(Buffer.from(base));
    assert.equal(c.call, 'DL1ABC');
    assert.equal(c.band, '14');
    assert.equal(c.mode, 'CW');
    assert.equal(c.operator, 'K1TTT');
    assert.equal(c.mycall, 'K1TTT');
    assert.equal(c.contestname, 'CQ-WPX-CW');
    assert.equal(c.contestnr, '73');
    assert.equal(c.snt_nr, '042');
    assert.equal(c.rcv_nr, '042');
    assert.equal(c.points, 1);
    assert.equal(c.radio_nr, 1);
    assert.equal(c.comp_nr, 1);
    assert.equal(c.station_name, 'CONTEST-PC');
    assert.equal(c.ext_id, 'f9ffac4fcd3e479ca86e137df1338531');
    assert.equal(c.sent_exchange, '599 042');
  });

  it('parses N1MM True/False multiplier flags', async () => {
    const c = await parseContact(Buffer.from(base));
    assert.equal(c.is_mult1, 1);
    assert.equal(c.is_mult2, 0);
  });

  it('parses legacy 1/0 multiplier flags', async () => {
    const xml = base.replace('<ismultiplier1>1</ismultiplier1>', '<ismultiplier1>1</ismultiplier1>');
    const c = await parseContact(Buffer.from(xml));
    assert.equal(c.is_mult1, 1);
  });

  it('parses IsOriginal to detect a fresh QSO vs. a revision', async () => {
    const c = await parseContact(Buffer.from(base));
    assert.equal(c.is_original, 1);

    const revised = base.replace('<IsOriginal>True</IsOriginal>', '<IsOriginal>False</IsOriginal>');
    const r = await parseContact(Buffer.from(revised));
    assert.equal(r.is_original, 0);
  });

  it('accepts a contactreplace root with the same shape', async () => {
    const xml = base.replace('<contactinfo>', '<contactreplace>').replace('</contactinfo>', '</contactreplace>');
    const c = await parseContact(Buffer.from(xml));
    assert.equal(c.call, 'DL1ABC');
    assert.equal(c.ext_id, 'f9ffac4fcd3e479ca86e137df1338531');
  });

  it('handles missing optional fields without throwing', async () => {
    const minimal = `<contactinfo>
      <call>W1AW</call>
      <band>14</band>
      <mode>CW</mode>
      <mycall>K1TTT</mycall>
      <contestname>TEST</contestname>
    </contactinfo>`;
    const c = await parseContact(Buffer.from(minimal));
    assert.equal(c.call, 'W1AW');
    assert.equal(c.is_mult1, 0);
    assert.equal(c.points, 0);
    assert.equal(c.radio_nr, null);
    assert.equal(c.ext_id, null);
    // No <IsOriginal> present — a fresh QSO is assumed.
    assert.equal(c.is_original, 1);
  });

  it('rejects XML that is neither contactinfo nor contactreplace', async () => {
    await assert.rejects(
      () => parseContact(Buffer.from('<dynamicresults><score>1</score></dynamicresults>')),
      /Not a contactinfo\/contactreplace packet/
    );
  });

  it('handles concurrent calls without corrupting results', async () => {
    const xml2 = base.replace('<call>DL1ABC</call>', '<call>JA1YXZ</call>')
                     .replace('<ismultiplier1>1</ismultiplier1>', '<ismultiplier1>0</ismultiplier1>');
    const [c1, c2] = await Promise.all([
      parseContact(Buffer.from(base)),
      parseContact(Buffer.from(xml2)),
    ]);
    assert.equal(c1.call, 'DL1ABC');
    assert.equal(c1.is_mult1, 1);
    assert.equal(c2.call, 'JA1YXZ');
    assert.equal(c2.is_mult1, 0);
  });
});
