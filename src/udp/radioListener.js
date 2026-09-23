const dgram = require('dgram');
const { parseRadio } = require('../parsers/radio');
const { handleAnyBuffer } = require('./dispatch');

// Parses one RadioInfo packet and emits radio:update. Split out from the
// dgram socket so the exact same logic runs whether the bytes arrived over
// UDP (LAN) or via the authenticated HTTP ingest route (src/routes/ingest.js,
// used by the Go relay bridge for off-LAN deployments) — see CLAUDE.md.
async function handleRadioBuffer(buf, emitter, source) {
  try {
    const data = await parseRadio(buf);
    emitter.emit('radio:update', data);
  } catch (err) {
    console.error(`radioListener parse error from ${source}: ${err.message}`);
    console.error('raw:', buf.toString().slice(0, 200));
  }
}

function createRadioListener(port, emitter) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  // Set true only once bind() actually succeeds -- GET /api/health reads
  // this to report whether the socket is really listening, not just that
  // createRadioListener() was called (bind is async; a failure fires the
  // 'error' handler below instead of the bind callback).
  sock.bound = false;

  // Dispatches by the packet's own root element, not just "this arrived on
  // the radio port so it must be RadioInfo" -- a live capture showed a
  // Score broadcast landing on this port instead (see dispatch.js's header
  // comment), which a port-trusting listener would just silently reject.
  sock.on('message', (buf, rinfo) => {
    handleAnyBuffer(buf, emitter, rinfo.address);
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
    sock.bound = true;
    console.log(`Radio listener bound to UDP :${port}`);
  });

  return sock;
}

module.exports = { createRadioListener, handleRadioBuffer };
