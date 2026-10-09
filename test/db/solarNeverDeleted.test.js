// CJ, 2026-10-09: solar data is NEVER to be deleted under any circumstance.
// This guards the rule two ways: no code path can even express a delete of
// solar_snapshots, and the operations that do delete things (contest reset,
// callsign-cache clear) provably leave it alone.
process.env.DB_PATH = ':memory:';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb, getDb } = require('../../src/db/index');
const q = require('../../src/db/queries');

const ROOT = path.join(__dirname, '../..');

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(p);
    return /\.(js|sql)$/.test(e.name) ? [p] : [];
  });
}

describe('solar_snapshots is never deleted', () => {
  before(() => initDb());
  after(() => { q.resetStatements(); closeDb(); });

  it('no source file deletes from, drops or truncates solar_snapshots', () => {
    const bad = /(DELETE\s+FROM|DROP\s+TABLE(\s+IF\s+EXISTS)?|TRUNCATE)\s+["`]?solar_snapshots/i;
    const files = [...sources(path.join(ROOT, 'src')), ...sources(path.join(ROOT, 'hamdata')), ...sources(path.join(ROOT, 'migrations'))];
    for (const f of files) {
      assert.doesNotMatch(fs.readFileSync(f, 'utf8'), bad, `${path.relative(ROOT, f)} deletes solar data`);
    }
  });

  it('survives a contest reset and a callsign-cache clear', () => {
    q.insertSolarSnapshot({ sfi: 120, a: 5, k: 2, fetched_at: '2020-01-01 00:00:00' });
    q.insertSolarSnapshot({ sfi: 130, a: 6, k: 3 });
    q.cacheCallsign('W1AW', { call: 'W1AW', found: true }, 'hamqth');
    q.clearQsos();
    q.clearCallsignCache();
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM solar_snapshots').get().c, 2);
  });
});
