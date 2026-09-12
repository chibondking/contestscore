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
  logged_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- N1MM's <ID> GUID uniquely and durably identifies a QSO row across
-- contactreplace edits. Only enforced when present.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qsos_ext_id ON qsos(ext_id) WHERE ext_id IS NOT NULL;

-- Fallback dedupe key for loggers that never send <ID> -- see idx_qsos_ext_id
-- above for the primary identity path. contestnr, not contestname, since
-- that's what contactdelete actually carries.
--
-- Partial (WHERE ext_id IS NULL), not a plain table-level UNIQUE(...): a
-- logger that *does* send a stable <ID> can legitimately log more than one
-- row sharing the same (call, band, mode, contestnr, mycall) tuple -- a WAE
-- QTC report, for instance, is a distinct record (its own <ID>, its own
-- serial/misctext) sent to a station on the same band/mode you already
-- logged a QSO with, sometimes several in a row to the same station. Each
-- has a real ext_id, so idx_qsos_ext_id already identifies it correctly;
-- with this as a *non*-partial constraint instead, every QTC after the
-- first to that station+band+mode violated it (a different index than the
-- one upsertQso's ON CONFLICT(ext_id) targets, so it wasn't a graceful
-- update -- the INSERT just failed) and got silently dropped -- caught and
-- logged by src/udp/index.js's safely(), never surfaced anywhere a viewer
-- would see it. See migrations/003_qsos_natural_key_ext_id_only.sql for the
-- migration that narrows this on an existing database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qsos_natural_key
  ON qsos(call, band, mode, contestnr, mycall) WHERE ext_id IS NULL;

-- Keyed by (station_name, radio_nr), not radio_nr alone: N1MM's RadioNr is
-- only unique *within one PC's own config* (1 or 2 for that station's own
-- SO2R setup). In a multi-op with separate physical stations, each PC
-- typically also numbers its own radio starting at 1 -- keying on radio_nr
-- alone would let Station B's "Radio 1" silently overwrite Station A's.
-- station_name (N1MM's own StationName/NetBIOS name) disambiguates that;
-- '' is the fallback for a packet with no StationName, which still works
-- correctly for the common single-station case.
-- Wiped by DELETE /api/db (clearAll): a pre-contest reset should drop a
-- radio that was on last contest but is offline now, otherwise its stale
-- row keeps rendering as a connected radio on every page load.
CREATE TABLE IF NOT EXISTS radio_state (
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

-- Space-weather readings (SFI / A / K / sunspots) polled from hamqsl.com,
-- one row per fetch (~every 2h). Append-only, and deliberately NOT wiped by
-- DELETE /api/db (clearAll) -- this is ambient data, not contest data, and
-- the history is what a later "how did the rate track the K index" analysis
-- of a from-live snapshot will join against. Kept trimmed by a slow
-- age-based prune (src/solar/). A brand-new table, so schema.sql alone
-- covers both fresh and existing DBs -- no migration file needed.
CREATE TABLE IF NOT EXISTS solar_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sfi            INTEGER,
  a_index        INTEGER,
  k_index        INTEGER,
  sunspots       INTEGER,
  xray           TEXT,
  geomag         TEXT,
  source_updated TEXT,                       -- hamqsl's own "updated" string, raw
  fetched_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_solar_fetched ON solar_snapshots(fetched_at);

-- Uploaded Cabrillo/ADIF logs for the offline analyzer (see
-- docs/ANALYZER.md and src/routes/analyze.js). Deliberately separate from
-- `qsos`: that table is the realtime contest and is wiped by
-- DELETE /api/db; an analyzed log is a saved artifact with its own
-- shareable /analyze/<id> URL and must survive a pre-contest reset. One row
-- per upload; the parsed QSO array lives in `parsed_json` since the
-- analyzer renderers only ever consume the array. has_* flags record which
-- of points/mults/operator/run-status the source format actually carried,
-- so the result page can hide the sections it can't populate.
CREATE TABLE IF NOT EXISTS analyzed_logs (
  id            TEXT PRIMARY KEY,        -- url-safe base32 slug
  filename      TEXT,
  format        TEXT,                    -- 'cabrillo' | 'adif'
  contest       TEXT,                    -- raw CONTEST: header
  contest_key   TEXT,                    -- matched exchange-spec key, or NULL (see src/analyze/contests.js)
  exchange_parsed INTEGER DEFAULT 0,     -- 1 if a per-contest exchange grammar matched
  station_call  TEXT,
  operators     TEXT,                    -- raw OPERATORS header, display only
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

CREATE INDEX IF NOT EXISTS idx_analyzed_logs_created ON analyzed_logs(created_at);
