const { createServer } = require('http');
const app = require('./app');
const { initDb } = require('./db');
const { startListeners } = require('./udp');
const { initSocket } = require('./socket');
const { startMonitor } = require('./state/bridgeStatus');
const { createSolarService } = require('./solar');
const config = require('../config/default.json');
const { getTenant } = require('./tenant');
const { resolveHamdataUrl } = require('./hamdata/client');

// Tenant mode (src/tenant.js) is only valid against a shared hamdata --
// fail loudly at startup rather than run a hosted scoreboard that quietly
// polls hamqsl itself and has no callsign lookup. getTenant() also throws
// on a malformed CONTESTSCORE_TENANT.
const tenant = getTenant();
if (tenant && !resolveHamdataUrl(process.env, config)) {
  console.error(`tenant ${tenant.call}: HAMDATA_URL is required in tenant mode -- refusing to start`);
  process.exit(1);
}
if (tenant) console.log(`tenant mode: ${tenant.call} (${tenant.name})`);

const port = process.env.HTTP_PORT || config.http.port;
// Default 0.0.0.0 suits a LAN/Pi install reached directly by hostname; a
// reverse-proxied deployment should set HTTP_HOST=127.0.0.1 so the app is
// only reachable through the proxy, not directly on the public interface.
const host = process.env.HTTP_HOST || config.http.host;

initDb();

const httpServer = createServer(app);
const io = initSocket(httpServer);
app.set('io', io);

startListeners(io);
startMonitor(io);
createSolarService({ io }).start();

httpServer.listen(port, host, () => {
  console.log(`contestscore running at http://${host}:${port}`);
});
