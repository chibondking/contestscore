const dgram = require('dgram');
const { parseScore } = require('../parsers/score');

// Parses one Score (dynamicresults) packet and emits score:update. Split out
// from the dgram socket so the exact same logic runs whether the bytes
// arrived over UDP (LAN) or via the authenticated HTTP ingest route
// (src/routes/ingest.js, used by the Go relay bridge for off-LAN
// deployments) — see CLAUDE.md.
async function handleScoreBuffer(buf, emitter, source) {
  try {
    const data = await parseScore(buf);
    emitter.emit('score:update', data);
  } catch (err) {
    console.error(`scoreListener parse error from ${source}: ${err.message}`);
    console.error('raw:', buf.toString().slice(0, 200));
  }
}

function createScoreListener(port, emitter) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (buf, rinfo) => {
    handleScoreBuffer(buf, emitter, rinfo.address);
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

module.exports = { createScoreListener, handleScoreBuffer };
