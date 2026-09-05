const EventEmitter = require('events');
const { createRadioListener } = require('./radioListener');
const { createContactListener } = require('./contactListener');
const { createScoreListener } = require('./scoreListener');
const {
  upsertRadio, upsertQso, deleteQso, insertScoreBreakdown, cacheCallsign,
} = require('../db/queries');
const config = require('../../config/default.json');

const emitter = new EventEmitter();

// Per CLAUDE.md: parser/packet errors must never crash the server. A DB
// write can also fail (e.g. a genuine natural-key collision from two
// distinct QSOs) — log and carry on rather than take the process down.
function safely(label, fn) {
  try { fn(); } catch (err) { console.error(`DB error (${label}): ${err.message}`); }
}

function startListeners(io) {
  emitter.on('radio:update', (data) => {
    safely('radio:update', () => upsertRadio(data));
    io.emit('radio:update', data);
  });

  emitter.on('contact:new', (data) => {
    safely('contact:new', () => upsertQso(data));
    io.emit('contact:new', data);
  });

  emitter.on('contact:delete', (data) => {
    safely('contact:delete', () => deleteQso(data));
    io.emit('contact:delete', data);
  });

  emitter.on('score:update', (data) => {
    safely('score:update', () => insertScoreBreakdown(data));

    // Shape a convenience payload for clients: the contest-total row plus
    // the full per-band/mode breakdown, so a Band Stats view can update
    // live without a separate REST round-trip.
    const total = (data.breakdown || []).find((b) => b.is_total) || null;
    io.emit('score:update', {
      contest: data.contest,
      call: data.call,
      qsos: total ? total.qsos : null,
      points: total ? total.points : null,
      mults: total ? total.mults : null,
      total: data.score_total,
      breakdown: data.breakdown,
    });
  });

  emitter.on('lookup:result', (data) => {
    safely('lookup:result', () => { if (data.call) cacheCallsign(data.call, data, 'n1mm'); });
    io.emit('lookup:result', data);
  });

  const radioPort = Number(process.env.UDP_RADIO_PORT) || config.udp.radioPort;
  const contactPort = Number(process.env.UDP_CONTACT_PORT) || config.udp.contactPort;
  const scorePort = Number(process.env.UDP_SCORE_PORT) || config.udp.scorePort;

  // Returned so callers (tests, graceful shutdown) can close the sockets —
  // an open dgram socket otherwise keeps the process/test-runner alive.
  return [
    createRadioListener(radioPort, emitter),
    createContactListener(contactPort, emitter),
    createScoreListener(scorePort, emitter),
  ];
}

module.exports = { startListeners, emitter };
