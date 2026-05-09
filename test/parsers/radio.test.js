const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRadio } = require('../../src/parsers/radio');

const sample = `<RadioInfo>
  <StationName>K1TTT</StationName>
  <RadioNr>1</RadioNr>
  <Freq>14025000</Freq>
  <TXFreq>14025000</TXFreq>
  <Mode>CW</Mode>
  <OpCall>K1TTT</OpCall>
  <IsRunning>1</IsRunning>
  <FocusEntry>1</FocusEntry>
  <Antenna>Yagi</Antenna>
  <Rotator>North</Rotator>
  <FocusRadioNr>1</FocusRadioNr>
</RadioInfo>`;

describe('parseRadio', () => {
  it('extracts expected fields', async () => {
    const result = await parseRadio(Buffer.from(sample));
    assert.equal(result.radio_nr, 1);
    assert.equal(result.mode, 'CW');
    assert.equal(result.is_running, 1);
    assert.equal(result.freq, '14025000');
  });
});
