const { getDb } = require('./index');

// Prepared statements compiled once on first use, after initDb() has run.
let Q;

const QSO_COLUMNS = [
  'ext_id', 'call', 'band', 'mode', 'operator', 'mycall', 'contestname',
  'contestnr', 'rx_freq', 'tx_freq', 'countryprefix', 'wpxprefix',
  'stationprefix', 'continent', 'snt', 'snt_nr', 'rcv', 'rcv_nr',
  'gridsquare', 'exchange1', 'section', 'comment', 'op_name', 'power',
  'misctext', 'zone', 'prec', 'ck', 'is_mult1', 'is_mult2', 'is_mult3',
  'points', 'radio_nr', 'run1run2', 'rover_loc', 'radio_interfaced',
  'comp_nr', 'is_original', 'netbios_name', 'is_run_qso', 'station_name',
  'is_claimed_qso', 'sent_exchange', 'n1mm_timestamp',
];

const QSO_DEFAULTS = {
  ext_id: null, call: '', band: '', mode: '', operator: '', mycall: '',
  contestname: '', contestnr: '', rx_freq: '', tx_freq: '', countryprefix: '',
  wpxprefix: '', stationprefix: '', continent: '', snt: '', snt_nr: '',
  rcv: '', rcv_nr: '', gridsquare: '', exchange1: '', section: '', comment: '',
  op_name: '', power: '', misctext: '', zone: '', prec: '', ck: '',
  is_mult1: 0, is_mult2: 0, is_mult3: 0, points: 0, radio_nr: null,
  run1run2: '', rover_loc: '', radio_interfaced: null, comp_nr: null,
  is_original: 1, netbios_name: '', is_run_qso: 0, station_name: '',
  is_claimed_qso: 1, sent_exchange: '', n1mm_timestamp: '',
};

