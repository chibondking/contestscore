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

// Parses one contact-port packet (contactinfo/contactreplace/contactdelete/
// lookupinfo, disambiguated by root element) and emits the matching event.
// Split out from the dgram socket so the exact same logic runs whether the
// bytes arrived over UDP (LAN) or via the authenticated HTTP ingest route
// (src/routes/ingest.js, used by the Go relay bridge for off-LAN
// deployments) — see CLAUDE.md.
async function handleContactBuffer(buf, emitter, source) {
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
        console.warn(`contactListener: unexpected root element <${root}> from ${source}`);
    }
  } catch (err) {
    console.error(`contactListener parse error from ${source}: ${err.message}`);
    console.error('raw:', buf.toString().slice(0, 200));
  }
}

function createContactListener(port, emitter) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (buf, rinfo) => {
    handleContactBuffer(buf, emitter, rinfo.address);
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

module.exports = { createContactListener, handleContactBuffer };
