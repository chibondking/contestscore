const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRadio } = require('../../src/parsers/radio');

const base = `<?xml version="1.0" encoding="utf-8"?>
<RadioInfo>
  <StationName>K1TTT-1</StationName>
  <RadioNr>1</RadioNr>
  <Freq>14025000</Freq>
  <TXFreq>14025000</TXFreq>
  <Mode>CW</Mode>
  <OpCall>K1TTT</OpCall>
  <IsRunning>True</IsRunning>
  <IsTransmitting>False</IsTransmitting>
  <FocusEntry>1</FocusEntry>
  <Antenna>1</Antenna>
  <Rotors>90</Rotors>
  <FocusRadioNr>1</FocusRadioNr>
  <ActiveRadioNr>1</ActiveRadioNr>
</RadioInfo>`;

describe('parseRadio', () => {
  it('extracts all expected fields', async () => {
    const r = await parseRadio(Buffer.from(base));
    assert.equal(r.radio_nr, 1);
    assert.equal(r.freq, '14025000');
    assert.equal(r.mode, 'CW');
    assert.equal(r.op_call, 'K1TTT');
    assert.equal(r.station_name, 'K1TTT-1');
    assert.equal(r.focus_entry, 1);
    assert.equal(r.focus_radio, 1);
    assert.equal(r.active_radio, 1);
  });

  it('parses N1MM True/False booleans correctly', async () => {
    const r = await parseRadio(Buffer.from(base));
    assert.equal(r.is_running, 1);
    assert.equal(r.is_transmitting, 0);
  });

  it('parses legacy 1/0 booleans correctly', async () => {
    const xml = base.replace('<IsRunning>True</IsRunning>', '<IsRunning>1</IsRunning>')
                    .replace('<IsTransmitting>False</IsTransmitting>', '<IsTransmitting>0</IsTransmitting>');
    const r = await parseRadio(Buffer.from(xml));
    assert.equal(r.is_running, 1);
    assert.equal(r.is_transmitting, 0);
  });

  it('handles missing optional fields without throwing', async () => {
    const minimal = `<RadioInfo>
      <RadioNr>2</RadioNr>
      <Freq>7025000</Freq>
      <Mode>CW</Mode>
    </RadioInfo>`;
    const r = await parseRadio(Buffer.from(minimal));
    assert.equal(r.radio_nr, 2);
    assert.equal(r.station_name, '');
    assert.equal(r.is_running, 0);
    assert.equal(r.focus_radio, null);
    assert.equal(r.active_radio, null);
  });

  it('rejects non-RadioInfo XML', async () => {
    await assert.rejects(
      () => parseRadio(Buffer.from('<Score><qsos>1</qsos></Score>')),
      /Not a RadioInfo packet/
    );
  });

  it('rejects malformed XML', async () => {
    await assert.rejects(() => parseRadio(Buffer.from('not xml at all')));
  });

  it('handles concurrent calls without corrupting results', async () => {
    const xml2 = base.replace('<RadioNr>1</RadioNr>', '<RadioNr>2</RadioNr>')
                     .replace('<Freq>14025000</Freq>', '<Freq>21025000</Freq>');
    const [r1, r2] = await Promise.all([
      parseRadio(Buffer.from(base)),
      parseRadio(Buffer.from(xml2)),
    ]);
    assert.equal(r1.radio_nr, 1);
    assert.equal(r1.freq, '14025000');
    assert.equal(r2.radio_nr, 2);
    assert.equal(r2.freq, '21025000');
  });
});
