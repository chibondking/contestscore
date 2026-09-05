CREATE TABLE IF NOT EXISTS qsos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id            TEXT,                 -- N1MM's <ID> GUID; stable across contactreplace edits
  call              TEXT NOT NULL,
  band              TEXT,                 -- raw N1MM band value in MHz, e.g. "3.5", "14"
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
  logged_at         TEXT NOT NULL DEFAULT (datetime('now')),
  -- Fallback dedupe key for loggers that never send <ID> (see idx_qsos_ext_id
  -- below for the primary identity path). contestnr, not contestname, since
  -- that's what contactdelete actually carries.
  UNIQUE(call, band, mode, contestnr, mycall)
);

-- N1MM's <ID> GUID uniquely and durably identifies a QSO row across
-- contactreplace edits. Only enforced when present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qsos_ext_id ON qsos(ext_id) WHERE ext_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS radio_state (
  radio_nr        INTEGER PRIMARY KEY,
  station_name    TEXT,
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
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (band, mode) breakdown entry from each Score (<dynamicresults>)
-- broadcast, plus a band='total' mode='ALL' row carrying the contest grand
-- total. All rows from the same broadcast share the same captured_at, so a
-- single packet always produces a coherent multi-row snapshot rather than
-- one band silently overwriting another as "the" current score.
CREATE TABLE IF NOT EXISTS score_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  contest         TEXT,
  call            TEXT,
  ops             TEXT,
  power           TEXT,
  assisted        INTEGER DEFAULT 0,
  transmitter     TEXT,
  category_ops    TEXT,
  category_bands  TEXT,
  category_mode   TEXT,
  overlay         TEXT,
  dxcc_country    TEXT,
  cq_zone         TEXT,
  iaru_zone       TEXT,
  arrl_section    TEXT,
  st_prov_oth     TEXT,
  grid6           TEXT,
  band            TEXT,
  mode            TEXT,
  qsos            INTEGER DEFAULT 0,
  points          INTEGER DEFAULT 0,
  mults           INTEGER,             -- NULL until a contest's <mult> breakdown shape is confirmed live
  is_total        INTEGER DEFAULT 0,
  score_total     INTEGER DEFAULT 0,   -- the packet's top-level <score> value
  captured_at     TEXT NOT NULL
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
