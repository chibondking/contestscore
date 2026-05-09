const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseContact } = require('../../src/parsers/contact');

const sample = `<ContactInfo>
  <call>W1AW</call>
  <band>20</band>
  <mode>CW</mode>
  <operator>K1TTT</operator>
  <mycall>K1TTT</mycall>
  <contestname>CQ-WPX-CW</contestname>
  <srx>001</srx>
  <stx>001</stx>
  <snt>599</snt>
  <rcv>599</rcv>
  <points>1</points>
  <IsMultiplier1>1</IsMultiplier1>
  <IsMultiplier2>0</IsMultiplier2>
</ContactInfo>`;

describe('parseContact', () => {
  it('extracts expected fields', async () => {
    const result = await parseContact(Buffer.from(sample));
    assert.equal(result.call, 'W1AW');
    assert.equal(result.band, '20');
    assert.equal(result.is_mult1, 1);
    assert.equal(result.points, 1);
  });
});
