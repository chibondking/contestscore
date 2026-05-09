const xml2js = require('xml2js');

const parser = new xml2js.Parser({ explicitArray: false, trim: true });

async function parseLookup(buf) {
  const result = await parser.parseStringPromise(buf.toString());
  const l = result.lookupinfo;
  return {
    call:    l.call || '',
    name:    l.name || '',
    country: l.country || '',
    grid:    l.grid || '',
    state:   l.state || '',
    county:  l.county || '',
    cqzone:  l.cqzone || '',
    ituzone: l.ituzone || '',
  };
}

module.exports = { parseLookup };
