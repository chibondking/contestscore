const express = require('express');
const path = require('path');
const apiRouter = require('./routes/api');
const ingestRouter = require('./routes/ingest');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Mounted before apiRouter's express.json() would matter: these routes
// parse their own raw body (see routes/ingest.js) and express.json() only
// consumes requests actually declaring Content-Type: application/json, so
// it doesn't interfere with the bridge's raw XML POSTs.
app.use('/api/ingest', ingestRouter);
app.use('/api', apiRouter);

module.exports = app;
