// Building blocks for the pages' Alpine components.
//
// A page's component is put together from parts instead of being one big
// object per page:
//
//   liveFeed()  live-feed.js  the contest as it happens: QSOs, score, rate,
//                             COSB standings, and the socket that keeps them
//                             current
//   mapPanel()  map-panel.js  the map card: world / US-VE / ARRL section
//                             maps and the HUD overlaid on them
//   multBellPanel()           the mult bell and its header control
//               mult-bell-panel.js
//
// plus whatever only that page has. The dashboard is
// compose(liveFeed(), mapPanel(), {...the rest of the dashboard}); the Map
// TV page is compose(liveFeed(), mapPanel(), {...a few TV settings}). Two
// pages that show the same thing run the same code.
//
// Their markup is shared the same way: one copy each in public/partials/
// (map-panel.html, mult-bell.html), filled into each page by the server
// (src/pages.js).

// Merge parts left to right into one object. Uses property descriptors, not
// a spread, so a getter stays a getter instead of being read once and
// frozen. A later part may override an earlier part's member (Map TV sets
// tvMode this way).
function compose(...parts) {
  const out = {};
  for (const part of parts) Object.defineProperties(out, Object.getOwnPropertyDescriptors(part));
  return out;
}
