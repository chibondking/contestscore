const { Router } = require('express');

const router = Router();

// GET /api/qsos  optional ?band=&mode=&operator=
router.get('/qsos', (req, res) => {
  res.json([]);
});

// GET /api/score
router.get('/score', (req, res) => {
  res.json({});
});

// GET /api/score/history
router.get('/score/history', (req, res) => {
  res.json([]);
});

// GET /api/radios
router.get('/radios', (req, res) => {
  res.json([]);
});

// DELETE /api/db  requires X-Confirm: yes header
router.delete('/db', (req, res) => {
  if (req.headers['x-confirm'] !== 'yes') {
    return res.status(400).json({ error: 'Missing X-Confirm: yes header' });
  }
  res.json({ cleared: true });
});

module.exports = router;
