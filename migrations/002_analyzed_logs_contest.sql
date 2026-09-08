-- analyzed_logs predates the v2 per-contest exchange parser (see
-- src/analyze/contests.js). Add contest_key / exchange_parsed. SQLite's
-- ALTER TABLE ADD COLUMN can't be made conditional, so recreate the table
-- -- the same idempotent recreate pattern as
-- 001_radio_state_composite_key.sql. Harmless on a fresh install where
-- schema.sql already has the target shape (it just re-copies the rows,
-- which is wasteful but not incorrect).

ALTER TABLE analyzed_logs RENAME TO analyzed_logs_old;

CREATE TABLE analyzed_logs (
  id            TEXT PRIMARY KEY,
  filename      TEXT,
  format        TEXT,
  contest       TEXT,
  contest_key   TEXT,
  exchange_parsed INTEGER DEFAULT 0,
  station_call  TEXT,
  operators     TEXT,
  claimed_score INTEGER,
  qso_count     INTEGER DEFAULT 0,
  has_points    INTEGER DEFAULT 0,
  has_mults     INTEGER DEFAULT 0,
  has_operator  INTEGER DEFAULT 0,
  has_run_flag  INTEGER DEFAULT 0,
  raw_bytes     INTEGER DEFAULT 0,
  parsed_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO analyzed_logs
  (id, filename, format, contest, station_call, operators, claimed_score,
   qso_count, has_points, has_mults, has_operator, has_run_flag, raw_bytes,
   parsed_json, created_at)
SELECT
  id, filename, format, contest, station_call, operators, claimed_score,
  qso_count, has_points, has_mults, has_operator, has_run_flag, raw_bytes,
  parsed_json, created_at
FROM analyzed_logs_old;

DROP TABLE analyzed_logs_old;

CREATE INDEX IF NOT EXISTS idx_analyzed_logs_created ON analyzed_logs(created_at);
