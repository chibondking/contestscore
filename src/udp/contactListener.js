const dgram = require('dgram');
const { parseContact } = require('../parsers/contact');
const { parseContactDelete } = require('../parsers/contactDelete');
const { parseLookup } = require('../parsers/lookup');
const { getRootElement, handleAnyBuffer } = require('./dispatch');

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
      // N1MM's DX cluster/RBN spot broadcasts arrive on this same port when
      // enabled. Deliberately, permanently out of scope (see CLAUDE.md's
      // Prime Directive) -- contestscore shows contest results, not spots,
      // and N1MM typically already feeds spots directly to other software
      // (e.g. a FlexRadio's own panadapter integration) through its own
      // channel. Silently ignored, not logged as unexpected: this is
      // expected, known traffic we're intentionally not acting on.
      case 'spot':
        return;
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

  // Dispatches by the packet's own root element rather than assuming
  // everything on this port is contact-family traffic -- see dispatch.js's
  // header comment for why port labels can't be trusted alone.
  sock.on('message', (buf, rinfo) => {
    handleAnyBuffer(buf, emitter, rinfo.address);
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
