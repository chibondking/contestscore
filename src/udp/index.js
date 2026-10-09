const EventEmitter = require('events');
const { createRadioListener } = require('./radioListener');
const { createContactListener } = require('./contactListener');
const { createScoreListener } = require('./scoreListener');
const {
  upsertRadio, upsertQso, getPersistedQso, deleteQso, insertScoreBreakdown, cacheCallsign,
  getCachedLocation,
} = require('../db/queries');
const { freqToBand } = require('../parsers/util');
const { enrichGeo, gridToLatLon, resolveLatLonEnriched } = require('../analyze/geo');
const { createLookupService, stripSuffix } = require('../lookup');
const { getTenant } = require('../tenant');
const config = require('../../config/default.json');

const emitter = new EventEmitter();

// Set once startListeners() creates the lookup service, so a route handler
// (src/routes/api.js's pause/resume/status endpoints) called at request
// time -- long after server boot -- can reach the live instance. null in
// any environment that never calls startListeners() (e.g. the route-only
// test harness in test/routes/api.test.js), which the routes treat as
// "no lookup service running", not an error.
let lookupService = null;
function getLookupService() { return lookupService; }

// Set once startListeners() creates the three UDP sockets -- GET /api/health
// reads each one's own .bound flag (see radioListener.js et al.) to report
// whether the listener actually bound, not just that this process attempted
// to start it. null in the same "never called startListeners()" case as
// lookupService above.
let udpListeners = null;
function getUdpListeners() { return udpListeners; }

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
  lookupService = lookup;

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
    // lat/lon for the world map, same computed-not-stored treatment as
    // GET /api/qsos (src/routes/api.js) -- attached to the emitted copy
    // only, never passed to upsertQso above. Prefers a HamQTH/lookup-service
    // grid already on file for this call over the old country-file/call-area
    // estimate; see src/analyze/geo.js's resolveLatLonEnriched header
    // comment. A DB read failure here must not take the live feed down with
    // it, so it's caught the same way isCached() guards the lookup queue
    // itself (src/lookup/index.js) -- worst case this one contact's dot
    // falls back to the old estimate instead of blocking the whole emit.
    const toEmit = persisted || data;
    let cached = null;
    if (toEmit.call) {
      try { cached = getCachedLocation(stripSuffix(toEmit.call)); } catch { cached = null; }
    }
    io.emit('contact:new', { ...toEmit, ...(resolveLatLonEnriched(toEmit, cached) || {}) });
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
      soft: data.soft || '',
      breakdown: data.breakdown,
    });
  });

  // Single writer to callsign_cache -- fed by N1MM's own <lookupinfo>
  // (source 'n1mm') and by the HamQTH lookup service (source 'hamqth').
  emitter.on('lookup:result', (data) => {
    safely('lookup:result', () => { if (data.call) cacheCallsign(data.call, data, data.source || 'n1mm'); });
    // The world-map location this result implies, so the dashboard can move
    // the dots already plotted for this call. contact:new is emitted BEFORE
    // the call is ever enqueued for lookup, so a first-time call's dot goes
    // out on the country-file estimate; without this the better grid only
    // reached the map on a page reload (GET /api/qsos reads the cache).
    // Same rule as resolveLatLonEnriched: only a found result's grid
    // counts, and the client still lets a QSO's own exchange grid win.
    const loc = data.found ? gridToLatLon(data.grid) : null;
    io.emit('lookup:result', loc
      ? { ...data, base: stripSuffix(data.call), lat: loc.lat, lon: loc.lon, locSource: data.source || 'lookup' }
      : data);
  });

  // Back-fill lookups for QSOs already logged (server restarted mid-contest).
  lookup.prime();

  // A hosted (tenant) scoreboard only ever receives data over authenticated
  // HTTPS from ContestPulse (/api/ingest/*, which feeds this same emitter).
  // N1MM's UDP broadcasts never reach a VPS, and an open UDP socket there
  // is an unauthenticated way to inject QSOs -- and several tenants would
  // fight over the same three ports. So: handlers above, no sockets.
  // getUdpListeners() stays null, which /api/health reads as "no UDP to
  // check", not as a failure.
  let tenant = null;
  try { tenant = getTenant(); } catch { tenant = null; }
  if (tenant) {
    udpListeners = null;
    return [];
  }

  const radioPort = Number(process.env.UDP_RADIO_PORT) || config.udp.radioPort;
  const contactPort = Number(process.env.UDP_CONTACT_PORT) || config.udp.contactPort;
  const scorePort = Number(process.env.UDP_SCORE_PORT) || config.udp.scorePort;

  // Returned so callers (tests, graceful shutdown) can close the sockets —
  // an open dgram socket otherwise keeps the process/test-runner alive.
  const listeners = [
    createRadioListener(radioPort, emitter),
    createContactListener(contactPort, emitter),
    createScoreListener(scorePort, emitter),
  ];
  udpListeners = { radio: listeners[0], contact: listeners[1], score: listeners[2] };
  return listeners;
}

module.exports = { startListeners, emitter, getLookupService, getUdpListeners };
