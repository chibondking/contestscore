const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

// N1MM sends True/False for booleans; older versions may send 1/0
function toBool(val) {
  if (val == null) return 0;
  const s = String(val).toLowerCase();
  return s === 'true' || s === '1' ? 1 : 0;
}

async function parseRadio(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const r = result.RadioInfo;
  if (!r) throw new Error('Not a RadioInfo packet');
  return {
    radio_nr:        Number(r.RadioNr) || 0,
    station_name:    r.StationName || '',
    freq:            r.Freq || '',
    tx_freq:         r.TXFreq || '',
    mode:            r.Mode || '',
    op_call:         r.OpCall || '',
    is_running:      toBool(r.IsRunning),
    is_transmitting: toBool(r.IsTransmitting),
    focus_entry:     r.FocusEntry != null ? Number(r.FocusEntry) : null,
    antenna:         r.Antenna || '',
    rotator:         r.Rotors || r.Rotator || '',
    focus_radio:     r.FocusRadioNr != null ? Number(r.FocusRadioNr) : null,
    active_radio:    r.ActiveRadioNr != null ? Number(r.ActiveRadioNr) : null,
  };
}

module.exports = { parseRadio };
