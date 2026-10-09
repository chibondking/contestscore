// hamdata -- shared solar + callsign lookup service for a box running
// several contestscore instances (see README "hamdata"). One process polls
// hamqsl.com and holds the HamQTH credentials; each instance sets
// HAMDATA_URL and asks it instead. A standalone/Pi install doesn't run this.
//
// Built from contestscore's own modules (src/db, src/solar, src/lookup) so
// the in-process path and this one can't drift. Its SQLite file uses the
// same schema as an instance -- only solar_snapshots and callsign_cache are
// ever written.

// src/db reads DB_PATH when first required, so set it before anything loads
// it. HAMDATA_DB_PATH wins; never fall back to an instance's DB_PATH.
process.env.DB_PATH = process.env.HAMDATA_DB_PATH || './data/hamdata.db';

const { initDb } = require('../src/db');
const { getCachedCallsign, cacheCallsign } = require('../src/db/queries');
const { createSolarService } = require('../src/solar');
const { resolveLookupConfig } = require('../src/lookup');
const { createHamqthClient } = require('../src/lookup/hamqth');
const { createLookupBroker } = require('./broker');
const { createApp } = require('./app');

// hamdata is the thing that talks to hamqsl/HamQTH, so it must never itself
// be pointed at a hamdata (that'd be a loop).
const env = { ...process.env, HAMDATA_URL: '' };

initDb();

const solar = createSolarService({ io: null, env });
solar.start();

const lk = resolveLookupConfig(env);
let client = null;
if (lk.enabled && lk.provider === 'hamqth') {
  client = createHamqthClient({ username: lk.username, password: lk.password, prg: lk.prg });
} else {
  console.warn('hamdata: no HamQTH credentials (LOOKUP_PROVIDER=hamqth + HAMQTH_USERNAME/PASSWORD) -- lookups return 503');
}
const broker = createLookupBroker({ client, getCached: getCachedCallsign, cache: cacheCallsign });

const port = Number(process.env.HAMDATA_PORT) || 3100;
const host = process.env.HAMDATA_HOST || '127.0.0.1';
createApp({ broker, solar, env: process.env }).listen(port, host, () => {
  console.log(`hamdata running at http://${host}:${port}`);
});
