const { Router } = require('express');
const {
  getQsos, clearQsos,
  getRadios,
  getLatestScore, getScoreHistory,
} = require('../db/queries');

const router = Router();

// GET /api/qsos  optional ?band=&mode=&operator=
router.get('/qsos', (req, res) => {
  const { band, mode, operator } = req.query;
  res.json(getQsos({ band, mode, operator }));
});

// GET /api/score
router.get('/score', (req, res) => {
  res.json(getLatestScore() || {});
});

// GET /api/score/history
router.get('/score/history', (req, res) => {
  res.json(getScoreHistory());
});

// GET /api/radios
router.get('/radios', (req, res) => {
  res.json(getRadios());
});

// DELETE /api/db  requires X-Confirm: yes header
router.delete('/db', (req, res) => {
  if (req.headers['x-confirm'] !== 'yes') {
    return res.status(400).json({ error: 'Missing X-Confirm: yes header' });
  }
  clearQsos();
  const io = req.app.get('io');
  if (io) io.emit('db:cleared');
  res.json({ cleared: true });
});

module.exports = router;
