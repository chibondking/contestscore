// Mult bell strike count, shared by the dashboard (public/js/dashboard.js,
// loaded first by index.html) and the TUI (tui/index.js, via require). A
// classic script like every other page script -- no type="module", see
// CLAUDE.md -- with a guarded module.exports so Node can load it too.

// One strike per multiplier category the QSO is new for, so a double mult
// (say a new zone AND a new country) rings twice, a triple three times.
// Counts N1MM's is_mult1/2/3 the same truthy way isMult() reads them.
const MULTBELL_STRIKE_GAP_MS = 280;
function multDingCount(q) {
  return [q.is_mult1, q.is_mult2, q.is_mult3].filter(Boolean).length;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { multDingCount, MULTBELL_STRIKE_GAP_MS };
}
