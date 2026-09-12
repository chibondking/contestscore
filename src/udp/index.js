const EventEmitter = require('events');
const { createRadioListener } = require('./radioListener');
const { createContactListener } = require('./contactListener');
const { createScoreListener } = require('./scoreListener');
const {
  upsertRadio, upsertQso, getPersistedQso, deleteQso, insertScoreBreakdown, cacheCallsign,
} = require('../db/queries');
const { freqToBand } = require('../parsers/util');
const { enrichGeo } = require('../analyze/geo');
const { createLookupService } = require('../lookup');
const config = require('../../config/default.json');

const emitter = new EventEmitter();

// Per CLAUDE.md: parser/packet errors must never crash the server. A DB
// write can also fail (e.g. a genuine natural-key collision from two
// distinct QSOs) — log and carry on rather than take the process down.
function safely(label, fn) {
  try { fn(); } catch (err) { console.error(`DB error (${label}): ${err.message}`); }
}

function startListeners(io) {
  // Live callsign lookup (HamQTH). No-op unless LOOKUP_PROVIDER + creds are
  // set. Never used by the offline analyzer.
  const lookup = createLookupService({ emitter });

  emitter.on('radio:update', (data) => {
    safely('radio:update', () => upsertRadio(data));
    // The exact freq/tx_freq stay in radio_state (upsertRadio, above) --
    // they just never go out over the wire to a browser. Every connected
    // dashboard gets this event, so anyone with the URL could otherwise
    // read the running frequency straight out of the socket payload even
    // though the UI itself only ever displays the band (see
    // freqToBand()'s own comment).
    const { freq, tx_freq, ...rest } = data;
    io.emit('radio:update', { ...rest, band: freqToBand(freq) });
  });

  emitter.on('contact:new', (data) => {
    // Fill continent / CQ zone / DXCC prefix from the country file, forcing
    // all three from the callsign rather than trusting whatever the packet
    // carries. not1mm's contactinfo packet hardcodes continent="NA"
    // countryprefix="K" on every QSO; separately, a key-name typo in its
    // ADD-path sender (contact_info["zn"] instead of ["zone"]) means the
    // zone field it actually sends never gets touched either and stays
    // frozen at its own class-level default ("5") for every QSO --
    // confirmed against not1mm's source, reported upstream. Same helper the
    // log analyzer uses (analyzer keeps the plain fill-only behaviour --
    // an uploaded Cabrillo/ADIF's zone, when present, came from a real
    // exchange, not a logger default).
    enrichGeo(data, { override: ['continent', 'countryprefix', 'zone'] });
    // Emit the row as stored, not the parsed packet: the DB fills `logged_at`
    // (our UTC ingest time) and `id`, and the parsed packet carries neither.
    // The dashboard's per-operator peak-rate buckets key off `logged_at`, so
    // emitting the raw packet drops every live QSO after page load from that
    // aggregate -- the columns freeze at the initial /api/qsos snapshot.
    let persisted = null;
    safely('contact:new', () => { upsertQso(data); persisted = getPersistedQso(data); });
    io.emit('contact:new', persisted || data);
    if (data.call) lookup.enqueue(data.call);
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
      grid6: data.grid6,
      breakdown: data.breakdown,
    });
  });

  // Single writer to callsign_cache -- fed by N1MM's own <lookupinfo>
  // (source 'n1mm') and by the HamQTH lookup service (source 'hamqth').
  emitter.on('lookup:result', (data) => {
    safely('lookup:result', () => { if (data.call) cacheCallsign(data.call, data, data.source || 'n1mm'); });
    io.emit('lookup:result', data);
  });

  // Back-fill lookups for QSOs already logged (server restarted mid-contest).
  lookup.prime();

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
