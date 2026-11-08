// migrations/006_solar_sfi_zero_carry_forward.sql: rows stored with a
// glitched SFI of 0 take the previous non-zero reading's SFI, nothing is
// deleted, and the other indices are untouched.
process.env.DB_PATH = ':memory:';

const fs = require('node:fs');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb, getDb } = require('../../src/db/index');
const q = require('../../src/db/queries');

const SQL = fs.readFileSync(path.join(__dirname, '../../migrations/006_solar_sfi_zero_carry_forward.sql'), 'utf8');

describe('migration 006: SFI 0 carry-forward', () => {
  before(() => initDb());
  after(() => { q.resetStatements(); closeDb(); });

  it('fills each 0 from the newest earlier non-zero SFI and keeps every row', () => {
    const rows = [
      [0, 9, '2026-10-21 21:00:00'],     // nothing before it -> NULL
      [118, 10, '2026-10-21 22:00:00'],
      [0, 19, '2026-10-21 23:25:28'],    // -> 118
      [122, 12, '2026-11-06 20:27:29'],
      [0, 12, '2026-11-06 22:27:29'],    // -> 122
      [0, 12, '2026-11-07 00:27:29'],    // -> 122 (skips the other 0)
      [124, 8, '2026-11-07 02:27:29'],
    ];
    for (const [sfi, a, fetched_at] of rows) q.insertSolarSnapshot({ sfi, a, k: 2, sunspots: 0, fetched_at });

    getDb().exec(SQL);

    const out = getDb().prepare('SELECT sfi, a_index, sunspots FROM solar_snapshots ORDER BY fetched_at').all();
    assert.equal(out.length, rows.length, 'no row deleted');
    assert.deepEqual(out.map((r) => r.sfi), [null, 118, 118, 122, 122, 122, 124]);
    assert.deepEqual(out.map((r) => r.a_index), rows.map((r) => r[1]), 'A untouched');
    assert.ok(out.every((r) => r.sunspots === 0), 'a real 0 sunspot count is left alone');
  });
});
