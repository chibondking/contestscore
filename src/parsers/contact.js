const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

function toBool(val) {
  if (val == null) return 0;
  const s = String(val).toLowerCase();
  return s === 'true' || s === '1' ? 1 : 0;
}

async function parseContact(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const c = result.ContactInfo;
  if (!c) throw new Error('Not a ContactInfo packet');
  return {
    call:           c.call || '',
    band:           c.band || '',
    mode:           c.mode || '',
    operator:       c.operator || '',
    mycall:         c.mycall || '',
    contestname:    c.contestname || '',
    srx:            c.srx || '',
    stx:            c.stx || '',
    snt:            c.snt || '',
    rcv:            c.rcv || '',
    mult1:          c.mult1 || '',
    mult2:          c.mult2 || '',
    is_mult1:       toBool(c.IsMultiplier1),
    is_mult2:       toBool(c.IsMultiplier2),
    points:         Number(c.points) || 0,
    exchange1:      c.exchange1 || '',
    section:        c.section || '',
    rover_loc:      c.RoverLocation || '',
    radio_nr:       c.RadioInterfaced != null ? Number(c.RadioInterfaced) : null,
    comp_nr:        c.NetworkedCompNr != null ? Number(c.NetworkedCompNr) : null,
    is_new_qso:     toBool(c.IsNewQso != null ? c.IsNewQso : 1),
    delete_contact: toBool(c.DeleteContact),
  };
}

module.exports = { parseContact };
