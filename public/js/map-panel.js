// The map card, as one part of a page's component (see component.js): the
// world map, the US/VE and ARRL section maps, and the HUD overlaid on them
// (last worked, score, rate, DXCC, COSB rank). Its markup is
// public/partials/map-panel.html.
//
// Needs liveFeed() in the same component: it draws from qsos, score, rate
// and cosb, and uses isMult/isQtc/countedQsos/stationCall/onLive from it.
//
// Used by the dashboard (/) and Map TV (/map). On Map TV, tvMode is true:
// the map always shows, the HUD is always on, and there's no Save PNG or
// Hide button.

// localStorage key for the world map card's per-viewer show/hide (see
// toggleWorldMap()). Same contestpulse_ prefix as chrome.js's theme key.
const WORLDMAP_KEY = 'contestpulse_worldmap';
// ...and its World | US/VE | ARRL pick (setMapView()), as
// {"contest": <name>, "view": "world"|"na"|"arrl"} -- it holds only for the
// contest it was picked in, so the next contest opens on its own default.
const MAPVIEW_KEY = 'contestpulse_mapview';
const MAP_VIEWS = ['world', 'na', 'arrl'];

// ---------------------------------------------------------------------
// ARRL/RAC section map: shown in place of the world map during ARRL
// Sweepstakes (CW or SSB) and ARRL Field Day -- the contests whose W/VE
// exchange is an ARRL/RAC section -- with every section the log has worked
// filled in. Geometry and projection are public/img/map/sections.json
// (scripts/build-sectionmap.py), fetched only while one of those is on.
//
// Names as N1MM sends them: the Score packet's <contest> ("ARRL-SS-CW",
// "ARRL-SS-SSB", "ARRL-FD") and contactinfo's shorter <contestname>
// ("SSCW", "SSPH", "FD"). Exact matches only -- nothing else gets the map.
const SECTION_CONTEST_RE = /^(ARRL-SS-CW|ARRL-SS-SSB|SSCW|SSPH|ARRL-FD|FD)$/i;

function isSectionContest(name) {
  return SECTION_CONTEST_RE.test(String(name || '').trim());
}

// What a logger may still send for a section that has since been renamed:
// the three territories have been one section, TER, since 2023.
const SECTION_ALIASES = { NT: 'TER', NWT: 'TER', YT: 'TER', NU: 'TER', NF: 'NL', PQ: 'QC' };

function sectionCode(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return SECTION_ALIASES[s] || s;
}

// The section map's projection: spherical Lambert conformal conic, one
// "frame" per area (the main map, then the Alaska and Hawaii insets), each
// with the constants and the viewBox fit the build script wrote into
// sections.json -- the same math as its lcc()/Frame, so a point drawn here
// lands where the build put the coastline.
function lccForward(f, lon, lat) {
  const r = Math.PI / 180;
  const rho = f.F / Math.tan(Math.PI / 4 + (lat * r) / 2) ** f.n;
  const t = f.n * (lon - f.lon0) * r;
  const x = rho * Math.sin(t);
  const y = f.rho0 - rho * Math.cos(t);
  return { x: f.ox + (x - f.x0) * f.s, y: f.oy + (f.y1 - y) * f.s };
}

function lccInverse(f, px, py) {
  const x = (px - f.ox) / f.s + f.x0;
  const y = f.y1 - (py - f.oy) / f.s;
  const dy = f.rho0 - y;
  const rho = Math.hypot(x, dy);
  const lat = 2 * Math.atan((f.F / rho) ** (1 / f.n)) - Math.PI / 2;
  const lon = f.lon0 + Math.atan2(x, dy) / f.n / (Math.PI / 180);
  return { lon, lat: lat / (Math.PI / 180) };
}

// The frame a viewBox pixel belongs to: an inset inside its box, else main.
function sectionFrameAt(frames, px, py) {
  for (let i = 1; i < frames.length; i++) {
    const [bx, by, bw, bh] = frames[i].box;
    if (px >= bx && px < bx + bw && py >= by && py < by + bh) return frames[i];
  }
  return frames[0];
}

// The frame a lat/lon is drawn in: Alaska and Hawaii live in their insets.
function sectionFrameFor(frames, lon, lat) {
  if (frames.length > 2 && lon < -150 && lat < 30) return frames[2];
  if (frames.length > 1 && lon < -129 && lat > 51) return frames[1];
  return frames[0];
}

// Where a QSO dot goes on the US/VE map (sections.json's frames): its own
// frame (Alaska and Hawaii in their insets), plus the Northeast close-up
// when it's in there too. [] for anything off the map -- DX well outside
// North America (the conic would fold Europe or Asia back somewhere
// misleading), off the edge, or under an inset panel.
function sectionDotPositions(frames, W, H, lon, lat) {
  if (lon == null || lat == null || lon < -180 || lon > -40 || lat < 5 || lat > 85) return [];
  const f = sectionFrameFor(frames, lon, lat);
  const p = lccForward(f, lon, lat);
  const out = [];
  if (f === frames[0]) {
    if (p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H && sectionFrameAt(frames, p.x, p.y) === frames[0]) out.push(p);
  } else {
    const [bx, by, bw, bh] = f.box;
    if (p.x >= bx && p.x <= bx + bw && p.y >= by && p.y <= by + bh) out.push(p);
  }
  const ne = frames[3];
  if (ne) {
    const q = lccForward(ne, lon, lat);
    const [bx, by, bw, bh] = ne.box;
    if (q.x >= bx && q.x <= bx + bw && q.y >= by && q.y <= by + bh) out.push(q);
  }
  return out;
}

// Night side of the terminator as one closed path per frame, in that
// frame's projection: the terminator from 180W to 0 (well past both edges
// of every frame), closed through whichever pole is dark. -89 rather than
// the pole itself, which the conic sends to infinity.
function sectionNightPaths(frames, date) {
  const sub = subsolarPoint(date);
  const poleLat = sub.lat >= 0 ? -89 : 89;
  return frames.map((f) => {
    const pts = [];
    for (let lon = -180; lon <= 0; lon += 2) pts.push(lccForward(f, lon, terminatorLatDeg(lon, sub)));
    for (let lon = 0; lon >= -180; lon -= 4) pts.push(lccForward(f, lon, poleLat));
    return 'M' + pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L') + 'Z';
  });
}