function prepare() {
  if (Q) return Q;
  const db = getDb();

  // Pre-compile inner DELETE statements so clearAll transaction can reuse them.
  const _delQsos   = db.prepare('DELETE FROM qsos');
  const _delScores = db.prepare('DELETE FROM score_snapshots');
  const _delCache  = db.prepare('DELETE FROM callsign_cache');

  const cols = QSO_COLUMNS.join(', ');
  const placeholders = QSO_COLUMNS.map((c) => `@${c}`).join(', ');
  const updateSet = QSO_COLUMNS
    .filter((c) => c !== 'ext_id')
    .map((c) => `${c} = excluded.${c}`)
    .join(',\n        ');

  // N1MM tags every QSO with a stable <ID> GUID (ext_id) that survives
  // contactreplace edits. When present, upsert on it so an edited-in-place
  // QSO updates its existing row instead of creating a duplicate.
  // idx_qsos_ext_id is a partial unique index (WHERE ext_id IS NOT NULL), so
  // SQLite requires the ON CONFLICT clause to restate that predicate to
  // recognize it as the conflict target — otherwise this fails to prepare
  // with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
  // constraint". We only ever call this when ext_id is already known truthy.
  const _upsertQsoByExtId = db.prepare(`
    INSERT INTO qsos (${cols})
    VALUES (${placeholders})
    ON CONFLICT(ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
        ${updateSet}
  `);

  // Fallback for loggers that don't send a stable <ID> (older TR4W/N1MM
  // versions). No update-in-place is possible without an identity key, so
  // this just dedupes against the natural-key UNIQUE constraint.
  const _insertQsoIgnore = db.prepare(`
    INSERT OR IGNORE INTO qsos (${cols})
    VALUES (${placeholders})
  `);

  const _deleteQsoByExtId = db.prepare('DELETE FROM qsos WHERE ext_id = @ext_id');

  // Best-effort fallback when no <ID> is available. Matches contactdelete's
  // own field set — it does not carry mode or contestname, only contestnr —
  // and is restricted to rows that themselves have no ext_id, so it can
  // never clobber an ID-tracked row via a stale natural-key guess.
  const _deleteQsoFallback = db.prepare(`
    DELETE FROM qsos
    WHERE ext_id IS NULL
      AND call      = @call
      AND band      = @band
      AND mycall    = @mycall
      AND contestnr = @contestnr
  `);

  const _getQsos = db.prepare(`
    SELECT * FROM qsos
    WHERE (@band     IS NULL OR band     = @band)
      AND (@mode     IS NULL OR mode     = @mode)
      AND (@operator IS NULL OR operator = @operator)
    ORDER BY logged_at DESC
  `);

  // logged_at is our own ingestion timestamp (datetime('now'), UTC), not
  // N1MM's n1mm_timestamp -- using it means the rate reflects when this
  // server actually recorded the QSO, consistent regardless of clock skew
  // on whichever PC logged it.
  const _getQsoCountSince = db.prepare(`
    SELECT COUNT(*) AS count FROM qsos WHERE logged_at >= datetime('now', @modifier)
  `);

  const _upsertRadio = db.prepare(`
    INSERT INTO radio_state
      (radio_nr, station_name, freq, tx_freq, mode, op_call, is_running,
       is_transmitting, focus_entry, antenna, rotator, focus_radio,
       active_radio, updated_at)
    VALUES
      (@radio_nr, @station_name, @freq, @tx_freq, @mode, @op_call, @is_running,
       @is_transmitting, @focus_entry, @antenna, @rotator, @focus_radio,
       @active_radio, datetime('now'))
    ON CONFLICT(radio_nr) DO UPDATE SET
      station_name    = excluded.station_name,
      freq            = excluded.freq,
      tx_freq         = excluded.tx_freq,
      mode            = excluded.mode,
      op_call         = excluded.op_call,
      is_running      = excluded.is_running,
      is_transmitting = excluded.is_transmitting,
      focus_entry     = excluded.focus_entry,
      antenna         = excluded.antenna,
      rotator         = excluded.rotator,
      focus_radio     = excluded.focus_radio,
      active_radio    = excluded.active_radio,
      updated_at      = excluded.updated_at
  `);

  const _getRadios = db.prepare('SELECT * FROM radio_state ORDER BY radio_nr');

  const _insertScoreRow = db.prepare(`
    INSERT INTO score_snapshots
      (contest, call, ops, power, assisted, transmitter, category_ops,
       category_bands, category_mode, overlay, dxcc_country, cq_zone,
       iaru_zone, arrl_section, st_prov_oth, grid6, band, mode, qsos,
       points, mults, is_total, score_total, captured_at)
    VALUES
      (@contest, @call, @ops, @power, @assisted, @transmitter, @category_ops,
       @category_bands, @category_mode, @overlay, @dxcc_country, @cq_zone,
       @iaru_zone, @arrl_section, @st_prov_oth, @grid6, @band, @mode, @qsos,
       @points, @mults, @is_total, @score_total, @captured_at)
  `);

  // A single Score (dynamicresults) broadcast produces one row per
  // band/mode breakdown entry; insert them all as one unit so a snapshot is
  // never left half-written.
  const _insertScoreBreakdown = db.transaction((header, rows) => {
    for (const row of rows) {
      _insertScoreRow.run({
        ...header,
        band: row.band,
        mode: row.mode,
        qsos: row.qsos || 0,
        points: row.points || 0,
        mults: row.mults ?? null,
        is_total: row.is_total ? 1 : 0,
      });
    }
  });

  const _getLatestScore = db.prepare(`
    SELECT * FROM score_snapshots WHERE is_total = 1 ORDER BY id DESC LIMIT 1
  `);

  const _getScoreHistory = db.prepare(`
    SELECT * FROM score_snapshots WHERE is_total = 1 ORDER BY captured_at ASC
  `);

  const _getScoreBreakdown = db.prepare(`
    SELECT * FROM score_snapshots
    WHERE is_total = 0 AND id IN (
      SELECT MAX(id) FROM score_snapshots WHERE is_total = 0 GROUP BY band, mode
    )
    ORDER BY band, mode
  `);

  Q = {
    upsertQsoByExtId: _upsertQsoByExtId,
    insertQsoIgnore:  _insertQsoIgnore,
    deleteQsoByExtId: _deleteQsoByExtId,
    deleteQsoFallback: _deleteQsoFallback,
    getQsos: _getQsos,
    getQsoCountSince: _getQsoCountSince,
    clearAll: db.transaction(() => {
      _delQsos.run();
      _delScores.run();
      _delCache.run();
    }),

    upsertRadio: _upsertRadio,
    getRadios: _getRadios,

    insertScoreBreakdown: _insertScoreBreakdown,
    getLatestScore: _getLatestScore,
    getScoreHistory: _getScoreHistory,
    getScoreBreakdown: _getScoreBreakdown,

    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)'
    ),

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

