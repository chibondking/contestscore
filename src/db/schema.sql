CREATE TABLE IF NOT EXISTS qsos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  call        TEXT NOT NULL,
  band        TEXT,
  mode        TEXT,
  operator    TEXT,
  mycall      TEXT,
  contestname TEXT,
  srx         TEXT,
  stx         TEXT,
  snt         TEXT,
  rcv         TEXT,
  mult1       TEXT,
  mult2       TEXT,
  is_mult1    INTEGER DEFAULT 0,
  is_mult2    INTEGER DEFAULT 0,
  points      INTEGER DEFAULT 0,
  exchange1   TEXT,
  section     TEXT,
  rover_loc   TEXT,
  radio_nr    INTEGER,
  comp_nr     INTEGER,
  logged_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(call, band, mode, contestname, mycall)
);

CREATE TABLE IF NOT EXISTS radio_state (
  radio_nr      INTEGER PRIMARY KEY,
  station_name  TEXT,
  freq          TEXT,
  tx_freq       TEXT,
  mode          TEXT,
  op_call       TEXT,
  is_running    INTEGER DEFAULT 0,
  focus_entry   INTEGER,
  antenna       TEXT,
  rotator       TEXT,
  focus_radio   INTEGER,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS score_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  contest     TEXT,
  call        TEXT,
  operators   TEXT,
  power       TEXT,
  assisted    INTEGER,
  transmitted TEXT,
  band        TEXT,
  mode        TEXT,
  qsos        INTEGER DEFAULT 0,
  points      INTEGER DEFAULT 0,
  mults       INTEGER DEFAULT 0,
  mults2      INTEGER DEFAULT 0,
  total       INTEGER DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS callsign_cache (
  call      TEXT PRIMARY KEY,
  data      TEXT,
  source    TEXT,
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
