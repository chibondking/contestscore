const express = require('express');
const path = require('path');
const apiRouter = require('./routes/api');
const ingestRouter = require('./routes/ingest');
const analyzeRouter = require('./routes/analyze');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// The analyzer upload page and every /analyze/<id> result link are served
// by the same static shell; analyze.js reads the id off the path. Declared
// before the routers so it can't be shadowed, after express.static so a
// real /analyze.html still wins.
app.get(['/analyze', '/analyze/:id'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/analyze.html'));
});
// Log-vs-log comparison: /compare?a=<id>&b=<id> (compare.js reads the query).
app.get('/compare', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/compare.html'));
});

// Mounted before apiRouter's express.json() would matter: these routes
// parse their own raw body (see routes/ingest.js) and express.json() only
// consumes requests actually declaring Content-Type: application/json, so
// it doesn't interfere with the bridge's raw XML POSTs.
app.use('/api/ingest', ingestRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api', apiRouter);

module.exports = app;
