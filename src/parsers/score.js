const xml2js = require('xml2js');

const PARSE_OPTS = { explicitArray: false, trim: true };

function toBool(val) {
  if (val == null) return 0;
  const s = String(val).toLowerCase();
  return s === 'true' || s === '1' ? 1 : 0;
}

async function parseScore(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const s = result.Score;
  if (!s) throw new Error('Not a Score packet');
  return {
    contest:     s.contest || '',
    call:        s.call || '',
    operators:   s.operators || '',
    power:       s.power || '',
    assisted:    toBool(s.assisted),
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
