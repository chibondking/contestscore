const express = require('express');
const path = require('path');
const apiRouter = require('./routes/api');
const ingestRouter = require('./routes/ingest');
const analyzeRouter = require('./routes/analyze');
const { servePage } = require('./pages');

const app = express();

app.use(express.json());
// Every page through src/pages.js (shared partials, versioned script and
// style URLs), ahead of express.static so a raw page is never served.
app.get(['/', '/index.html'], servePage('index.html'));
app.get(['/map', '/map.html'], servePage('map.html'));
for (const page of ['charts', 'stats', 'solar', 'admin']) app.get(`/${page}.html`, servePage(`${page}.html`));
// The analyzer upload page and every /analyze/<id> result link are the
// same page; analyze.js reads the id off the path.
app.get(['/analyze', '/analyze/:id', '/analyze.html'], servePage('analyze.html'));
// Log-vs-log comparison: /compare?a=<id>&b=<id> (compare.js reads the query).
app.get(['/compare', '/compare.html'], servePage('compare.html'));
app.use(express.static(path.join(__dirname, '../public')));


// Mounted before apiRouter's express.json() would matter: these routes
// parse their own raw body (see routes/ingest.js) and express.json() only
// consumes requests actually declaring Content-Type: application/json, so
// it doesn't interfere with the bridge's raw XML POSTs.
app.use('/api/ingest', ingestRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api', apiRouter);

module.exports = app;
