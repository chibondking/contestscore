const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseContactDelete } = require('../../src/parsers/contactDelete');

// Deletes are their own N1MM broadcast type — root <contactdelete> — with a
// deliberately small field set (no mode, no contestname, only contestnr).
const base = `<?xml version="1.0" encoding="utf-8"?>
<contactdelete>
  <app>N1MM</app>
  <timestamp>2020-01-17 16:43:38</timestamp>
  <mycall>K1TTT</mycall>
  <band>14</band>
  <call>DL1ABC</call>
  <contestnr>73</contestnr>
  <StationName>CONTEST-PC</StationName>
  <ID>f9ffac4fcd3e479ca86e137df1338531</ID>
</contactdelete>`;

describe('parseContactDelete', () => {
  it('extracts all expected fields', async () => {
    const d = await parseContactDelete(Buffer.from(base));
    assert.equal(d.call, 'DL1ABC');
    assert.equal(d.band, '14');
    assert.equal(d.mycall, 'K1TTT');
    assert.equal(d.contestnr, '73');
    assert.equal(d.station_name, 'CONTEST-PC');
    assert.equal(d.ext_id, 'f9ffac4fcd3e479ca86e137df1338531');
  });

  it('handles a missing <ID> (legacy logger) without throwing', async () => {
    const xml = base.replace(/<ID>.*<\/ID>/, '');
    const d = await parseContactDelete(Buffer.from(xml));
    assert.equal(d.ext_id, null);
    assert.equal(d.call, 'DL1ABC');
  });

  it('rejects non-contactdelete XML', async () => {
    await assert.rejects(
      () => parseContactDelete(Buffer.from('<contactinfo><call>W1AW</call></contactinfo>')),
      /Not a contactdelete packet/
    );
  });
});
