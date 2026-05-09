const { getDb } = require('./index');

// Prepared statements compiled once on first use, after initDb() has run.
let Q;

function prepare() {
  if (Q) return Q;
  const db = getDb();

  // Pre-compile inner DELETE statements so clearAll transaction can reuse them.
  const _delQsos   = db.prepare('DELETE FROM qsos');
  const _delScores = db.prepare('DELETE FROM score_snapshots');
  const _delCache  = db.prepare('DELETE FROM callsign_cache');

  Q = {
    // -------------------------------------------------------------------------
    // QSOs
    // -------------------------------------------------------------------------
    insertQso: db.prepare(`
      INSERT OR IGNORE INTO qsos
        (call, band, mode, operator, mycall, contestname, srx, stx, snt, rcv,
         mult1, mult2, is_mult1, is_mult2, points, exchange1, section,
         rover_loc, radio_nr, comp_nr)
      VALUES
        (@call, @band, @mode, @operator, @mycall, @contestname, @srx, @stx,
         @snt, @rcv, @mult1, @mult2, @is_mult1, @is_mult2, @points,
         @exchange1, @section, @rover_loc, @radio_nr, @comp_nr)
    `),

    deleteQso: db.prepare(`
      DELETE FROM qsos
      WHERE call        = @call
        AND band        = @band
        AND mode        = @mode
        AND contestname = @contestname
        AND mycall      = @mycall
    `),

    // Single statement handles all filter combinations.
    // Pass null for any filter that should be ignored.
    getQsos: db.prepare(`
      SELECT * FROM qsos
      WHERE (@band     IS NULL OR band     = @band)
        AND (@mode     IS NULL OR mode     = @mode)
        AND (@operator IS NULL OR operator = @operator)
      ORDER BY logged_at DESC
    `),

    // Atomic wipe of all contest data
    clearAll: db.transaction(() => {
      _delQsos.run();
      _delScores.run();
      _delCache.run();
    }),

    // -------------------------------------------------------------------------
    // Radio state  (one row per RadioNr, upserted on every packet)
    // -------------------------------------------------------------------------
    upsertRadio: db.prepare(`
      INSERT INTO radio_state
        (radio_nr, station_name, freq, tx_freq, mode, op_call, is_running,
         focus_entry, antenna, rotator, focus_radio, updated_at)
      VALUES
        (@radio_nr, @station_name, @freq, @tx_freq, @mode, @op_call, @is_running,
         @focus_entry, @antenna, @rotator, @focus_radio, datetime('now'))
      ON CONFLICT(radio_nr) DO UPDATE SET
        station_name = excluded.station_name,
        freq         = excluded.freq,
        tx_freq      = excluded.tx_freq,
        mode         = excluded.mode,
        op_call      = excluded.op_call,
        is_running   = excluded.is_running,
        focus_entry  = excluded.focus_entry,
        antenna      = excluded.antenna,
        rotator      = excluded.rotator,
        focus_radio  = excluded.focus_radio,
        updated_at   = excluded.updated_at
    `),

    getRadios: db.prepare('SELECT * FROM radio_state ORDER BY radio_nr'),

    // -------------------------------------------------------------------------
    // Score snapshots  (append-only time series)
    // -------------------------------------------------------------------------
    insertScore: db.prepare(`
      INSERT INTO score_snapshots
        (contest, call, operators, power, assisted, transmitted, band, mode,
         qsos, points, mults, mults2, total)
      VALUES
        (@contest, @call, @operators, @power, @assisted, @transmitted, @band,
         @mode, @qsos, @points, @mults, @mults2, @total)
    `),

    getLatestScore: db.prepare(
      'SELECT * FROM score_snapshots ORDER BY id DESC LIMIT 1'
    ),

    getScoreHistory: db.prepare(
      'SELECT * FROM score_snapshots ORDER BY captured_at ASC'
    ),

    // -------------------------------------------------------------------------
    // Settings  (key/value)
    // -------------------------------------------------------------------------
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    ),

    // -------------------------------------------------------------------------
    // Callsign cache
    // -------------------------------------------------------------------------
    getCachedCallsign: db.prepare(
      'SELECT * FROM callsign_cache WHERE call = ?'
    ),

    cacheCallsign: db.prepare(
      'INSERT OR REPLACE INTO callsign_cache (call, data, source) VALUES (?, ?, ?)'
    ),
  };

  return Q;
}

// Call this when the DB is replaced (e.g. between integration tests).
function resetStatements() { Q = null; }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function insertQso(qso) { return prepare().insertQso.run(qso); }
function deleteQso(qso) { return prepare().deleteQso.run(qso); }
function getQsos({ band, mode, operator } = {}) {
  return prepare().getQsos.all({
    band:     band     || null,
    mode:     mode     || null,
    operator: operator || null,
  });
}
function clearQsos() { return prepare().clearAll(); }

function upsertRadio(radio) { return prepare().upsertRadio.run(radio); }
function getRadios()        { return prepare().getRadios.all(); }

function insertScore(score)  { return prepare().insertScore.run(score); }
function getLatestScore()    { return prepare().getLatestScore.get() || null; }
function getScoreHistory()   { return prepare().getScoreHistory.all(); }

function getSetting(key) {
  const row = prepare().getSetting.get(key);
  return row ? row.value : null;
}
function setSetting(key, value) { return prepare().setSetting.run(key, String(value)); }

function getCachedCallsign(call) { return prepare().getCachedCallsign.get(call); }
function cacheCallsign(call, data, source) {
  return prepare().cacheCallsign.run(call, JSON.stringify(data), source);
}

module.exports = {
  insertQso, deleteQso, getQsos, clearQsos,
  upsertRadio, getRadios,
  insertScore, getLatestScore, getScoreHistory,
  getSetting, setSetting,
  getCachedCallsign, cacheCallsign,
  resetStatements,
};
