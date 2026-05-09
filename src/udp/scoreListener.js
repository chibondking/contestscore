const dgram = require('dgram');
const { parseScore } = require('../parsers/score');

function createScoreListener(port, emitter) {
  const sock = dgram.createSocket('udp4');

  sock.on('message', async (buf) => {
    try {
      const data = await parseScore(buf);
      emitter.emit('score:update', data);
    } catch (err) {
      console.error('scoreListener parse error:', err.message, buf.toString());
    }
  });

  sock.on('error', (err) => console.error('scoreListener socket error:', err));

  sock.bind(port, () => console.log(`Score listener bound to UDP :${port}`));
  return sock;
}

module.exports = { createScoreListener };
