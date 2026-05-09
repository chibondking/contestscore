const dgram = require('dgram');
const { parseRadio } = require('../parsers/radio');

function createRadioListener(port, emitter) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', async (buf, rinfo) => {
    try {
      const data = await parseRadio(buf);
      emitter.emit('radio:update', data);
    } catch (err) {
      console.error(`radioListener parse error from ${rinfo.address}: ${err.message}`);
      console.error('raw:', buf.toString().slice(0, 200));
    }
  });

  sock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`radioListener: port ${port} already in use — is another instance running?`);
      process.exit(1);
    }
    console.error('radioListener socket error:', err);
  });

  sock.bind(port, () => {
    sock.setBroadcast(true);
    console.log(`Radio listener bound to UDP :${port}`);
  });

  return sock;
}

module.exports = { createRadioListener };
