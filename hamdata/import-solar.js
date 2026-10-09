// One-time seed: copy solar_snapshots from an existing contestscore DB into
// hamdata's, so hamdata starts with the history that instance already has
// (and a new instance can back-fill all of it). Safe to re-run: only rows
// newer than hamdata's newest reading are copied.
//
//   HAMDATA_DB_PATH=/opt/contestscore/hamdata/data/hamdata.db \
//     node hamdata/import-solar.js /opt/contestscore/app/data/qsos.db
//
// Stop hamdata first, or run it before hamdata's first start.

const path = require('path');

const src = process.argv[2];
if (!src) {
  console.error('usage: node hamdata/import-solar.js <source contestscore .db>');
  process.exit(2);
}
process.env.DB_PATH = process.env.HAMDATA_DB_PATH || './data/hamdata.db';

const { initDb, getDb } = require('../src/db');

initDb();
const db = getDb();
db.prepare('ATTACH DATABASE ? AS src').run(path.resolve(src));
const newest = db.prepare('SELECT MAX(fetched_at) AS m FROM main.solar_snapshots').get().m || '';
const info = db.prepare(`
  INSERT INTO main.solar_snapshots (sfi, a_index, k_index, sunspots, xray, geomag, source_updated, fetched_at)
  SELECT sfi, a_index, k_index, sunspots, xray, geomag, source_updated, fetched_at
  FROM src.solar_snapshots WHERE fetched_at > ? ORDER BY fetched_at, id
`).run(newest);
db.prepare('DETACH DATABASE src').run();
console.log(`imported ${info.changes} solar readings into ${process.env.DB_PATH}`);
