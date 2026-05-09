const { getDb } = require('./index');

// QSOs
function insertQso(qso) {
  return getDb().prepare(`
    INSERT OR IGNORE INTO qsos
      (call, band, mode, operator, mycall, contestname, srx, stx, snt, rcv,
       mult1, mult2, is_mult1, is_mult2, points, exchange1, section,
       rover_loc, radio_nr, comp_nr)
    VALUES
      (@call, @band, @mode, @operator, @mycall, @contestname, @srx, @stx,
       @snt, @rcv, @mult1, @mult2, @is_mult1, @is_mult2, @points,
       @exchange1, @section, @rover_loc, @radio_nr, @comp_nr)
  `).run(qso);
}

function getQsos({ band, mode, operator } = {}) {
  let sql = 'SELECT * FROM qsos WHERE 1=1';
  const params = [];
  if (band) { sql += ' AND band = ?'; params.push(band); }
  if (mode) { sql += ' AND mode = ?'; params.push(mode); }
  if (operator) { sql += ' AND operator = ?'; params.push(operator); }
  sql += ' ORDER BY logged_at DESC';
  return getDb().prepare(sql).all(...params);
}

function clearQsos() {
  const db = getDb();
  db.prepare('DELETE FROM qsos').run();
  db.prepare('DELETE FROM score_snapshots').run();
  db.prepare('DELETE FROM callsign_cache').run();
}

// Radio state
function upsertRadio(radio) {
  return getDb().prepare(`
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
  `).run(radio);
}

function getRadios() {
  return getDb().prepare('SELECT * FROM radio_state').all();
}

// Scores
function insertScore(score) {
  return getDb().prepare(`
    INSERT INTO score_snapshots
      (contest, call, operators, power, assisted, transmitted, band, mode,
       qsos, points, mults, mults2, total)
    VALUES
      (@contest, @call, @operators, @power, @assisted, @transmitted, @band,
       @mode, @qsos, @points, @mults, @mults2, @total)
  `).run(score);
}

function getLatestScore() {
  return getDb().prepare(
    'SELECT * FROM score_snapshots ORDER BY id DESC LIMIT 1'
  ).get();
}

function getScoreHistory() {
  return getDb().prepare(
    'SELECT * FROM score_snapshots ORDER BY captured_at ASC'
  ).all();
}

// Callsign cache
function getCachedCallsign(call) {
  return getDb().prepare('SELECT * FROM callsign_cache WHERE call = ?').get(call);
}

function cacheCallsign(call, data, source) {
  return getDb().prepare(`
    INSERT OR REPLACE INTO callsign_cache (call, data, source)
    VALUES (?, ?, ?)
  `).run(call, JSON.stringify(data), source);
}

module.exports = {
  insertQso, getQsos, clearQsos,
  upsertRadio, getRadios,
  insertScore, getLatestScore, getScoreHistory,
  getCachedCallsign, cacheCallsign,
};
