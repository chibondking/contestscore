const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseContact } = require('../../src/parsers/contact');

const base = `<?xml version="1.0" encoding="utf-8"?>
<ContactInfo>
  <call>DL1ABC</call>
  <band>20</band>
  <mode>CW</mode>
  <operator>K1TTT</operator>
  <mycall>K1TTT</mycall>
  <contestname>CQ-WPX-CW</contestname>
  <srx>042</srx>
  <stx>042</stx>
  <snt>599</snt>
  <rcv>599</rcv>
  <points>1</points>
  <mult1>DL</mult1>
  <mult2></mult2>
  <IsMultiplier1>True</IsMultiplier1>
  <IsMultiplier2>False</IsMultiplier2>
  <exchange1></exchange1>
  <section></section>
  <RoverLocation></RoverLocation>
  <RadioInterfaced>1</RadioInterfaced>
  <NetworkedCompNr>1</NetworkedCompNr>
  <IsNewQso>1</IsNewQso>
  <DeleteContact>False</DeleteContact>
</ContactInfo>`;

describe('parseContact', () => {
  it('extracts all expected fields', async () => {
    const c = await parseContact(Buffer.from(base));
    assert.equal(c.call, 'DL1ABC');
    assert.equal(c.band, '20');
    assert.equal(c.mode, 'CW');
    assert.equal(c.operator, 'K1TTT');
    assert.equal(c.mycall, 'K1TTT');
    assert.equal(c.contestname, 'CQ-WPX-CW');
    assert.equal(c.srx, '042');
    assert.equal(c.points, 1);
    assert.equal(c.mult1, 'DL');
    assert.equal(c.radio_nr, 1);
    assert.equal(c.comp_nr, 1);
  });

  it('parses N1MM True/False multiplier flags', async () => {
    const c = await parseContact(Buffer.from(base));
    assert.equal(c.is_mult1, 1);
    assert.equal(c.is_mult2, 0);
  });

  it('parses legacy 1/0 multiplier flags', async () => {
    const xml = base.replace('<IsMultiplier1>True</IsMultiplier1>', '<IsMultiplier1>1</IsMultiplier1>');
    const c = await parseContact(Buffer.from(xml));
    assert.equal(c.is_mult1, 1);
  });

  it('detects a normal QSO as not-delete', async () => {
    const c = await parseContact(Buffer.from(base));
    assert.equal(c.delete_contact, 0);
    assert.equal(c.is_new_qso, 1);
  });

  it('detects a delete-contact packet', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ContactInfo>
  <call>DL1ABC</call>
  <band>20</band>
  <mode>CW</mode>
  <operator>K1TTT</operator>
  <mycall>K1TTT</mycall>
  <contestname>CQ-WPX-CW</contestname>
  <IsNewQso>0</IsNewQso>
  <DeleteContact>True</DeleteContact>
</ContactInfo>`;
    const c = await parseContact(Buffer.from(xml));
    assert.equal(c.delete_contact, 1);
    assert.equal(c.is_new_qso, 0);
  });

  it('handles missing optional fields without throwing', async () => {
    const minimal = `<ContactInfo>
      <call>W1AW</call>
      <band>20</band>
      <mode>CW</mode>
      <mycall>K1TTT</mycall>
      <contestname>TEST</contestname>
    </ContactInfo>`;
    const c = await parseContact(Buffer.from(minimal));
    assert.equal(c.call, 'W1AW');
    assert.equal(c.mult1, '');
    assert.equal(c.is_mult1, 0);
    assert.equal(c.points, 0);
    assert.equal(c.radio_nr, null);
  });

  it('rejects non-ContactInfo XML', async () => {
    await assert.rejects(
      () => parseContact(Buffer.from('<Score><qsos>1</qsos></Score>')),
      /Not a ContactInfo packet/
    );
  });

  it('handles concurrent calls without corrupting results', async () => {
    const xml2 = base.replace('<call>DL1ABC</call>', '<call>JA1YXZ</call>')
                     .replace('<IsMultiplier1>True</IsMultiplier1>', '<IsMultiplier1>False</IsMultiplier1>');
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
