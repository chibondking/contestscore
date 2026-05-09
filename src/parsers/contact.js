const xml2js = require('xml2js');

const parser = new xml2js.Parser({ explicitArray: false, trim: true });

async function parseContact(buf) {
  const result = await parser.parseStringPromise(buf.toString());
  const c = result.ContactInfo;
  return {
    call:        c.call || '',
    band:        c.band || '',
    mode:        c.mode || '',
    operator:    c.operator || '',
    mycall:      c.mycall || '',
    contestname: c.contestname || '',
    srx:         c.srx || '',
    stx:         c.stx || '',
    snt:         c.snt || '',
    rcv:         c.rcv || '',
    mult1:       c.mult1 || '',
    mult2:       c.mult2 || '',
    is_mult1:    c.IsMultiplier1 === '1' ? 1 : 0,
    is_mult2:    c.IsMultiplier2 === '1' ? 1 : 0,
    points:      Number(c.points) || 0,
    exchange1:   c.exchange1 || '',
    section:     c.section || '',
    rover_loc:   c.RoverLocation || '',
    radio_nr:    Number(c.RadioInterfaced) || null,
    comp_nr:     Number(c.NetworkedCompNr) || null,
  };
}

module.exports = { parseContact };
