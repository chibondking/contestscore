const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

async function parseLookup(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const l = result.lookupinfo;
  if (!l) throw new Error('Not a lookupinfo packet');
  return {
    call:    l.call || '',
    name:    l.name || '',
    country: l.country || '',
    grid:    l.grid || '',
    state:   l.state || '',
    county:  l.county || '',
    cqzone:  l.cqzone || '',
    ituzone: l.ituzone || '',
    dxcc:    l.dxcc || '',
    continent: l.continent || '',
  };
}

module.exports = { parseLookup };