// Fills every named param so better-sqlite3 doesn't throw on a missing key —
// callers (parser output, tests) only need to supply the fields they care about.
function normalizeQso(qso) {
  return { ...QSO_DEFAULTS, ...qso };
}

function upsertQso(qso) {
  const full = normalizeQso(qso);
  if (full.ext_id) return prepare().upsertQsoByExtId.run(full);
  return prepare().insertQsoIgnore.run(full);
}

function deleteQso(qso) {
  if (qso.ext_id) return prepare().deleteQsoByExtId.run({ ext_id: qso.ext_id });
  return prepare().deleteQsoFallback.run({
    call: qso.call || '',
    band: qso.band || '',
    mycall: qso.mycall || '',
    contestnr: qso.contestnr || '',
  });
}

function getQsos({ band, mode, operator } = {}) {
  return prepare().getQsos.all({
    band:     band     || null,
    mode:     mode     || null,
    operator: operator || null,
  });
}
function clearQsos() { return prepare().clearAll(); }

// N1MM-style rate meter: QSO count in each of several trailing windows,
// extrapolated to a QSOs/hour figure the way N1MM's own rate display does
// (e.g. 4 QSOs in the last 10 minutes -> a 24/hr rate). Purely a function of
// wall-clock time passing, not of any event -- callers should poll this
// rather than only recomputing it on contact:new, or the rate will look
// frozen during a lull instead of decaying back down.
const RATE_WINDOWS_MINUTES = [10, 30, 60];

function getQsoRate() {
  return RATE_WINDOWS_MINUTES.map((minutes) => {
    const { count } = prepare().getQsoCountSince.get({ modifier: `-${minutes} minutes` });
    return {
      minutes,
      qsos: count,
      rate_per_hour: Math.round(count * (60 / minutes)),
    };
  });
}

function upsertRadio(radio) {
  return prepare().upsertRadio.run({
    is_transmitting: null,
    active_radio: null,
    ...radio,
  });
}
function getRadios() { return prepare().getRadios.all(); }

// score: the object returned by parsers/score.js — { ...header fields,
// breakdown: [{ band, mode, qsos, points, mults, is_total }, ...] }.
// All rows from this broadcast are stamped with the same captured_at so
// they can be recovered as one coherent snapshot later.
function insertScoreBreakdown(score) {
  const capturedAt = new Date().toISOString();
  const header = {
    contest: score.contest || '',
    call: score.call || '',
    ops: score.ops || '',
    power: score.power || '',
    assisted: score.assisted || 0,
    transmitter: score.transmitter || '',
    category_ops: score.category_ops || '',
    category_bands: score.category_bands || '',
    category_mode: score.category_mode || '',
    overlay: score.overlay || '',
    dxcc_country: score.dxcc_country || '',
    cq_zone: score.cq_zone || '',
    iaru_zone: score.iaru_zone || '',
    arrl_section: score.arrl_section || '',
    st_prov_oth: score.st_prov_oth || '',
    grid6: score.grid6 || '',
    score_total: score.score_total || 0,
    captured_at: capturedAt,
  };
  prepare().insertScoreBreakdown(header, score.breakdown || []);
}

function getLatestScore()    { return prepare().getLatestScore.get() || null; }
function getScoreHistory()   { return prepare().getScoreHistory.all(); }
function getScoreBreakdown() { return prepare().getScoreBreakdown.all(); }

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
  upsertQso, deleteQso, getQsos, clearQsos, getQsoRate,
  upsertRadio, getRadios,
  insertScoreBreakdown, getLatestScore, getScoreHistory, getScoreBreakdown,
  getSetting, setSetting,
  getCachedCallsign, cacheCallsign,
  resetStatements,
};
