const xml2js = require('xml2js');

const parser = new xml2js.Parser({ explicitArray: false, trim: true });

async function parseRadio(buf) {
  const result = await parser.parseStringPromise(buf.toString());
  const r = result.RadioInfo;
  return {
    radio_nr:     Number(r.RadioNr) || 0,
    station_name: r.StationName || '',
    freq:         r.Freq || '',
    tx_freq:      r.TXFreq || '',
    mode:         r.Mode || '',
    op_call:      r.OpCall || '',
    is_running:   r.IsRunning === '1' ? 1 : 0,
    focus_entry:  r.FocusEntry != null ? Number(r.FocusEntry) : null,
    antenna:      r.Antenna || '',
    rotator:      r.Rotator || '',
    focus_radio:  r.FocusRadioNr != null ? Number(r.FocusRadioNr) : null,
  };
}

module.exports = { parseRadio };
