-- The (call, band, mode, contestnr, mycall) natural key was a plain
-- table-level UNIQUE(...), meant as a fallback dedupe for loggers that
-- never send a stable <ID>. But it applied to *every* row regardless of
-- whether one was present -- so a logger that does send real per-row
-- <ID>s (N1MM's own contactinfo) could still get a legitimate row
-- silently dropped the moment two of its own rows shared that tuple: a
-- WAE QTC report is a distinct record (own <ID>, own serial/misctext)
-- sent to a station on the same band/mode as an existing QSO, and several
-- QTCs in a row often go to the very same station+band+mode. Each has a
-- real ext_id, so upsertQsoByExtId's ON CONFLICT(ext_id) already handles
-- it correctly -- but that ON CONFLICT target doesn't cover a *different*
-- unique index, so the INSERT just failed outright on the natural-key
-- collision and got silently caught+logged by src/udp/index.js's
-- safely(), never reaching a viewer.
--
-- Fix: narrow the natural key to a partial index, WHERE ext_id IS NULL --
-- it only ever needs to apply to the loggers it was built for in the
-- first place. See schema.sql's own comment on the replacement index for
-- the full reasoning; this migration just gets an existing database there.
--
-- SQLite can't drop a table-level UNIQUE(...) via ALTER TABLE -- recreate
-- the table. id is INTEGER PRIMARY KEY AUTOINCREMENT; inserting explicit
-- id values (not NULL) still advances sqlite_sequence to match, so
-- existing ids and future autoincrement both come out right.
ALTER TABLE qsos RENAME TO qsos_old;

CREATE TABLE qsos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id            TEXT,
  call              TEXT NOT NULL,
  band              TEXT,
  mode              TEXT,
  operator          TEXT,
  mycall            TEXT,
  contestname       TEXT,
  contestnr         TEXT,
  rx_freq           TEXT,
  tx_freq           TEXT,
  countryprefix     TEXT,
  wpxprefix         TEXT,
  stationprefix     TEXT,
  continent         TEXT,
  snt               TEXT,
  snt_nr            TEXT,
  rcv               TEXT,
  rcv_nr            TEXT,
  gridsquare        TEXT,
  exchange1         TEXT,
  section           TEXT,
  comment           TEXT,
  op_name           TEXT,
  power             TEXT,
  misctext          TEXT,
  zone              TEXT,
  prec              TEXT,
  ck                TEXT,
  is_mult1          INTEGER DEFAULT 0,
  is_mult2          INTEGER DEFAULT 0,
  is_mult3          INTEGER DEFAULT 0,
  points            INTEGER DEFAULT 0,
  radio_nr          INTEGER,
  run1run2          TEXT,
  rover_loc         TEXT,
  radio_interfaced  INTEGER,
  comp_nr           INTEGER,
  is_original       INTEGER DEFAULT 1,
  netbios_name      TEXT,
  is_run_qso        INTEGER DEFAULT 0,
  station_name      TEXT,
  is_claimed_qso    INTEGER DEFAULT 1,
  sent_exchange     TEXT,
  n1mm_timestamp    TEXT,
  logged_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO qsos
  (id, ext_id, call, band, mode, operator, mycall, contestname, contestnr,
   rx_freq, tx_freq, countryprefix, wpxprefix, stationprefix, continent,
   snt, snt_nr, rcv, rcv_nr, gridsquare, exchange1, section, comment,
   op_name, power, misctext, zone, prec, ck, is_mult1, is_mult2, is_mult3,
   points, radio_nr, run1run2, rover_loc, radio_interfaced, comp_nr,
   is_original, netbios_name, is_run_qso, station_name, is_claimed_qso,
   sent_exchange, n1mm_timestamp, logged_at)
SELECT
  id, ext_id, call, band, mode, operator, mycall, contestname, contestnr,
  rx_freq, tx_freq, countryprefix, wpxprefix, stationprefix, continent,
  snt, snt_nr, rcv, rcv_nr, gridsquare, exchange1, section, comment,
  op_name, power, misctext, zone, prec, ck, is_mult1, is_mult2, is_mult3,
  points, radio_nr, run1run2, rover_loc, radio_interfaced, comp_nr,
  is_original, netbios_name, is_run_qso, station_name, is_claimed_qso,
  sent_exchange, n1mm_timestamp, logged_at
FROM qsos_old;

DROP TABLE qsos_old;

-- Both indexes were attached to qsos_old (SQLite follows a RENAME) and
-- dropped along with it above -- recreate them on the new table now,
-- rather than leaving the gap until schema.sql's own CREATE INDEX IF NOT
-- EXISTS lines happen to run again on a later restart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qsos_ext_id ON qsos(ext_id) WHERE ext_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_qsos_natural_key
  ON qsos(call, band, mode, contestnr, mycall) WHERE ext_id IS NULL;