// The world map's own imagery (public/img/map/, plate carree 2000x1000),
// resampled once into the section map's projection so both maps share one
// look: the same ocean, relief and city lights. Land is clipped to the
// vector coastlines (Natural Earth land + every section outline, lakes cut
// back out) in every frame, so the shoreline stays as sharp as the borders
// drawn over it even though the relief underneath is upsampled. K = output
// pixels per
// viewBox unit (2 keeps the 1000x500 map crisp on a wall TV). Returns object
// URLs.
async function buildSectionImagery(m, oceanHref, dark, K = 2) {
  const load = async (href) => {
    const img = new Image();
    img.src = href;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  };
  const [ocean, land, lights] = await Promise.all([
    load(oceanHref), load('/img/map/land.webp'), load('/img/map/lights.webp'),
  ]);
  const W = Math.round(m.width * K);
  const H = Math.round(m.height * K);
  const srcs = [ocean, land, lights];
  const out = srcs.map(() => new ImageData(W, H));
  for (let j = 0; j < H; j++) {
    // Hand the main thread back every few rows: on a Pi this is seconds of
    // work, and socket events / the clock must keep flowing meanwhile.
    if (j % 48 === 0) await new Promise((res) => setTimeout(res, 0));
    const py = (j + 0.5) / K;
    for (let i = 0; i < W; i++) {
      const px = (i + 0.5) / K;
      const { lon, lat } = lccInverse(sectionFrameAt(m.frames, px, py), px, py);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const o = (j * W + i) * 4;
      for (let k = 0; k < 3; k++) {
        // bilinear sample; longitude wraps, latitude clamps
        const src = srcs[k];
        const w = src.width;
        const u = (((lon + 180) / 360) * w - 0.5 + w) % w;
        const v = Math.min(Math.max(((90 - lat) / 180) * src.height - 0.5, 0), src.height - 1);
        const u0 = Math.floor(u); const v0 = Math.floor(v);
        const u1 = (u0 + 1) % w; const v1 = Math.min(v0 + 1, src.height - 1);
        const fu = u - u0; const fv = v - v0;
        const d = src.data; const t = out[k].data;
        const a = (v0 * w + u0) * 4; const b = (v0 * w + u1) * 4;
        const c = (v1 * w + u0) * 4; const e = (v1 * w + u1) * 4;
        for (let ch = 0; ch < 4; ch++) {
          t[o + ch] = (d[a + ch] * (1 - fu) + d[b + ch] * fu) * (1 - fv)
            + (d[c + ch] * (1 - fu) + d[e + ch] * fu) * fv;
        }
      }
    }
  }
  const canvasOf = (data) => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    if (data) c.getContext('2d').putImageData(data, 0, 0);
    return c;
  };
  const landRaw = canvasOf(out[1]);
  const landCut = canvasOf(null);
  const lc = landCut.getContext('2d');
  // Land outside the sections (Mexico, Greenland, Cuba, Russia in the
  // Alaska box) is greyed back so the eye stays on the sections, the way a
  // printed atlas mutes neighbouring countries.
  const foreign = dark ? 'grayscale(0.85) brightness(0.6)' : 'grayscale(0.8) brightness(1.08)';
  const solid = dark ? '#3b4a35' : '#9fb07f';
  const paint = (box, landD, secDs, lakesD) => {
    lc.save();
    lc.scale(K, K);
    if (box) {
      lc.beginPath();
      lc.rect(box.x, box.y, box.w, box.h);
      lc.clip();
    }
    const allLand = new Path2D(landD);
    const secLand = new Path2D();
    for (const d of secDs) { allLand.addPath(new Path2D(d)); secLand.addPath(new Path2D(d)); }
    for (const [clip, filter] of [[allLand, foreign], [secLand, 'none']]) {
      lc.save();
      lc.clip(clip);
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.filter = filter;
      // A solid fill under the relief, so a sliver where the raster's
      // coastline falls short of the vector one reads as land, not a hole.
      lc.fillStyle = solid;
      lc.fillRect(0, 0, W, H);
      lc.drawImage(landRaw, 0, 0);
      lc.restore();
    }
    lc.globalCompositeOperation = 'destination-out';
    lc.fill(new Path2D(lakesD));
    lc.restore();
  };
  const secs = Object.values(m.sections);
  paint(null, m.land, secs.filter((x) => x.frame === 0).map((x) => x.d), m.lakes);
  for (const b of m.insets) {
    lc.clearRect(b.x * K, b.y * K, b.w * K, b.h * K);
    const ds = b.key === 'NE'
      ? secs.filter((x) => x.ne).map((x) => x.ne.d)
      : secs.filter((x) => x.frame === b.frame).map((x) => x.d);
    paint(b, b.land, ds, b.lakes);
  }
  const base = canvasOf(out[0]);
  const bc = base.getContext('2d');
  // Same dimming the world map gives its relief in the dark theme.
  if (dark) bc.filter = 'brightness(0.8) saturate(0.9)';
  bc.drawImage(landCut, 0, 0);
  const url = (c) => new Promise((res) => c.toBlob((blob) => res(URL.createObjectURL(blob)), 'image/png'));
  return { base: await url(base), lights: await url(canvasOf(out[2])) };
}

// ---------------------------------------------------------------------
// Map export (the card header's "Save PNG"): the map on screen, as a
// PNG to post or keep. The live <svg> is styled by dashboard.css and draws
// same-origin / blob: images; an SVG loaded as an <img> can use neither,
// so the copy gets each element's computed paint inlined and every image
// inlined as a data: URL, then is drawn to a canvas at 3x with a caption
// strip (station, contest, count, UTC time) underneath.

