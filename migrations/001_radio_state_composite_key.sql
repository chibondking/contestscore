-- radio_state was keyed by radio_nr alone, which only holds up for a single
-- station's own SO2R setup (radio_nr unique within one PC's N1MM config).
-- In a multi-op with separate physical stations each running their own
-- radio_nr starting at 1, Station B's "Radio 1" would silently overwrite
-- Station A's. Re-key by (station_name, radio_nr) instead.
--
-- SQLite can't ALTER a table's PRIMARY KEY directly -- recreate it. Safe to
-- run against a fresh install too (schema.sql already creates the target
-- shape there): this just re-copies identical structure, which is
-- wasteful but not incorrect.
ALTER TABLE radio_state RENAME TO radio_state_old;

CREATE TABLE radio_state (
  station_name    TEXT NOT NULL DEFAULT '',
  radio_nr        INTEGER NOT NULL,
  freq            TEXT,
  tx_freq         TEXT,
  mode            TEXT,
  op_call         TEXT,
  is_running      INTEGER DEFAULT 0,
  is_transmitting INTEGER DEFAULT 0,
  focus_entry     INTEGER,
  antenna         TEXT,
  rotator         TEXT,
  focus_radio     INTEGER,
  active_radio    INTEGER,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (station_name, radio_nr)
);

INSERT INTO radio_state
  (station_name, radio_nr, freq, tx_freq, mode, op_call, is_running,
   is_transmitting, focus_entry, antenna, rotator, focus_radio,
   active_radio, updated_at)
SELECT
  COALESCE(station_name, ''), radio_nr, freq, tx_freq, mode, op_call,
  is_running, is_transmitting, focus_entry, antenna, rotator, focus_radio,
  active_radio, updated_at
FROM radio_state_old;

DROP TABLE radio_state_old;
