const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScore } = require('../../src/parsers/score');

const sample = `<Score>
  <contest>CQ-WPX-CW</contest>
  <call>K1TTT</call>
  <operators>K1TTT</operators>
  <power>HIGH</power>
  <assisted>0</assisted>
  <band>ALL</band>
  <mode>CW</mode>
  <qsos>42</qsos>
  <points>126</points>
  <mults>15</mults>
  <mults2>0</mults2>
  <total>1890</total>
</Score>`;

describe('parseScore', () => {
  it('extracts expected fields', async () => {
    const result = await parseScore(Buffer.from(sample));
    assert.equal(result.contest, 'CQ-WPX-CW');
    assert.equal(result.qsos, 42);
    assert.equal(result.mults, 15);
    assert.equal(result.total, 1890);
  });
});
