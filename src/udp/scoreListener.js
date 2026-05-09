const dgram = require('dgram');
const { parseScore } = require('../parsers/score');

function createScoreListener(port, emitter) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', async (buf, rinfo) => {
    try {
      const data = await parseScore(buf);
      emitter.emit('score:update', data);
    } catch (err) {
      console.error(`scoreListener parse error from ${rinfo.address}: ${err.message}`);
      console.error('raw:', buf.toString().slice(0, 200));
    }
  });

  sock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`scoreListener: port ${port} already in use — is another instance running?`);
      process.exit(1);
    }
    console.error('scoreListener socket error:', err);
  });

  sock.bind(port, () => {
    sock.setBroadcast(true);
    console.log(`Score listener bound to UDP :${port}`);
  });

  return sock;
}

module.exports = { createScoreListener };
