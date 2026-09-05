const dgram = require('dgram');
const xml2js = require('xml2js');
const { parseContact } = require('../parsers/contact');
const { parseContactDelete } = require('../parsers/contactDelete');
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

      switch (root) {
        case 'lookupinfo': {
          const data = await parseLookup(buf);
          emitter.emit('lookup:result', data);
          return;
        }
        // A fresh QSO and an edited-in-place revision (N1MM re-broadcasts
        // the full record after an edit) share the same field set — both
        // resolve to an upsert at the DB layer, keyed on <ID> when present.
        case 'contactinfo':
        case 'contactreplace': {
          const data = await parseContact(buf);
          emitter.emit('contact:new', data);
          return;
        }
        // Deletes are their own packet type, not a flag inside ContactInfo.
        case 'contactdelete': {
          const data = await parseContactDelete(buf);
          emitter.emit('contact:delete', data);
          return;
        }
        default:
          console.warn(`contactListener: unexpected root element <${root}> from ${rinfo.address}`);
      }
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
