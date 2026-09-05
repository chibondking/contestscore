const { createServer } = require('http');
const app = require('./app');
const { initDb } = require('./db');
const { startListeners } = require('./udp');
const { initSocket } = require('./socket');
const { startMonitor } = require('./state/bridgeStatus');
const config = require('../config/default.json');

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

httpServer.listen(port, host, () => {
  console.log(`contestscore running at http://${host}:${port}`);
});