// Presentation properties copied from computed style. Not filter/mask/
// clip-path: those are url(#id) references the elements already carry as
// attributes, except the dark theme's CSS brightness on the relief, which
// is copied when it isn't a url().
const MAP_EXPORT_PROPS = [
  'display', 'visibility', 'opacity', 'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linejoin', 'stroke-linecap',
  'stroke-dasharray', 'paint-order', 'font-family', 'font-size', 'font-weight',
  'letter-spacing', 'text-transform', 'text-anchor', 'dominant-baseline', 'mix-blend-mode',
];

// Alpine's own attributes (`:href`, `@click`, `x-html`, `x-show`...) are
// dropped from the copy. `:href` and friends aren't valid names in a
// namespaced XML document, so one left in made the whole exported SVG fail
// to load as an image -- Save PNG did nothing at all (seen live, v1.12.0).
function mapExportKeepAttr(name) {
  return !/^(:|@|x-)/.test(name);
}

// "WT2P_ARRL-SS-CW_sections_20261109-1422Z.png" -- anything that isn't a
// letter, digit or dash (a "/8" portable, spaces) becomes a dash.
function mapExportFilename({ call, contest, kind, date }) {
  const clean = (v) => String(v || '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const iso = date.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
  return [clean(call), clean(contest), kind, stamp].filter(Boolean).join('_') + '.png';
}

// "2026-11-09 1422Z", the caption's timestamp.
function mapExportStamp(date) {
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function renderMapPng(svg, { caption, scale = 3 }) {
  const vb = svg.viewBox.baseVal;
  const W = Math.round(vb.width * scale);
  const H = Math.round(vb.height * scale);

  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    let style = '';
    for (const p of MAP_EXPORT_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) style += `${p}:${v};`;
    }
    const f = cs.getPropertyValue('filter');
    if (f && f !== 'none' && !f.includes('url(')) style += `filter:${f};`;
    const d = dst[i];
    for (const a of [...d.attributes]) {
      if (!mapExportKeepAttr(a.name)) d.removeAttribute(a.name);
    }
    d.setAttribute('style', style);
  });
  clone.querySelectorAll('title').forEach((t) => t.remove());
  // index.html's comments inside the <svg> use "--" freely, which XML
  // forbids in a comment -- one left in and the copy won't parse (seen
  // live, v1.12.0, after the attribute fix). The copy needs none of them.
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((n) => n.remove());
  clone.setAttribute('width', W);
  clone.setAttribute('height', H);

  const cache = new Map();
  for (const img of clone.querySelectorAll('image')) {
    const href = img.getAttribute('href') || img.getAttribute('xlink:href');
    if (!href || href.startsWith('data:')) continue;
    if (!cache.has(href)) {
      cache.set(href, fetch(href).then((r) => r.blob()).then(blobToDataUrl));
    }
    img.setAttribute('href', await cache.get(href));
  }

  const xml = new XMLSerializer().serializeToString(clone);
  // An <img> only says "error"; the XML parser says why.
  const bad = new DOMParser().parseFromString(xml, 'image/svg+xml').querySelector('parsererror');
  if (bad) throw new Error(`exported SVG is not well-formed: ${bad.textContent.trim().slice(0, 300)}`);
  const svgUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('exported SVG did not load as an image'));
      img.src = svgUrl;
    });

    const root = getComputedStyle(document.documentElement);
    const tok = (n, d) => root.getPropertyValue(n).trim() || d;
    const capH = Math.round(18 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H + capH;
    const c = canvas.getContext('2d');
    c.fillStyle = tok('--surface', '#0a0a0a');
    c.fillRect(0, 0, canvas.width, canvas.height);
    c.drawImage(img, 0, 0, W, H);

    const pad = Math.round(8 * scale);
    const y = H + capH / 2;
    c.textBaseline = 'middle';
    c.font = `700 ${Math.round(9 * scale)}px 'IBM Plex Mono', ui-monospace, monospace`;
    c.fillStyle = tok('--text', '#e6edf3');
    c.textAlign = 'left';
    c.fillText(caption.left, pad, y);
    c.font = `400 ${Math.round(8 * scale)}px 'IBM Plex Mono', ui-monospace, monospace`;
    c.fillStyle = tok('--muted', '#8b949e');
    c.textAlign = 'right';
    c.fillText(caption.right, W - pad, y);

    return await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

// ---------------------------------------------------------------------
// Grayline (day/night terminator) -- pure date math, no server round trip,
// so it's recomputed client-side on the same 1s ticker as the UTC clock
// (see liveFeed()'s `now`). Spencer (1971) Fourier-series approximations
// for solar declination and the equation of time -- the same formulas
// NOAA's solar calculator is built on. Verified before use, not just
// trusted from memory: declination checked against the solstices/equinoxes
// (matches +-23.4 / ~0 as expected), and the terminator formula checked
// against a real astronomical fact -- at a solstice it should be tangent to
// the polar circle, i.e. |90 - declination|, and it comes out to 66.5-66.6
// in both directions, matching the real arctic/antarctic circle latitude
// (66.56 deg) almost exactly.
function solarDayAngle(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((date.getTime() - start) / 86400000);
  return (2 * Math.PI * dayOfYear) / 365;
}

function solarDeclinationDeg(date) {
  const g = solarDayAngle(date);
  const rad = 0.006918
    - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.001480 * Math.sin(3 * g);
  return (rad * 180) / Math.PI;
}

function equationOfTimeMinutes(date) {
  const g = solarDayAngle(date);
  return 229.18 * (0.000075
    + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
}

// The point on Earth where the sun is directly overhead right now.
function subsolarPoint(date) {
  const lat = solarDeclinationDeg(date);
  const eot = equationOfTimeMinutes(date);
  const utcHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const lonRaw = -15 * (utcHours - 12 + eot / 60);
  const lon = ((lonRaw + 540) % 360) - 180; // normalize to (-180, 180]
  return { lat, lon };
}

// The terminator's latitude at a given longitude: the great circle 90 deg
// from the subsolar point. Symmetric about the subsolar meridian by real
// geometry (reflecting across the pole-to-subsolar-point plane is a
// genuine symmetry of the setup) -- terminatorLat(sub.lon + x) really does
// equal terminatorLat(sub.lon - x), that was checked and is not a bug.
function terminatorLatDeg(lonDeg, sub) {
  const subLatRad = (sub.lat * Math.PI) / 180;
  if (Math.abs(subLatRad) < 1e-6) return 0; // equinox: avoid a /~0 blowup
  const dLon = ((lonDeg - sub.lon) * Math.PI) / 180;
  return (Math.atan(-Math.cos(dLon) / Math.tan(subLatRad)) * 180) / Math.PI;
}

// Maidenhead grid locator -> approximate center { lat, lon }. Mirrors
// src/analyze/geo.js's gridToLatLon() exactly -- no build step means no
// shared module between server and browser, so this is kept in sync by
// hand (same convention as ops-dashboard's winagent/agent structs). See
// that file's own comment for the field/square/subsquare math.
function gridToLatLon(grid) {
  if (!grid || typeof grid !== 'string') return null;
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}([0-9]{2}([A-X]{2})?)?$/.test(g)) return null;

  let lon = (g.charCodeAt(0) - 65) * 20 - 180;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90;
  let lonSpan = 20;
  let latSpan = 10;

  if (g.length >= 4) {
    lon += (g.charCodeAt(2) - 48) * 2;
    lat += (g.charCodeAt(3) - 48) * 1;
    lonSpan = 2;
    latSpan = 1;
  }
  if (g.length === 6) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24);
    lat += (g.charCodeAt(5) - 65) * (1 / 24);
    lonSpan = 2 / 24;
    latSpan = 1 / 24;
  }

  return { lat: lat + latSpan / 2, lon: lon + lonSpan / 2 };
}

