const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLookup } = require('../../src/parsers/lookup');

const base = `<?xml version="1.0" encoding="utf-8"?>
<lookupinfo>
  <call>DL1ABC</call>
  <name>Hans Mueller</name>
  <country>Germany</country>
  <grid>JO31</grid>
  <state></state>
  <county></county>
  <cqzone>14</cqzone>
  <ituzone>28</ituzone>
  <dxcc>DL</dxcc>
  <continent>EU</continent>
</lookupinfo>`;

describe('parseLookup', () => {
  it('extracts all expected fields', async () => {
    const l = await parseLookup(Buffer.from(base));
    assert.equal(l.call, 'DL1ABC');
    assert.equal(l.name, 'Hans Mueller');
    assert.equal(l.country, 'Germany');
    assert.equal(l.grid, 'JO31');
    assert.equal(l.cqzone, '14');
    assert.equal(l.ituzone, '28');
    assert.equal(l.dxcc, 'DL');
    assert.equal(l.continent, 'EU');
  });

  it('handles missing optional fields without throwing', async () => {
    const minimal = `<lookupinfo><call>W1AW</call></lookupinfo>`;
    const l = await parseLookup(Buffer.from(minimal));
    assert.equal(l.call, 'W1AW');
    assert.equal(l.name, '');
    assert.equal(l.country, '');
    assert.equal(l.dxcc, '');
  });

  it('rejects non-lookupinfo XML', async () => {
    await assert.rejects(
      () => parseLookup(Buffer.from('<ContactInfo><call>W1AW</call></ContactInfo>')),
      /Not a lookupinfo packet/
    );
  });
});
