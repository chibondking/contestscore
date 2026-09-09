const { Router } = require('express');
const express = require('express');
const {
  insertAnalyzedLog, getAnalyzedLog, listAnalyzedLogs, deleteAnalyzedLog,
  pruneAnalyzedLogs, getQsos, getLatestScore,
} = require('../db/queries');
const { analyzeLog, analyzeLiveQsos, newId } = require('../analyze');

const router = Router();

const MAX_BYTES = Number(process.env.ANALYZE_MAX_BYTES) || 5 * 1024 * 1024;
const KEEP = process.env.ANALYZE_KEEP != null ? Number(process.env.ANALYZE_KEEP) : 200;
const TTL_DAYS = process.env.ANALYZE_TTL_DAYS != null ? Number(process.env.ANALYZE_TTL_DAYS) : 365;

// Same fail-closed posture as /api/ingest: uploading a log is a write, and
// this instance is reachable from the public internet, so an unset token
// means "not configured", not "open to all". Reading a saved analysis by
// id stays public -- that's the point of a shareable /analyze/<id> link.
function requireToken(req, res, next) {
  const token = process.env.CONTESTSCORE_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Analyzer uploads disabled: CONTESTSCORE_API_TOKEN is not set' });
  }
  if (req.headers['authorization'] !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Missing or invalid bearer token' });
  }
  next();
}

const rawBody = express.raw({ type: () => true, limit: MAX_BYTES });

// POST /api/analyze?filename=foo.cbr  -- raw Cabrillo or ADIF text.
router.post('/', requireToken, rawBody, (req, res) => {
  const text = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  if (!text.trim()) {
    return res.status(400).json({ error: 'Empty upload' });
  }

  let result;
  try {
    result = analyzeLog(text, String(req.query.filename || '').slice(0, 200));
  } catch (err) {
    if (err.code === 'BAD_FORMAT') {
      return res.status(422).json({ error: err.message });
    }
    console.error('analyzer: parse failed', err);
    return res.status(500).json({ error: 'Failed to parse log' });
  }

  if (result.qsos.length === 0) {
    return res.status(422).json({ error: 'No QSOs found in the log' });
  }

  res.status(201).json(persist(result, Buffer.byteLength(text, 'utf8')));
});

// Store an { meta, qsos, excluded } result and enforce retention.
// Returns { id, meta }.
function persist(result, rawBytes) {
  const id = newId();
  insertAnalyzedLog({
    id,
    filename: result.meta.filename,
    format: result.meta.format,
    contest: result.meta.contest,
    contest_key: result.meta.contest_key,
    exchange_parsed: result.meta.exchange_parsed,
    station_call: result.meta.station_call,
    operators: result.meta.operators,
    claimed_score: result.meta.claimed_score,
    qso_count: result.meta.qso_count,
    has_points: result.meta.has_points,
    has_mults: result.meta.has_mults,
    has_operator: result.meta.has_operator,
    has_run_flag: result.meta.has_run_flag,
    raw_bytes: rawBytes || 0,
    parsed_json: JSON.stringify({ qsos: result.qsos, excluded: result.excluded || [] }),
  });
  try {
    pruneAnalyzedLogs({ keep: KEEP, ttlDays: TTL_DAYS });
  } catch (err) {
    console.warn('analyzer: retention prune failed', err.message);
  }
  return { id, meta: result.meta };
}

// POST /api/analyze/from-live  -- snapshot the realtime `qsos` table (the
// full-fidelity N1MM feed) into a saved analysis. No body.
router.post('/from-live', requireToken, (req, res) => {
  const rows = getQsos();
  if (!rows.length) {
    return res.status(422).json({ error: 'No QSOs in the live contest database' });
  }
  const score = getLatestScore();
  const result = analyzeLiveQsos(rows, { claimedScore: score ? score.score_total : null });
  res.status(201).json(persist(result, 0));
});

// GET /api/analyze  -- list saved analyses (auth: it's a private index).
router.get('/', requireToken, (req, res) => {
  res.json({
    items: listAnalyzedLogs(500),
    retention: { keep: KEEP, ttl_days: TTL_DAYS },
  });
});

// GET /api/analyze/:id  -- public: { meta, qsos, excluded }.
router.get('/:id', (req, res) => {
  const row = getAnalyzedLog(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  let parsed;
  try {
    parsed = JSON.parse(row.parsed_json);
  } catch {
    return res.status(500).json({ error: 'Stored analysis is corrupt' });
  }
  // parsed_json was a bare QSO array before the X-QSO surfacing change;
  // accept both shapes.
  const qsos = Array.isArray(parsed) ? parsed : (parsed.qsos || []);
  const excluded = Array.isArray(parsed) ? [] : (parsed.excluded || []);

  res.json({
    excluded,
    meta: {
      id: row.id,
      filename: row.filename,
      format: row.format,
      contest: row.contest,
      contest_key: row.contest_key || null,
      exchange_parsed: !!row.exchange_parsed,
      station_call: row.station_call,
      operators: row.operators,
      claimed_score: row.claimed_score,
      qso_count: row.qso_count,
      has_points: !!row.has_points,
      has_mults: !!row.has_mults,
      has_operator: !!row.has_operator,
      has_run_flag: !!row.has_run_flag,
      excluded_count: excluded.length,
      created_at: row.created_at,
    },
    qsos,
  });
});

// DELETE /api/analyze/:id
router.delete('/:id', requireToken, (req, res) => {
  const info = deleteAnalyzedLog(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ deleted: true });
});

module.exports = router;
