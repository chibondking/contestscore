const dgram = require('dgram');
const { parseContact } = require('../parsers/contact');
const { parseLookup } = require('../parsers/lookup');

function createContactListener(port, emitter) {
  const sock = dgram.createSocket('udp4');

  sock.on('message', async (buf) => {
    const raw = buf.toString();
    try {
      if (raw.includes('<lookupinfo>')) {
        const data = await parseLookup(buf);
        emitter.emit('lookup:result', data);
      } else {
        const data = await parseContact(buf);
        emitter.emit('contact:new', data);
      }
    } catch (err) {
      console.error('contactListener parse error:', err.message, raw);
    }
  });

  sock.on('error', (err) => console.error('contactListener socket error:', err));

  sock.bind(port, () => console.log(`Contact listener bound to UDP :${port}`));
  return sock;
}

module.exports = { createContactListener };
