// Map TV (/map): the dashboard's map card on its own, filling the screen,
// for a wall display. The HUD is always on (last worked, score, rate, DXCC,
// COSB rank), and it's view only -- no Save PNG, no Hide.
//
// Built from the same parts as the dashboard (component.js): the live feed
// and the map panel, markup and all. This file is only what's different on
// the TV.
function mapTv() {
  return compose(liveFeed(), mapPanel(), {
    tvMode: true,

    init() {
      this.initLiveFeed();
      this.initMapPanel();
    },
  });
}
