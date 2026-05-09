const dgram = require('dgram');
const xml2js = require('xml2js');
const { parseContact } = require('../parsers/contact');
const { parseLookup } = require('../parsers/lookup');

const PARSE_OPTS = { explicitArray: false, trim: true };

// Detect packet type by parsing root element — more reliable than string search
async function getRootElement(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  return Object.keys(result)[0] || '';
}

function createContactListener(port, emitter) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', async (buf, rinfo) => {
    try {
      const root = await getRootElement(buf);

      if (root === 'lookupinfo') {
        const data = await parseLookup(buf);
        emitter.emit('lookup:result', data);
        return;
      }

      if (root === 'ContactInfo') {
        const data = await parseContact(buf);
        if (data.delete_contact) {
          emitter.emit('contact:delete', data);
        } else {
          emitter.emit('contact:new', data);
        }
        return;
      }

      console.warn(`contactListener: unexpected root element <${root}> from ${rinfo.address}`);
    } catch (err) {
      console.error(`contactListener parse error from ${rinfo.address}: ${err.message}`);
      console.error('raw:', buf.toString().slice(0, 200));
    }
  });

  sock.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`contactListener: port ${port} already in use — is another instance running?`);
      process.exit(1);
    }
    console.error('contactListener socket error:', err);
  });

  sock.bind(port, () => {
    sock.setBroadcast(true);
    console.log(`Contact listener bound to UDP :${port}`);
  });

  return sock;
}

module.exports = { createContactListener };