function mapPanel() {
  return {
    // Map TV page (map-tv.js sets it): view only, HUD always on.
    tvMode: false,

    // World map card: shown/hidden per viewer (toggleWorldMap(), persisted
    // under WORLDMAP_KEY), and which theme's ocean image it draws. Both are
    // really set in init() -- this factory runs before any DOM/storage
    // exists in the tests' sandbox, so it can't read either here.
    showWorldMap: true,

    // False once the Score/Rate/Radios row has scrolled up under the
    // sticky header (watchTopRow()) -- the map then carries the map HUD:
    // last worked, score and rate (CJ, 2026-11-28: focus on the map but
    // keep that data there).
    topRowVisible: true,

    // The viewer's map pick, { contest, view } or null -- see mapView().
    // Per viewer, under MAPVIEW_KEY; set in init().
    mapViewPick: null,

    mapExportFailed: false, // the button reads "Save failed" for a few seconds

    mapExporting: false, // exportMap() in flight -- the button reads "Saving…"

    // Band filter for the map: 'all', or one of mapBands()' raw band
    // values. A view choice for right now, so it isn't persisted -- a
    // remembered 40m would silently empty the map in the next contest.
    mapBand: 'all',

    mapOceanHref: '/img/map/ocean-dark.webp',

    // public/img/map/sections.json once loadSectionMap() has fetched it --
    // only ever fetched while a section contest is on (sectionContest()).
    sectionMapData: null,

    _sectionMapLoading: false,

    // Object URLs of the world map imagery reprojected for the section map
    // (buildSectionImagery()); empty until built, and the vector map shows
    // on its own until then.
    sectionImagery: { base: '', lights: '' },

    // Per-viewer map choices from localStorage, the ocean image for the
    // theme, and a reset when the log is wiped. Call once from the page's
    // init(), after liveFeed() is part of the component.
    initMapPanel() {
      // A viewer's own show/hide choice (not on Map TV, where the map is the
      // page) and World | US/VE | ARRL pick.
      if (!this.tvMode) {
        try { this.showWorldMap = localStorage.getItem(WORLDMAP_KEY) !== 'hidden'; } catch { /* keep shown */ }
      }
      try { this.mapViewPick = JSON.parse(localStorage.getItem(MAPVIEW_KEY)); } catch { /* the default */ }
      // The theme toggle reloads the page, so reading it once is enough.
      if (document.documentElement.getAttribute('data-theme') === 'light') {
        this.mapOceanHref = '/img/map/ocean-light.webp';
      }
      this.onLive('cleared', () => { this.mapBand = 'all'; }); // that band's QSOs are gone too
    },

    // The newest QSO that counts (X-QSOs skipped; a QTC is shown, chipped).
    lastWorked() {
      return this.qsos.find((q) => isCountedQso(q)) || null;
    },

    // The map HUD shows once a QSO is logged (with none, the world map
    // itself isn't drawn): always on Map TV, and on the dashboard once the
    // top row is out of sight (the numbers are up there otherwise).
    mapHud() {
      return (this.tvMode || !this.topRowVisible) && this.lastWorked() != null;
    },

    // The shortest rate window, for the HUD: { value, label } or null.
    hudRate() {
      const r = this.rate && this.rate[0];
      if (!r || r.rate_per_hour == null) return null;
      return { value: r.rate_per_hour, label: (r.minutes ?? '?') + ' min' };
    },

    // Show/hide the world map card, remembered per viewer. A convenience,
    // not state anyone else needs -- so localStorage, and a storage failure
    // (private window, blocked site data) just means it isn't remembered.
    // "Save PNG" in the map card header -- see renderMapPng(). Whichever
    // map is showing (section or world), as it looks right now.
    async exportMap() {
      if (this.mapExporting) return;
      const svg = document.querySelector('#worldmap .map-box svg');
      if (!svg) return;
      this.mapExporting = true;
      try {
        const date = new Date();
        const call = this.stationCall();
        const contest = this.score.contest || (this.qsos[0] && this.qsos[0].contestname) || '';
        const mode = this.atlasMode();
        let detail;
        if (mode === 'sections' && this.sectionMapData) {
          const t = this.sectionTally();
          detail = `${t.worked} / ${t.total} sections`;
        } else {
          detail = this.mapBand === 'all' ? 'last 30 QSOs' : `last 30 QSOs on ${bandLabel(this.mapBand)}`;
        }
        const blob = await renderMapPng(svg, {
          caption: {
            left: [call, contest].filter(Boolean).join('  ·  '),
            right: `${detail}  ·  ${mapExportStamp(date)}`,
          },
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = mapExportFilename({ call, contest, kind: { regions: 'usve', sections: 'sections', plain: 'sections' }[mode] || 'worldmap', date });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch (err) {
        console.error('Map export failed:', err);
        this.mapExportFailed = true;
        setTimeout(() => { this.mapExportFailed = false; }, 4000);
      } finally {
        this.mapExporting = false;
      }
    },

    mapContestKey() {
      return this.score.contest || (this.qsos[0] && this.qsos[0].contestname) || '';
    },

    // Which map the card draws: 'world', 'na' (US/VE: states and
    // provinces) or 'arrl' (the sections). The viewer's pick while it's
    // the contest they picked it in; otherwise ARRL for an ARRL domestic
    // contest (SECTION_CONTEST_RE), World for anything else (CJ, 2026-11-09).
    mapView() {
      const p = this.mapViewPick;
      if (p && MAP_VIEWS.includes(p.view) && p.contest === this.mapContestKey()) return p.view;
      return this.sectionContest() ? 'arrl' : 'world';
    },

    setMapView(v) {
      if (!MAP_VIEWS.includes(v)) return;
      this.mapViewPick = { contest: this.mapContestKey(), view: v };
      try { localStorage.setItem(MAPVIEW_KEY, JSON.stringify(this.mapViewPick)); } catch { /* not remembered */ }
    },

    // How the atlas (sections.json) is drawn, or null for the world map:
    // 'sections' -- ARRL in an ARRL contest: worked / needed, no dots;
    // 'plain'    -- ARRL in any other contest: section outlines + QSO dots;
    // 'regions'  -- US/VE: state / province outlines + QSO dots.
    atlasMode() {
      const v = this.mapView();
      if (v === 'world') return null;
      if (v === 'na') return 'regions';
      return this.sectionContest() ? 'sections' : 'plain';
    },

    mapTitle() {
      return { world: 'World Map', na: 'US/VE Map', arrl: 'ARRL/RAC Sections' }[this.mapView()];
    },

    mapSubtitle() {
      if (this.atlasMode() === 'sections') {
        if (!this.sectionMapData) return '';
        const t = this.sectionTally();
        return `${t.worked} / ${t.total} worked`;
      }
      return this.mapBand === 'all' ? 'last 30 QSOs' : `last 30 QSOs on ${bandLabel(this.mapBand)}`;
    },

    toggleWorldMap() {
      this.showWorldMap = !this.showWorldMap;
      try { localStorage.setItem(WORLDMAP_KEY, this.showWorldMap ? 'shown' : 'hidden'); } catch { /* not remembered */ }
    },

    // Time zone bands in the style of SDR Console's World Map: a boundary
    // line every 15 deg (nominal nautical zones centered on each 15 deg
    // meridian, not the real political borders), every other band faintly
    // shaded, and a UTC-offset badge on each zone's center meridian along
    // the top edge. The +/-12 zones straddle the dateline at the map's
    // edges, so they get no badge (it would be cut in half). Static -- no
    // reactive reads, so x-html renders it once.
    mapZonesSvg() {
      const x = (lon) => ((lon + 180) / 360) * 1000;
      const out = [];
      for (let k = -12; k <= 12; k += 1) {
        const west = Math.max(-180, k * 15 - 7.5);
        const east = Math.min(180, k * 15 + 7.5);
        if (k % 2 !== 0) {
          out.push(`<rect x="${x(west).toFixed(2)}" y="0" width="${(x(east) - x(west)).toFixed(2)}" height="500" class="worldmap-zone-band"></rect>`);
        }
        if (k < 12) out.push(`<line x1="${x(east).toFixed(2)}" y1="0" x2="${x(east).toFixed(2)}" y2="500" class="worldmap-zone-line"></line>`);
      }
      for (let k = -11; k <= 11; k += 1) {
        const label = k > 0 ? `+${k}` : String(k);
        out.push(`<g class="worldmap-zone-badge"><circle cx="${x(k * 15).toFixed(2)}" cy="11" r="8.5"></circle>`
          + `<text x="${x(k * 15).toFixed(2)}" y="11">${label}</text></g>`);
      }
      return out.join('');
    },

    // Projects a lat/lon onto the SAME 1000x500 equirectangular canvas
    // the map layers were built on (public/img/map/, viewBox="0 0 1000 500") --
    // x = (lon+180)/360 * 1000, y = (90-lat)/180 * 500. Both must agree, or
    // dots land off the coastline they are supposedly on.
    projectLatLon(lat, lon) {
      return { x: ((lon + 180) / 360) * 1000, y: ((90 - lat) / 180) * 500 };
    },

    // this.qsos is newest-first (see stationCall()'s own note). A QTC is
    // relayed traffic re-sent for an existing contact (see isQtc), not a
    // new one -- worth excluding here for the same reason the MULT chip
    // does: counting it as one of "the last 30 QSOs" would both misstate
    // the count and duplicate a dot already plotted for its real QSO.
    // Only a QSO whose call actually resolves to a location (server-attached
    // lat/lon -- see src/routes/api.js / src/udp/index.js) gets a dot.
    //
    // With a band picked (mapBand), it's the last 30 on that band, not the
    // last 30 overall narrowed down -- otherwise a quiet band would show
    // only the one or two of its QSOs that happen to be recent.
    mapPoints() {
      const located = this.countedQsos()
        .filter((q) => !this.isQtc(q))
        .filter((q) => this.mapBand === 'all' || q.band === this.mapBand)
        .slice(0, 30)
        .filter((q) => q.lat != null && q.lon != null);

      // One dot per station per spot: the same call worked on several bands
      // resolves to the same lat/lon every time, so separate dots would sit
      // exactly on top of each other and only the top one could ever be
      // hovered (seen live: N3AD's newer 160m QSO hidden under its 80m
      // mult). Its tooltip lists every QSO, newest first, and it's a mult
      // dot if any of them was. Grouped by call AND spot, so a rover whose
      // exchange grid moved still gets a dot per location. band/mode stay
      // the newest QSO's.
      const groups = new Map();
      for (const q of located) { // newest-first
        const pt = this.projectLatLon(q.lat, q.lon);
        const id = `${q.call}|${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
        let g = groups.get(id);
        if (!g) {
          g = {
            key: q.ext_id ?? q.id ?? (q.call + q.band + q.mode + q.logged_at),
            call: q.call, band: q.band, mode: q.mode, mult: false, qsos: [], lat: q.lat, lon: q.lon, ...pt,
          };
          groups.set(id, g);
        }
        const mult = this.isMult(q);
        g.qsos.push({ band: q.band, mode: q.mode, mult });
        g.mult = g.mult || mult;
      }

      // SVG paints in document order, so oldest first puts the newest
      // station on top where different stations overlap. Then mult dots
      // last of all, so a mult never sits hidden under an ordinary dot
      // (same "make the notable one visible" reasoning as the Recent QSOs
      // chip, as z-order instead of color). The sort is stable, so each
      // group keeps its oldest-to-newest order.
      const points = [...groups.values()].reverse();
      points.sort((a, b) => (a.mult === b.mult ? 0 : a.mult ? 1 : -1));
      return points;
    },

    // Bands present in the log (QTCs excluded, as on the map), lowest
    // frequency first -- the choices for the map's band filter.
    mapBands() {
      const bands = new Set(this.countedQsos().filter((q) => !this.isQtc(q) && q.band).map((q) => q.band));
      return [...bands].sort((a, b) => bandSortKey(a) - bandSortKey(b));
    },

    // The dots are built as a raw SVG string and injected via x-html on a
    // <g> (index.html), NOT a <template x-for> inside the <svg> --
    // confirmed live in a real browser that Alpine's x-for/template breaks
    // there: the browser's foreign-content (HTML-inside-SVG) parsing of a
    // <template> mangles the directive attributes on its contents, so only
    // the first item ever bound and every attribute after it came out
    // empty ("p is not defined" thrown for the rest). x-html assigning
    // innerHTML on an SVG element parses correctly in the SVG namespace,
    // verified the same way. Escaped by hand since this is raw HTML now,
    // not Alpine's own auto-escaped x-text.
    mapDotsSvg() {
      return this.mapPoints().map((p) => this.mapDotSvg(p, p.x, p.y)).join('');
    },

    // The same dots on the US/VE map (a non-section contest with US/VE
    // picked): each reprojected into the atlas, DX off the map dropped.
    sectionDotsSvg() {
      const m = this.sectionMapData;
      if (!m || this.atlasMode() === 'sections') return '';
      return this.mapPoints()
        .map((p) => sectionDotPositions(m.frames, m.width, m.height, p.lon, p.lat)
          .map((q) => this.mapDotSvg(p, q.x.toFixed(1), q.y.toFixed(1))).join(''))
        .join('');
    },

    mapDotSvg(p, x, y) {
      const title = escapeHtml(`${p.call} — ${p.qsos.map((q) => `${bandLabel(q.band)} ${q.mode}${q.mult ? ' MULT' : ''}`).join(', ')}`);
      const cls = p.mult ? 'worldmap-dot worldmap-dot--mult' : 'worldmap-dot';
      const r = p.mult ? 4 : 3;
      // A nested <title> child, not a `title` attribute -- confirmed
      // that's what actually matters: a bare attribute only feeds the
      // accessible-name computation (which is why the earlier
      // getByTitle() check falsely looked like a pass), it does not
      // trigger a real hover tooltip. <title> is SVG's own, standard
      // tooltip mechanism.
      return `<circle cx="${x}" cy="${y}" r="${r}" class="${cls}"><title>${title}</title></circle>`;
    },

    // A section contest (see SECTION_CONTEST_RE) gets the section map in
    // place of the world map. The Score packet names the contest; a log
    // with no Score broadcast yet still has each QSO's own contestname.
    sectionContest() {
      return isSectionContest(this.score.contest) || isSectionContest(this.qsos[0] && this.qsos[0].contestname);
    },

    // Fetched once, the first time a section contest shows up (x-init on
    // the section map in index.html). A failure leaves it null, and the
    // next render of the card tries again.
    async loadSectionMap() {
      if (this.sectionMapData || this._sectionMapLoading) return;
      this._sectionMapLoading = true;
      try {
        const m = await fetch('/img/map/sections.json').then((r) => r.json());
        this.sectionMapData = m;
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        // Next frame, so the vector map paints first; the resample is a
        // one-off couple of million pixels.
        await new Promise((res) => requestAnimationFrame(res));
        this.sectionImagery = await buildSectionImagery(m, this.mapOceanHref, dark);
      } catch (err) {
        console.error('Failed to load section map:', err);
      } finally {
        this._sectionMapLoading = false;
      }
    },

    // The grayline mask's contents: each frame's night shape, blurred,
    // the insets clipped to their own boxes and blanked out of the main
    // frame's. Reads `this.now`, so it follows the same 1s ticker as the
    // world map's nightPolygonPath() -- kept apart from sectionMapSvg() so
    // the ticking doesn't re-render every section path each second.
    sectionNightMaskSvg() {
      const m = this.sectionMapData;
      if (!m) return '';
      const paths = sectionNightPaths(m.frames, new Date(this.now));
      const out = [`<path d="${paths[0]}" fill="#fff" filter="url(#secmap-soft)"></path>`];
      m.frames.slice(1).forEach((f, i) => {
        const [x, y, w, h] = f.box;
        out.push(`<clipPath id="secmap-clip-${i}"><rect x="${x}" y="${y}" width="${w}" height="${h}"></rect></clipPath>`);
        out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#000"></rect>`);
        out.push(`<g clip-path="url(#secmap-clip-${i})"><path d="${paths[i + 1]}" fill="#fff" filter="url(#secmap-soft)"></path></g>`);
      });
      return out.join('');
    },

    // Transmitter location on the section map: score.grid6, like
    // homePoint(), in whichever frame holds it (a KL7 or KH6 station lands
    // in its inset) -- and again in the Northeast close-up when it's in
    // there too. Raw SVG for the same x-for-in-<svg> reason as the dots.
    sectionHomeSvg() {
      const m = this.sectionMapData;
      const ll = gridToLatLon(this.score.grid6);
      if (!m || !ll) return '';
      const pts = [lccForward(sectionFrameFor(m.frames, ll.lon, ll.lat), ll.lon, ll.lat)];
      const ne = m.frames[3];
      if (ne) {
        const p = lccForward(ne, ll.lon, ll.lat);
        const [x, y, w, h] = ne.box;
        if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) pts.push(p);
      }
      const tip = escapeHtml(`Transmitter location — ${this.score.grid6}`);
      return pts.map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" class="worldmap-home"><title>${tip}</title></circle>`).join('');
    },

    // The section most recently worked for the first time, while that
    // first QSO is under 90 s old -- it pulses on the map so a room
    // watching the wall sees each new one land. Date.now(), not this.now:
    // reading the 1s ticker would re-render every section path each second.
    // A re-render after 90 s (the next QSO) drops the pulse; the CSS
    // animation also runs out on its own.
    newestNewSection() {
      const first = new Map();
      for (const q of this.countedQsos()) {
        if (this.isQtc(q) || !q.logged_at) continue;
        const code = sectionCode(q.section);
        const t = Date.parse(String(q.logged_at).replace(' ', 'T') + 'Z');
        if (!code || Number.isNaN(t)) continue;
        if (!first.has(code) || t < first.get(code)) first.set(code, t);
      }
      let best = null;
      let bestT = -Infinity;
      for (const [code, t] of first) if (t > bestT) { best = code; bestT = t; }
      return best && Date.now() - bestT < 90000 ? best : null;
    },

    // section code -> QSO count, over the QSOs that count (X-QSOs and QTCs
    // out, same as the world map). A code the map doesn't know (DX, a
    // miscopy) is kept here but simply has nothing to light up.
    workedSections() {
      const worked = new Map();
      for (const q of this.countedQsos()) {
        if (this.isQtc(q)) continue;
        const code = sectionCode(q.section);
        if (code) worked.set(code, (worked.get(code) || 0) + 1);
      }
      return worked;
    },

    // { worked, total, needed[] } against the map's own section list --
    // the card header's "N / 85" and the Needed line under the map.
    sectionTally() {
      const all = this.sectionMapData ? Object.keys(this.sectionMapData.sections) : [];
      const worked = this.workedSections();
      const needed = all.filter((s) => !worked.has(s)).sort();
      return { worked: all.length - needed.length, total: all.length, needed };
    },

    // Raw SVG string via x-html, for the same reason as mapDotsSvg(): no
    // x-for inside an <svg>. Every path, code and name comes from our own
    // JSON, never from a packet; the text is escaped anyway.
    //
    // Layout (sections.json): the main map, then the Alaska / Hawaii /
    // Northeast insets, each its own clipped panel with a title. A section
    // too small to label on the main map is labelled in the Northeast
    // close-up if it's there, else by a callout pill in open water.
    sectionMapSvg() {
      const m = this.sectionMapData;
      if (!m) return '';
      // atlasMode(): 'sections' fills in worked sections; 'plain' and
      // 'regions' show nothing worked or needed, with the QSO dots on top
      // (sectionDotsSvg()), and 'regions' draws states / provinces in place
      // of the sections.
      const mode = this.atlasMode() || 'sections';
      const plain = mode !== 'sections';
      const regions = mode === 'regions' && m.regions;
      const worked = plain ? new Map() : this.workedSections();
      const fresh = plain ? null : this.newestNewSection();
      const codes = Object.keys(m.sections);
      const flat = !this.sectionImagery.base; // flat land until the imagery is built
      const out = [];
      const shape = (code, d) => {
        const n = worked.get(code) || 0;
        const tip = escapeHtml(plain ? `${code} — ${m.sections[code].name}`
          : `${code} — ${m.sections[code].name}: ${n ? `${n} QSO${n === 1 ? '' : 's'}` : 'needed'}`);
        const cls = `secmap-sec${n ? ' secmap-sec--worked' : ''}${code === fresh ? ' secmap-sec--new' : ''}`;
        return `<path d="${d}" class="${cls}"><title>${tip}</title></path>`;
      };
      const label = (code, x, y, fs) => {
        const cls = worked.has(code) ? 'secmap-label secmap-label--worked' : 'secmap-label';
        return `<text x="${x}" y="${y}" font-size="${fs}" class="${cls}">${escapeHtml(code)}</text>`;
      };

      out.push('<defs>' + m.insets.map((b) => `<clipPath id="secmap-box-${b.key}"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"></rect></clipPath>`).join('') + '</defs>');
      if (flat) {
        out.push(`<path d="${m.land}" class="secmap-land"></path>`, `<path d="${m.lakes}" class="secmap-lake"></path>`);
      }
      if (regions) out.push(`<path d="${regions.main}" class="secmap-state"></path>`);
      else for (const code of codes) if (m.sections[code].frame === 0) out.push(shape(code, m.sections[code].d));
      out.push(`<path d="${m.neRegion}" class="secmap-region"></path>`);

      // Main-map labels and callouts, after every shape so no fill covers one.
      for (const code of regions ? [] : codes) {
        const s = m.sections[code];
        if (s.frame !== 0 || s.lx == null) continue;
        if (s.ax != null) {
          const on = worked.has(code);
          const w = code.length * 5.2 + 6;
          out.push(`<line x1="${s.lx}" y1="${s.ly}" x2="${s.ax}" y2="${s.ay}" class="secmap-leader"></line>`);
          out.push(`<circle cx="${s.ax}" cy="${s.ay}" r="1.4" class="secmap-anchor${on ? ' secmap-anchor--worked' : ''}"></circle>`);
          out.push(`<rect x="${(s.lx - w / 2).toFixed(1)}" y="${(s.ly - 5.5).toFixed(1)}" width="${w.toFixed(1)}" height="11" rx="2.5" class="secmap-pill${on ? ' secmap-pill--worked' : ''}"></rect>`);
        }
        out.push(label(code, s.lx, s.ly, s.fs));
      }

      // Insets: shapes and labels clipped to the panel, then its frame and title.
      for (const b of m.insets) {
        out.push(`<g clip-path="url(#secmap-box-${b.key})">`);
        if (flat) out.push(`<path d="${b.land}" class="secmap-land"></path>`, `<path d="${b.lakes}" class="secmap-lake"></path>`);
        if (regions) out.push(`<path d="${regions[b.key] || ''}" class="secmap-state"></path>`);
        const inPanel = regions ? [] : codes.filter((c) => (b.key === 'NE' ? m.sections[c].ne : m.sections[c].frame === b.frame));
        for (const code of inPanel) out.push(shape(code, b.key === 'NE' ? m.sections[code].ne.d : m.sections[code].d));
        for (const code of inPanel) {
          const s = b.key === 'NE' ? m.sections[code].ne : m.sections[code];
          if (s.lx != null) out.push(label(code, s.lx, s.ly, s.fs));
        }
        out.push('</g>');
        out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" class="secmap-inset"></rect>`);
        out.push(`<text x="${b.x + 4}" y="${b.y + 8}" class="secmap-inset-title">${escapeHtml(b.title)}</text>`);
      }

      // Legend.
      if (m.legend && plain) {
        const [lx, ly] = m.legend;
        out.push(`<g class="secmap-legend" transform="translate(${lx} ${ly})">`
          + '<circle cx="4" cy="0" r="3" class="worldmap-dot"></circle><text x="13" y="0">QSO</text>'
          + '<circle cx="54" cy="0" r="4" class="worldmap-dot worldmap-dot--mult"></circle><text x="63" y="0">Mult</text>'
          + '<circle cx="104" cy="0" r="4" class="worldmap-home"></circle><text x="112" y="0">Transmitter</text>'
          + '</g>');
      } else if (m.legend) {
        const [lx, ly] = m.legend;
        out.push(`<g class="secmap-legend" transform="translate(${lx} ${ly})">`
          + '<rect x="0" y="-4" width="9" height="8" class="secmap-sec secmap-sec--worked"></rect><text x="13" y="0">Worked</text>'
          + '<rect x="62" y="-4" width="9" height="8" class="secmap-sec"></rect><text x="75" y="0">Needed</text>'
          + '<circle cx="128" cy="0" r="4" class="worldmap-home"></circle><text x="136" y="0">Transmitter</text>'
          + '</g>');
      }
      return out.join('');
    },

    // The station's own location, from N1MM's reported transmitter grid
    // (score.grid6 -- the same field the header's grid-locator chip already
    // shows) -- not hardcoded, since the grid genuinely changes: a
    // different contest, a different physical QTH, even the same club call
    // operating from a different location. Recomputed from whatever
    // score.grid6 currently says, so it moves the moment a new Score
    // broadcast reports a different one. A single, non-repeated marker, so
    // (unlike mapDotsSvg) this binds directly via ordinary :cx/:cy/:title
    // attributes -- no <template x-for>, so none of that directive's
    // SVG-nesting bug applies here.
    homePoint() {
      const ll = gridToLatLon(this.score.grid6);
      if (!ll) return null;
      return { ...this.projectLatLon(ll.lat, ll.lon), grid: this.score.grid6 };
    },

    // Day/night terminator (grayline), propagation context for the map.
    // See the solar* functions' own header comment for the astronomy and
    // how it was checked. A single shape, like the land outline -- binds
    // directly via :d, not x-html/x-for. Recomputes every render because it
    // reads `this.now` (ticks every 1s, same clock utcClock() uses), which
    // is deliberate: the terminator itself barely moves in a second, but
    // recomputing on the existing ticker is simpler and cheap enough (a
    // ~180-point trig loop) rather than adding a second, slower timer just
    // to throttle it.
    nightPolygonPath() {
      const date = new Date(this.now);
      const sub = subsolarPoint(date);
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 2) {
        const { x, y } = this.projectLatLon(terminatorLatDeg(lon, sub), lon);
        pts.push(`${lon === -180 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
      }
      // Close along whichever pole is currently dark -- sub.lat > 0 (a
      // northern-hemisphere summer subsolar point) means the SOUTH pole is
      // the one in permanent darkness right now, and vice versa. Verified
      // by rendering both solstices and sampling actual pixels before
      // trusting this, not just by reading the formula.
      //
      // The shape is padded 40 units past the viewBox on the left, right
      // and pole sides (the terminator is periodic, so lon -180 and 180
      // share a y). The map blurs this shape into a soft-edged mask
      // (index.html's #worldmap-soft), and without the padding the blur
      // would also fade the night side along the map's own edges. The
      // <svg> clips anything outside the viewBox, so the padding is never
      // drawn.
      const darkPoleY = this.projectLatLon(sub.lat >= 0 ? -90 : 90, 180).y;
      const padPoleY = darkPoleY === 0 ? -40 : 540;
      const edgeY = this.projectLatLon(terminatorLatDeg(180, sub), 180).y.toFixed(1);
      pts[0] = `M-40,${edgeY}L${pts[0].slice(1)}`;
      pts.push(`L1040,${edgeY}`, `L1040,${padPoleY}`, `L-40,${padPoleY}`, 'Z');
      return pts.join('');
    },

    // The map HUD's COSB line: { call, rank, count, section } once COSB
    // lists this station (the board's standings switch on), else null.
    hudCosb() {
      const c = this.cosb;
      if (!c || c.status !== 'ok' || c.rank == null) return null;
      const me = (c.rows || []).find((r) => r.me);
      const scope = this.cosbScopeLabel();
      return {
        call: (me && me.call) || this.stationCall() || '', rank: c.rank, count: c.count,
        section: scope ? `${c.section || ''} · ${scope}` : c.section || '',
      };
    },
  };
}
