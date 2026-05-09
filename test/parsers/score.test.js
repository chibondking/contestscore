const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScore } = require('../../src/parsers/score');

const base = `<?xml version="1.0" encoding="utf-8"?>
<Score>
  <contest>CQ-WPX-CW</contest>
  <call>K1TTT</call>
  <operators>K1TTT</operators>
  <power>HIGH</power>
  <assisted>False</assisted>
  <transmitted>ALL</transmitted>
  <band>ALL</band>
  <mode>CW</mode>
  <qsos>42</qsos>
  <points>126</points>
  <mults>15</mults>
  <mults2>0</mults2>
  <total>1890</total>
</Score>`;

describe('parseScore', () => {
  it('extracts all expected fields', async () => {
    const s = await parseScore(Buffer.from(base));
    assert.equal(s.contest, 'CQ-WPX-CW');
    assert.equal(s.call, 'K1TTT');
    assert.equal(s.power, 'HIGH');
    assert.equal(s.band, 'ALL');
    assert.equal(s.mode, 'CW');
    assert.equal(s.qsos, 42);
    assert.equal(s.points, 126);
    assert.equal(s.mults, 15);
    assert.equal(s.mults2, 0);
    assert.equal(s.total, 1890);
  });

  it('parses assisted=False as 0', async () => {
    const s = await parseScore(Buffer.from(base));
    assert.equal(s.assisted, 0);
  });

  it('parses assisted=True as 1', async () => {
    const xml = base.replace('<assisted>False</assisted>', '<assisted>True</assisted>');
    const s = await parseScore(Buffer.from(xml));
    assert.equal(s.assisted, 1);
  });

  it('parses legacy assisted=1/0', async () => {
    const xml = base.replace('<assisted>False</assisted>', '<assisted>0</assisted>');
    const s = await parseScore(Buffer.from(xml));
    assert.equal(s.assisted, 0);
  });

  it('handles missing optional fields without throwing', async () => {
    const minimal = `<Score>
      <contest>TEST</contest>
      <call>W1TEST</call>
      <qsos>5</qsos>
      <points>5</points>
      <mults>3</mults>
      <total>15</total>
    </Score>`;
    const s = await parseScore(Buffer.from(minimal));
    assert.equal(s.contest, 'TEST');
    assert.equal(s.qsos, 5);
    assert.equal(s.operators, '');
    assert.equal(s.power, '');
  });

  it('rejects non-Score XML', async () => {
    await assert.rejects(
      () => parseScore(Buffer.from('<RadioInfo><RadioNr>1</RadioNr></RadioInfo>')),
      /Not a Score packet/
    );
  });

  it('handles concurrent calls without corrupting results', async () => {
    const xml2 = base.replace('<qsos>42</qsos>', '<qsos>99</qsos>')
                     .replace('<total>1890</total>', '<total>9900</total>');
    const [s1, s2] = await Promise.all([
      parseScore(Buffer.from(base)),
      parseScore(Buffer.from(xml2)),
    ]);
    assert.equal(s1.qsos, 42);
    assert.equal(s1.total, 1890);
    assert.equal(s2.qsos, 99);
    assert.equal(s2.total, 9900);
  });
});
