const xml2js = require('xml2js');

const parser = new xml2js.Parser({ explicitArray: false, trim: true });

async function parseScore(buf) {
  const result = await parser.parseStringPromise(buf.toString());
  const s = result.Score;
  return {
    contest:     s.contest || '',
    call:        s.call || '',
    operators:   s.operators || '',
    power:       s.power || '',
    assisted:    s.assisted === '1' ? 1 : 0,
    transmitted: s.transmitted || '',
    band:        s.band || '',
    mode:        s.mode || '',
    qsos:        Number(s.qsos) || 0,
    points:      Number(s.points) || 0,
    mults:       Number(s.mults) || 0,
    mults2:      Number(s.mults2) || 0,
    total:       Number(s.total) || 0,
  };
}

module.exports = { parseScore };
