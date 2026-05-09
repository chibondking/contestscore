const { createServer } = require('http');
const app = require('./app');
const { initDb } = require('./db');
const { startListeners } = require('./udp');
const { initSocket } = require('./socket');
const config = require('../config/default.json');

const port = process.env.HTTP_PORT || config.http.port;

initDb();

const httpServer = createServer(app);
const io = initSocket(httpServer);
app.set('io', io);

startListeners(io);

httpServer.listen(port, () => {
  console.log(`contestscore running at http://localhost:${port}`);
});
