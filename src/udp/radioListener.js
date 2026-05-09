const dgram = require('dgram');
const { parseRadio } = require('../parsers/radio');

function createRadioListener(port, emitter) {
  const sock = dgram.createSocket('udp4');

  sock.on('message', async (buf) => {
    try {
      const data = await parseRadio(buf);
      emitter.emit('radio:update', data);
    } catch (err) {
      console.error('radioListener parse error:', err.message, buf.toString());
    }
  });

  sock.on('error', (err) => console.error('radioListener socket error:', err));

  sock.bind(port, () => console.log(`Radio listener bound to UDP :${port}`));
  return sock;
}

module.exports = { createRadioListener };
