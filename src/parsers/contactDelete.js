const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

// N1MM broadcasts a deleted QSO as its own packet type — root <contactdelete>
// — rather than a flag inside ContactInfo. Its field set is deliberately
// small: just enough to identify the row (call/band/mycall/contestnr, plus
// the <ID> GUID when available).
async function parseContactDelete(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const c = result.contactdelete;
  if (!c) throw new Error('Not a contactdelete packet');
  return {
    ext_id:         c.ID || null,
    call:           c.call || '',
    band:           c.band || '',
    mycall:         c.mycall || '',
    contestnr:      c.contestnr || '',
    station_name:   c.StationName || '',
    n1mm_timestamp: c.timestamp || '',
  };
}

module.exports = { parseContactDelete };
