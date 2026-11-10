// localStorage key for the world map card's per-viewer show/hide (see
// toggleWorldMap()). Same contestpulse_ prefix as chrome.js's theme key.
const WORLDMAP_KEY = 'contestpulse_worldmap';
// ...and its World | US/VE choice for a contest without the section map
// (setMapView()): 'world' or 'na'.
const MAPVIEW_KEY = 'contestpulse_mapview';

// ---------------------------------------------------------------------
// Mult bell: a desk-bell "ding" when a new multiplier is logged. Per viewer
// (it's this browser's speaker), so localStorage like the map toggle, and
// OFF unless the viewer turns it on. `after` holds it quiet until the
// contest has more than that many mults -- early on nearly every QSO is a
// mult, and a ding a minute for the first many hours is just noise.
const MULTBELL_KEY = 'contestpulse_multbell';
const MULTBELL_DEFAULTS = { enabled: false, after: 0, volume: 0.6 };
// One ding per burst: ContestPulse's held contact queue (v1.8.0) can flush
// a backlog of QSOs in a few seconds after an outage.
const MULTBELL_COOLDOWN_MS = 2000;
// A QSO whose own N1MM timestamp is older than this is a replayed backlog,
// not news. Generous on purpose: the logging PC's clock may be off a bit.
const MULTBELL_MAX_AGE_MS = 15 * 60 * 1000;

// Whatever localStorage held (or nothing) -> a complete, sane settings object.
function normalizeMultBell(raw) {
  let s = raw;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { s = null; }
  }
  if (!s || typeof s !== 'object') s = {};
  const after = Math.floor(Number(s.after));
  const volume = Number(s.volume);
  return {
    enabled: s.enabled === true,
    after: Number.isFinite(after) && after > 0 ? after : 0,
    volume: s.volume != null && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : MULTBELL_DEFAULTS.volume,
  };
}

// Should this contact:new ring the bell? `isNew` is false for a
// contactreplace edit of a QSO already on screen -- an edit isn't a newly
// worked mult. `multCount` is the contest's mult total including this one.
// `n1mmAgeMs` is now minus the QSO's own logged timestamp (null if unknown).
function multBellShouldRing({ settings, isNew, isMult, counted, multCount, n1mmAgeMs, msSinceLastDing }) {
  if (!settings || !settings.enabled) return false;
  if (!isNew || !isMult || !counted) return false;
  if (!(multCount > settings.after)) return false;
  if (n1mmAgeMs != null && n1mmAgeMs > MULTBELL_MAX_AGE_MS) return false;
  if (msSinceLastDing != null && msSinceLastDing < MULTBELL_COOLDOWN_MS) return false;
  return true;
}

// multDingCount / MULTBELL_STRIKE_GAP_MS live in multbell.js (shared with the TUI).

// N1MM's <timestamp> ("2026-09-16 14:23:05", UTC) -> epoch ms, or null.
function n1mmTimestampMs(ts) {
  if (!ts) return null;
  const t = new Date(String(ts).trim().replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? null : t;
}

// Synthesized, so there's no audio file to ship or cache: a service bell is
// a bright fundamental plus a few inharmonic partials that die away faster
// the higher they are, struck by a short click. The two slightly detuned
// fundamentals beat against each other for the ring's shimmer. `delay`
// (seconds) schedules the strike later, for a double or triple ding.
function playDeskBell(ctx, volume, delay = 0) {
  const t0 = ctx.currentTime + 0.01 + delay;
  const out = ctx.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume)) * 0.35;
  out.connect(ctx.destination);
  const f0 = 1870;
  const partials = [
    [1, 1.0, 2.4], [1.0016, 0.6, 2.2], [2.74, 0.35, 0.9],
    [5.38, 0.18, 0.45], [8.9, 0.08, 0.25],
  ];
  for (const [ratio, amp, decay] of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = f0 * ratio;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(amp, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
    osc.connect(g).connect(out);
    osc.start(t0);
    osc.stop(t0 + decay + 0.05);
  }
  // The striker: 15ms of decaying noise.
  const len = Math.floor(ctx.sampleRate * 0.015);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const click = ctx.createBufferSource();
  const cg = ctx.createGain();
  cg.gain.value = 0.25;
  click.buffer = buf;
  click.connect(cg).connect(out);
  click.start(t0);
}

// Band field (N1MM's MHz, e.g. "7") -> ham band name ("40m"), and a sort
// key that orders bands by frequency. Same tables as report.js/compare.js
// -- each page's script is a plain classic script with no shared module
// (see CLAUDE.md), so each keeps its own copy.
function bandLabel(band) {
  const n = parseFloat(band);
  if (Number.isNaN(n)) return band || '—';
  const ranges = [
    [1.7, 2.1, '160m'], [3.4, 4.1, '80m'], [5.2, 5.5, '60m'], [6.9, 7.4, '40m'],
    [10.0, 10.2, '30m'], [13.9, 14.5, '20m'], [18.0, 18.2, '17m'], [20.9, 21.5, '15m'],
    [24.8, 25.1, '12m'], [27.9, 29.8, '10m'], [49, 55, '6m'], [69, 75, '4m'],
    [143, 149, '2m'], [218, 226, '1.25m'], [419, 451, '70cm'],
  ];
  const hit = ranges.find(([lo, hi]) => n >= lo && n < hi);
  return hit ? hit[2] : String(band);
}

function bandSortKey(b) {
  const n = parseFloat(b);
  return Number.isNaN(n) ? Infinity : n;
}

// An X-QSO (N1MM's IsClaimedQso 0, stored as is_claimed_qso) stays in the
// log -- Recent QSOs shows it, marked -- but counts toward nothing: no QSO
// totals, rates, operator stats, continents or map dots. Missing/null counts
// (older rows, loggers that never send the flag), same as the column default.
// A Score source that reports on an interval rather than per QSO -- DXLog.net
// (see scoreIsDelayed()). Matched on the broadcast's <soft>.
// DXLog's score timer runs 2-30 min (CJ, 2026-09-30). Gaps outside these
// bounds aren't the timer -- see scoreIntervalMinutes().
const DXLOG_MIN_GAP_MS = 90 * 1000;
const DXLOG_MAX_GAP_MS = 45 * 60 * 1000;

function isDelayedScoreSource(soft) {
  return /^dxlog/i.test(String(soft || ''));
}

function isCountedQso(q) {
  return q.is_claimed_qso == null || Number(q.is_claimed_qso) !== 0;
}

// The Operators table's rules, copied from stats.js (dedupeForScoring,
// modeGroup, bestWindow) so its numbers match the Stats page: a dupe (same
// call, band and mode group; the earliest one counts) is dropped, and peak
// rate is the best *sliding* window, not a fixed clock block. Change one,
// change the other -- tui/index.js has a third copy.
function rateModeGroup(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return '—';
  if (m === 'CW') return 'CW';
  if (['USB', 'LSB', 'SSB', 'AM', 'FM', 'PH', 'PHONE', 'DV', 'FMN'].includes(m)) return 'PH';
  return 'DG';
}

function dedupeForRate(qs, timeOf) {
  const best = new Map();
  const passthrough = [];
  for (const q of qs) {
    const t = timeOf(q);
    if (/QTC/i.test(q.exchange1 || '') || t == null || Number.isNaN(t)) { passthrough.push(q); continue; }
    const k = `${(q.call || '').toUpperCase()}|${q.band || ''}|${rateModeGroup(q.mode)}`;
    const e = best.get(k);
    if (!e || t < e.t) best.set(k, { q, t });
  }
  return [...passthrough, ...[...best.values()].map((e) => e.q)];
}

// Most entries of `times` (sorted ascending, ms) inside any window of windowMs.
function bestWindowCount(times, windowMs) {
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    if (j < i) j = i;
    while (j + 1 < times.length && times[j + 1] - times[i] < windowMs) j += 1;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

// Used by mapDotsSvg() below, which builds raw SVG markup by hand (see its
// own comment for why) -- Alpine's x-text auto-escapes, but a hand-built
// HTML string doesn't, and a callsign/exchange field ultimately comes from
// whatever the logger sent.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
    c.font = `700 ${Math.round(9 * scale)}px 'Fira Code', ui-monospace, monospace`;
    c.fillStyle = tok('--text', '#e6edf3');
    c.textAlign = 'left';
    c.fillText(caption.left, pad, y);
    c.font = `400 ${Math.round(8 * scale)}px 'Fira Code', ui-monospace, monospace`;
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
// (see dashboard()'s `now`). Spencer (1971) Fourier-series approximations
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

// "W1AW/4", "OK2CQR/P" -> the base call. Mirrors src/lookup/index.js's
// stripSuffix() exactly (kept in sync by hand, like gridToLatLon above) --
// lookup:result's `base` is the server's version, so the two must agree for
// a portable call's dot to be matched.
function stripSuffix(raw) {
  const c = String(raw || '').trim().toUpperCase();
  if (!c || !c.includes('/')) return c;

  const parts = c.split('/').filter(Boolean);
  if (parts.length === 1) return parts[0];

  const tail = parts[parts.length - 1];
  if (/^(P|M|MM|AM|A|R|QRP|LH|\d{1,2})$/.test(tail)) parts.pop();
  if (parts.length === 1) return parts[0];

  const looksLikeCall = (t) => /\d/.test(t) && t.length >= 3;
  const [a, b] = parts;
  if (looksLikeCall(a) && !looksLikeCall(b)) return a;
  if (looksLikeCall(b) && !looksLikeCall(a)) return b;
  return a.length >= b.length ? a : b;
}

function dashboard() {
  // Chart.js instances live here, in a plain closure variable -- NOT as
  // Alpine data properties. Same reactivity trap as charts.js: Alpine
  // deep-wraps returned x-data objects in a Proxy, which breaks Chart.js's
  // internal state on a later .update() call. See charts.js's own comment
  // for the full explanation.
  let scoreSparkline = null;
  let rateSparkline = null;
  // Mult bell's Web Audio context, made on first use; and when it last rang.
  let audioCtx = null;
  let lastDingAt = null;

  return {
    connected: false,
    // Mult bell settings (normalizeMultBell), read from localStorage in
    // init(); the header popover is open or not; and whether the browser is
    // still blocking sound until someone clicks the page (autoplay policy --
    // after a reload, a wall display needs one click before it can ding).
    multBell: { ...MULTBELL_DEFAULTS },
    multBellOpen: false,
    audioBlocked: false,
    score: {},
    // Full-contest score time series, just for the Score card's sparkline --
    // fetched once and refreshed on score:update, same idea as charts.html's
    // trend charts but shrunk down to fit the space Feed Status left behind
    // when it moved into the header.
    scoreHistory: [],
    radios: [],
    qsos: [],
    // World map card: shown/hidden per viewer (toggleWorldMap(), persisted
    // under WORLDMAP_KEY), and which theme's ocean image it draws. Both are
    // really set in init() -- this factory runs before any DOM/storage
    // exists in the tests' sandbox, so it can't read either here.
    showWorldMap: true,
    // 'world' or 'na' (US/VE) for a contest without the section map --
    // usveMap(). Per viewer, under MAPVIEW_KEY; set in init().
    mapView: 'world',
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
    // Per-station ContestPulse (or other bridge) liveness, keyed by
    // station_id. Not contest data -- db:cleared deliberately leaves this
    // alone, since it reflects the bridge process, not the QSO log.
    bridges: [],
    // N1MM-style rate meter: [{ minutes, qsos, rate_per_hour }, ...]. Pure
    // function of wall-clock time (a lull should visibly decay the rate
    // even with no new QSOs), so this is polled on a timer, not just
    // refreshed on contact:new.
    rate: [],
    // { commit, deployedAt } from GET /api/version, shown in the footer.
    // Only changes on a real deploy -- a stale/cached page would show an
    // old timestamp here even though nothing else looks obviously wrong.
    version: {},
    // Optional-feature switches from GET /api/features. `lookup.enabled`
    // gates the Possible Busts card entirely -- no lookup provider, no card.
    features: {},
    // QSOs whose callsign HamQTH doesn't recognise (from GET /api/busts).
    // Server-derived from the live log + cache, so a call fixed in the
    // logger drops off on the next fetch (the 60s poll or a lookup:result).
    busts: [],
    // Latest space-weather reading from GET /api/solar / solar:update.
    // { updated: null } until the first server-side fetch lands.
    solar: { updated: null },
    // "Last updated" ticker: lastUpdateAt bumps on every socket event or
    // successful poll; now ticks every second so secondsSinceUpdate()
    // counts up live in the header even between events, proving the page
    // itself is still alive and not just frozen mid-render.
    lastUpdateAt: Date.now(),
    now: Date.now(),

    init() {
      const socket = io();

      socket.on('connect',    () => { this.connected = true; this.touch(); });
      socket.on('disconnect', () => { this.connected = false; });

      socket.on('radio:update', (data) => {
        // Matches the backend's identity key (station_name, radio_nr), not
        // radio_nr alone -- see CLAUDE.md: two different multi-op stations
        // can both report radio_nr=1.
        const idx = this.radios.findIndex((r) => (
          (r.station_name || '') === (data.station_name || '') && r.radio_nr === data.radio_nr
        ));
        if (idx >= 0) this.radios[idx] = data;
        else this.radios.push(data);
        this.radios = [...this.radios];
        this.touch();
      });

      socket.on('contact:new', (data) => {
        // A contactreplace edit re-emits contact:new with the same ext_id --
        // update that row in place instead of prepending a duplicate (which
        // would leave two rows sharing the same x-for :key, exactly the
        // kind of thing that breaks Alpine's DOM reconciliation).
        const idx = data.ext_id ? this.qsos.findIndex((q) => q.ext_id === data.ext_id) : -1;
        if (idx >= 0) {
          this.qsos[idx] = data;
          this.qsos = [...this.qsos];
        } else {
          this.qsos = [data, ...this.qsos];
        }
        this.maybeRingMultBell(data, idx < 0);
        this.fetchRate();
        this.touch();
      });

      socket.on('contact:delete', (data) => {
        this.qsos = this.qsos.filter((q) => (
          data.ext_id ? q.ext_id !== data.ext_id : !(q.call === data.call && q.band === data.band)
        ));
        this.fetchRate();
        this.fetchBusts(); // a deleted QSO may have been a flagged bust
        this.touch();
      });

      // The lookup:result event fires for both N1MM's own <lookupinfo> and
      // the HamQTH queue. A not-found result is a new possible bust -- pull
      // the freshly-derived list rather than trying to reconstruct the row
      // (band/mode/op) from the lookup payload, which doesn't carry it.
      socket.on('lookup:result', (data) => {
        if (data && data.found === false) this.fetchBusts();
        // A found result with a usable grid carries lat/lon (src/udp/
        // index.js). Move this call's already-plotted dots there -- their
        // contact:new went out before the lookup ran, so they're sitting on
        // the country-file estimate. A QSO's own exchange grid still wins,
        // same as resolveLatLonEnriched on the server.
        if (data && data.lat != null && data.lon != null && data.base) {
          let moved = false;
          const qsos = this.qsos.map((q) => {
            if (q.locSource === 'exchange' || stripSuffix(q.call) !== data.base) return q;
            moved = true;
            return { ...q, lat: data.lat, lon: data.lon, locSource: data.locSource };
          });
          if (moved) this.qsos = qsos;
        }
      });

      socket.on('solar:update', (data) => {
        if (data) this.solar = data;
        this.touch();
      });

      socket.on('score:update', (data) => {
        this.score = data;
        this.fetchScoreHistory();
        this.touch();
      });

      socket.on('bridge:status', (data) => {
        const idx = this.bridges.findIndex((b) => b.station_id === data.station_id);
        if (idx >= 0) this.bridges[idx] = data;
        else this.bridges.push(data);
        this.bridges = [...this.bridges];
        this.touch();
      });

      socket.on('db:cleared', () => {
        this.qsos = [];
        this.score = {};
        this.scoreHistory = [];
        this.radios = [];
        this.busts = [];
        this.mapBand = 'all'; // that band's QSOs are gone too
        this.fetchRate(); // trailing windows should drop to zero, not linger
        this.touch();
      });

      this.fetchInitialState();
      this.fetchVersion();
      this.fetchFeatures();
      this.fetchBusts();
      this.fetchSolar();
      // Map: a viewer's own show/hide choice, and the ocean for the active
      // theme (the theme toggle reloads the page, so reading it once here
      // is enough -- same as the Chart.js colors).
      try { this.showWorldMap = localStorage.getItem(WORLDMAP_KEY) !== 'hidden'; } catch { /* keep shown */ }
      try { this.mapView = localStorage.getItem(MAPVIEW_KEY) === 'na' ? 'na' : 'world'; } catch { /* world */ }
      try { this.multBell = normalizeMultBell(localStorage.getItem(MULTBELL_KEY)); } catch { /* defaults: off */ }
      // Browsers only start audio after a user gesture. Any click or key on
      // the page counts, so unlock on the first one if the bell is on.
      const unlock = () => { if (this.multBell.enabled) this.ensureAudio(); };
      window.addEventListener('pointerdown', unlock);
      window.addEventListener('keydown', unlock);
      if (this.multBell.enabled) this.ensureAudio();
      if (document.documentElement.getAttribute('data-theme') === 'light') {
        this.mapOceanHref = '/img/map/ocean-light.webp';
      }
      // The rate windows decay purely with elapsed time, so they need to be
      // re-fetched on a timer even when nothing else is happening.
      setInterval(() => this.fetchRate(), 30000);
      // Slow safety-net poll so a bust that was corrected in the logger
      // clears even if the lookup:result / contact events were missed.
      setInterval(() => this.fetchBusts(), 60000);
      // Drives the header's live "updated Xs ago" ticker.
      setInterval(() => { this.now = Date.now(); }, 1000);
    },

    touch() {
      this.lastUpdateAt = Date.now();
    },

    secondsSinceUpdate() {
      return Math.max(0, Math.round((this.now - this.lastUpdateAt) / 1000));
    },

    // Contesting runs on UTC, not local time -- reuses the same `now` tick
    // that already drives secondsSinceUpdate(), so no extra timer.
    utcClock() {
      return new Date(this.now).toISOString().slice(11, 19) + 'Z';
    },

    // The call this station is actually transmitting under -- N1MM's
    // Station Data callsign, which is not necessarily the operator's own
    // (a club call like WT9P/K9CT while WT2P sits at the keyboard). Read from
    // `mycall`, never `operator`/`ops`/OpCall: a club station can have several
    // operators at once, and those fields name the people, not the station.
    // this.qsos is newest-first (API and socket path both), so the first row
    // with a mycall is the call in use right now, which also follows a mid-
    // contest change; score.call (the periodic dynamicresults snapshot)
    // covers a page load before any QSO has been logged.
    stationCall() {
      const q = this.qsos.find((row) => row.mycall);
      return (q && q.mycall) || this.score.call || '';
    },

    // score.qsos comes from N1MM's own periodic dynamicresults broadcast --
    // a snapshot, not an event fired per QSO -- while this.qsos already
    // grows in real time off contact:new. NOT a raw count comparison
    // (qsos.length > score.qsos): a genuine dupe -- the same station worked
    // twice, its own real contactinfo packet each time, own ext_id each
    // time -- legitimately lands two rows in the live log while N1MM's own
    // running qso tally in dynamicresults excludes dupes from the count, so
    // a count-based check would flag "stale" forever the moment any dupe is
    // logged even once caught up (confirmed live on scoreboard.wt2p.us,
    // CW-OPS 2026-09-16: 2 genuine dupes pinned qsos.length 2 over
    // score.qsos permanently). Compare timestamps instead: a QSO landed
    // after the score's own captured_at, and enough time has passed since
    // then (comfortably past the observed ~10s broadcast cadence) that a
    // fresh snapshot should have caught up by now.
    //
    // Not for a delayed score source (DXLog -- see scoreIsDelayed()): there
    // the lag is DXLog's reporting interval, expected and always present,
    // and the score-source chip already says so. "Catching up" would sit
    // on the card almost permanently.
    scoreStale() {
      if (this.scoreIsDelayed()) return false;
      if (!this.score.captured_at || this.qsos.length === 0) return false;
      const capturedAt = new Date(this.score.captured_at).getTime();
      // qsos[0] is the most recent QSO -- getQsos() orders DESC and
      // contact:new prepends (see socket.on('contact:new') above).
      const lastQsoAt = new Date(this.qsos[0].logged_at.replace(' ', 'T') + 'Z').getTime();
      const STALE_GRACE_MS = 30000;
      return lastQsoAt > capturedAt && (this.now - capturedAt) > STALE_GRACE_MS;
    },

    // DXLog.net sends its Score broadcast on the same timer as its online-
    // scoreboard posts -- minutes apart, not after every QSO like N1MM -- so
    // the Score card is behind the live QSO log by design. Detected from
    // the broadcast's own <soft> (see parsers/score.js).
    scoreIsDelayed() {
      return isDelayedScoreSource(this.score.soft);
    },

    // The measured gap between DXLog's recent Score posts, in whole minutes
    // -- the median of the last few. DXLog's timer is 2-30 min, so a gap
    // under 90s is a manual score push (not the timer) and one over 45 min
    // is a pause or a restart; both are ignored. null until there are at
    // least two timer gaps to go on.
    scoreIntervalMinutes() {
      const times = this.scoreHistory
        .filter((r) => isDelayedScoreSource(r.soft))
        .map((r) => new Date(r.captured_at).getTime())
        .filter((t) => !Number.isNaN(t));
      const gaps = times.slice(1).map((t, i) => t - times[i])
        .filter((g) => g >= DXLOG_MIN_GAP_MS && g <= DXLOG_MAX_GAP_MS)
        .slice(-6)
        .sort((a, b) => a - b);
      if (gaps.length < 2) return null;
      return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] / 60000));
    },

    scoreSourceChip() {
      if (!this.scoreIsDelayed()) return '';
      const m = this.scoreIntervalMinutes();
      return m ? `DXLog · every ~${m} min` : 'DXLog · delayed';
    },

    formatDeployTime(iso) {
      return iso ? new Date(iso).toLocaleString() : '';
    },

    // Footer label for a hosted (tenant) scoreboard, next to the deploy
    // info -- '' on a standalone install, so nothing shows there. On the
    // club's own hostname it's that hostname's first label ("k9ct-score");
    // on an alias like scoreboard.wt2p.us it's "tenant wt2p". The app
    // doesn't know the hostname suffix (routing config), so it reads the
    // label rather than building one.
    tenantLabel(hostname = (typeof location !== 'undefined' ? location.hostname : '')) {
      const t = this.features && this.features.tenant;
      if (!t || !t.call) return '';
      const id = String(t.call).toLowerCase();
      const label = String(hostname || '').toLowerCase().split('.')[0];
      return label.startsWith(id) ? label : `tenant ${id}`;
    },

    // Tally of qsos by continent (N1MM's own 2-letter codes: NA/SA/EU/AS/
    // AF/OC/AN). Computed client-side from the already-loaded qsos array
    // rather than a new backend endpoint -- the full log is already in
    // memory here.
    continentCounts() {
      const counts = {};
      for (const q of this.countedQsos()) {
        const c = (q.continent || '').trim().toUpperCase();
        if (!c) continue;
        counts[c] = (counts[c] || 0) + 1;
      }
      return counts;
    },

    // Sequential encoding (one hue, magnitude by intensity -- this is a
    // "compare magnitude across a labeled region" job, not an identity one,
    // so per the dataviz skill it's one hue, not a categorical palette).
    // A darker navy, not --accent itself: --accent (rgb(88,166,255), a
    // light sky blue) is tuned to pop as a small link/highlight, but filled
    // in behind a whole row at high alpha it got bright enough to wash out
    // the label text sitting on top of it (reported live against a real
    // EU=23 row). Scaling alpha instead of stepping through a light->dark
    // ramp: this theme is permanently dark, so "recedes toward the surface"
    // means low alpha, not a lighter tint (a light tint would stand out
    // against the near-black background, the opposite of receding). Capped
    // below full opacity so even the top of the ramp stays dark enough for
    // --text on top to read clearly.
    continentTileStyle(code) {
      const counts = this.continentCounts();
      const max = Math.max(1, ...Object.values(counts));
      const count = counts[code] || 0;
      if (count === 0) return {};
      const intensity = count / max; // 0..1, empty tiles excluded above
      const alpha = 0.2 + 0.5 * intensity;
      return {
        background: `rgba(24, 68, 130, ${alpha})`,
        borderColor: `rgba(24, 68, 130, ${Math.min(1, alpha + 0.2)})`,
      };
    },

    // Per-operator stats (QSO count, points, peak rate), the same breakdown
    // the original Node-RED dashboard showed for multi-op stations. Computed
    // client-side from the already-loaded qsos array, same approach as
    // continentCounts() -- no new backend endpoint needed. Dupes are dropped
    // and peak rate is the best sliding 60/10 minutes, the same rules as the
    // Stats page (see dedupeForRate above), so the two pages agree. The 60m
    // count already is the rate/hr; the 10m column is extrapolated (x6) and
    // noisier on purpose -- a short hot streak a 60m window smooths out.
    operatorStats() {
      const timeOf = (q) => (q.logged_at ? new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime() : NaN);
      const byOp = new Map();
      for (const q of dedupeForRate(this.countedQsos(), timeOf)) {
        const op = q.operator || '—';
        if (!byOp.has(op)) byOp.set(op, { operator: op, qsos: 0, points: 0, times: [] });
        const entry = byOp.get(op);
        entry.qsos += 1;
        entry.points += Number(q.points) || 0;
        const t = timeOf(q);
        if (!Number.isNaN(t)) entry.times.push(t);
      }
      return [...byOp.values()]
        .map((entry) => {
          const times = entry.times.sort((a, b) => a - b);
          return {
            operator: entry.operator,
            qsos: entry.qsos,
            points: entry.points,
            peakRate60: bestWindowCount(times, 3600000),
            peakRate10: bestWindowCount(times, 600000) * 6,
          };
        })
        .sort((a, b) => b.qsos - a.qsos);
    },

    // "R1" for the common single-station case (SO1R/SO2R); once more than
    // one distinct station is reporting (multi-op, separate physical
    // stations), prefix with the station name too, since radio_nr alone no
    // longer identifies which physical radio it is.
    radioLabel(r) {
      if (r.radio_nr == null) return '—';
      const stations = new Set(this.radios.map((x) => x.station_name || ''));
      if (stations.size > 1 && r.station_name) {
        return r.station_name + ' R' + r.radio_nr;
      }
      return 'R' + r.radio_nr;
    },

    // WAE (and a couple of other DARC-rules contests): a logged row can be
    // a QTC -- a relayed traffic report about an earlier QSO, not a new
    // contact -- rather than an ordinary QSO. N1MM marks which is which in
    // the same field the Cabrillo line-type prefix comes from, passed
    // through untouched as qsos.exchange1 -- confirmed against a real
    // packet as "SQTC" (sent) or "RQTC" (received), not the bare "QTC"
    // originally guessed, hence the substring match rather than equality.
    // Most contests never populate exchange1 as anything but blank or a
    // real exchange value, so this stays a no-op there.
    isQtc(q) {
      return /QTC/i.test(q.exchange1 || '');
    },

    // N1MM's own verdict that this QSO counted as a new multiplier for the
    // active contest -- <ismultiplier1/2/3> in the ContactInfo packet
    // (stored as is_mult1/2/3). Which of the three is which is contest-
    // specific (e.g. state/section vs. zone vs. DXCC), so any of them
    // lights the flag rather than this guessing at a meaning. N1MM decides
    // it when the QSO is logged, so a later edit that changes the status
    // arrives as a contactreplace and updates the row in place. The logger
    // is the authority: an unflagged QSO is simply not a mult here, no
    // second-guessing from callsign, contest name or anything else.
    // One exception on our side: a WAE QTC is relayed traffic, not a contact,
    // so it never carries the flag whatever the packet says.
    isMult(q) {
      if (this.isQtc(q)) return false;
      return !!(q.is_mult1 || q.is_mult2 || q.is_mult3);
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
        const sec = this.sectionContest() && this.sectionMapData;
        const na = !sec && this.usveMap();
        let detail;
        if (sec) {
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
        a.download = mapExportFilename({ call, contest, kind: sec ? 'sections' : (na ? 'usve' : 'worldmap'), date });
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

    setMapView(v) {
      this.mapView = v === 'na' ? 'na' : 'world';
      try { localStorage.setItem(MAPVIEW_KEY, this.mapView); } catch { /* not remembered */ }
    },

    // The card draws the US/VE atlas (sections.json) rather than the world
    // map: always for a section contest (sections filled in), and on the
    // viewer's World | US/VE choice for any other (QSO dots, like the world
    // map's).
    usveMap() {
      return this.sectionContest() || this.mapView === 'na';
    },

    toggleWorldMap() {
      this.showWorldMap = !this.showWorldMap;
      try { localStorage.setItem(WORLDMAP_KEY, this.showWorldMap ? 'shown' : 'hidden'); } catch { /* not remembered */ }
    },

    // Mults so far, including any just prepended: N1MM's own total from the
    // Score broadcast, or the flagged QSOs in the live log, whichever is
    // higher -- the Score snapshot lags the log, and a logger with no
    // <mult> breakdown leaves score.mults null.
    multCount() {
      const logged = this.qsos.filter((q) => isCountedQso(q) && this.isMult(q)).length;
      const reported = Number(this.score.mults);
      return Math.max(logged, Number.isFinite(reported) ? reported : 0);
    },

    maybeRingMultBell(q, isNew) {
      const now = Date.now();
      const ts = n1mmTimestampMs(q.n1mm_timestamp);
      const ring = multBellShouldRing({
        settings: this.multBell,
        isNew,
        isMult: this.isMult(q),
        counted: isCountedQso(q),
        multCount: this.multBell.enabled ? this.multCount() : 0,
        n1mmAgeMs: ts == null ? null : now - ts,
        msSinceLastDing: lastDingAt == null ? null : now - lastDingAt,
      });
      if (!ring) return;
      lastDingAt = now;
      this.ding(multDingCount(q));
    },

    // Make (or wake) the audio context. Must first run inside a user
    // gesture or the browser leaves it suspended; audioBlocked says so in
    // the popover until a click lets it through.
    ensureAudio() {
      try {
        if (!audioCtx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return null;
          audioCtx = new Ctx();
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().then(() => { this.audioBlocked = false; }).catch(() => {});
        }
        this.audioBlocked = audioCtx.state !== 'running';
        return audioCtx;
      } catch {
        return null;
      }
    },

    ding(strikes = 1) {
      const ctx = this.ensureAudio();
      if (!ctx) return;
      try {
        for (let i = 0; i < Math.max(1, strikes); i += 1) {
          playDeskBell(ctx, this.multBell.volume, (i * MULTBELL_STRIKE_GAP_MS) / 1000);
        }
      } catch { /* no sound, no harm */ }
    },

    saveMultBell() {
      this.multBell = normalizeMultBell(this.multBell);
      try { localStorage.setItem(MULTBELL_KEY, JSON.stringify(this.multBell)); } catch { /* not remembered */ }
      if (this.multBell.enabled) this.ensureAudio();
    },

    multBellTitle() {
      if (!this.multBell.enabled) return 'Mult bell: off';
      return this.multBell.after > 0
        ? `Mult bell: on after ${this.multBell.after} mults (${this.multCount()} so far)`
        : 'Mult bell: on';
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

    bandLabel(band) { return bandLabel(band); },

    // The QSOs that count (see isCountedQso) -- what every total, rate and
    // map dot on this page is built from. this.qsos itself keeps X-QSOs so
    // Recent QSOs can still show them.
    countedQsos() { return this.qsos.filter(isCountedQso); },
    isXQso(q) { return !isCountedQso(q); },

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
      if (!m || this.sectionContest()) return '';
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
      // Plain: the US/VE view of a non-section contest -- the same atlas,
      // nothing worked or needed, QSO dots on top (sectionDotsSvg()).
      const plain = !this.sectionContest();
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
      for (const code of codes) if (m.sections[code].frame === 0) out.push(shape(code, m.sections[code].d));
      out.push(`<path d="${m.neRegion}" class="secmap-region"></path>`);

      // Main-map labels and callouts, after every shape so no fill covers one.
      for (const code of codes) {
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
        const inPanel = codes.filter((c) => (b.key === 'NE' ? m.sections[c].ne : m.sections[c].frame === b.frame));
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

    async fetchInitialState() {
      try {
        const [qsos, score, scoreHistory, radios, bridges, rate] = await Promise.all([
          fetch('/api/qsos').then((r) => r.json()),
          fetch('/api/score').then((r) => r.json()),
          fetch('/api/score/history').then((r) => r.json()),
          fetch('/api/radios').then((r) => r.json()),
          fetch('/api/bridges').then((r) => r.json()),
          fetch('/api/rate').then((r) => r.json()),
        ]);
        this.qsos         = qsos;
        this.score        = score;
        this.scoreHistory = scoreHistory;
        this.radios       = radios;
        this.bridges      = bridges;
        this.rate         = rate;
        this.touch();
      } catch (err) {
        console.error('Failed to load initial state:', err);
      }
    },

    async fetchRate() {
      try {
        this.rate = await fetch('/api/rate').then((r) => r.json());
        this.touch();
      } catch (err) {
        console.error('Failed to refresh rate:', err);
      }
    },

    async fetchScoreHistory() {
      try {
        this.scoreHistory = await fetch('/api/score/history').then((r) => r.json());
      } catch (err) {
        console.error('Failed to refresh score history:', err);
      }
    },

    // Same bucketing approach as charts.js's rateOverTime()/
    // autoBucketMinutes(), shrunk down for a small in-card sparkline rather
    // than a full trend chart -- still spans a 48-hour contest without
    // rendering hundreds of cramped points.
    autoBucketMinutes() {
      const times = this.countedQsos()
        .map((q) => q.logged_at && new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime())
        .filter((t) => t && !Number.isNaN(t));
      if (times.length < 2) return 15;
      const spanMinutes = (Math.max(...times) - Math.min(...times)) / 60000;
      const sizes = [5, 10, 15, 30, 60, 120];
      return sizes.find((m) => spanMinutes / m <= 30) || sizes[sizes.length - 1];
    },

    rateOverTime() {
      const bucketMinutes = this.autoBucketMinutes();
      const bucketMs = bucketMinutes * 60000;
      const counts = new Map();
      for (const q of this.countedQsos()) {
        const t = q.logged_at ? new Date(q.logged_at.replace(' ', 'T') + 'Z').getTime() : NaN;
        if (Number.isNaN(t)) continue;
        const bucket = Math.floor(t / bucketMs) * bucketMs;
        counts.set(bucket, (counts.get(bucket) || 0) + 1);
      }
      const perHour = 60 / bucketMinutes;
      return [...counts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, count]) => Math.round(count * perHour));
    },

    // Sparklines: no axes, no legend, no gridlines -- just the shape of the
    // trend, filling the space Feed Status left behind when it moved into
    // the header. Chart.js instances are kept in the closure variables
    // above dashboard()'s return, not on `this` -- see the top-of-file
    // comment for why.
    renderScoreSparkline() {
      const canvas = document.getElementById('scoreSparkline');
      if (!canvas || typeof Chart === 'undefined') return;
      const values = this.scoreHistory.map((s) => s.points);

      if (scoreSparkline) {
        scoreSparkline.data.labels = values.map((_, i) => i);
        scoreSparkline.data.datasets[0].data = values;
        scoreSparkline.update();
        return;
      }
      scoreSparkline = new Chart(canvas, sparklineConfig(values, '#eb6834', 'rgba(235, 104, 52, 0.15)'));
    },

    renderRateSparkline() {
      const canvas = document.getElementById('rateSparkline');
      if (!canvas || typeof Chart === 'undefined') return;
      const values = this.rateOverTime();

      if (rateSparkline) {
        rateSparkline.data.labels = values.map((_, i) => i);
        rateSparkline.data.datasets[0].data = values;
        rateSparkline.update();
        return;
      }
      // Palette slot-1 blue; wt2p.us amber in the wt2p theme (charts.js primarySeries()).
      const wt2p = document.documentElement.getAttribute('data-theme') === 'wt2p';
      rateSparkline = new Chart(canvas, sparklineConfig(values, wt2p ? '#ff9400' : '#2a78d6', wt2p ? 'rgba(255, 148, 0, 0.15)' : 'rgba(42, 120, 214, 0.15)'));
    },

    async fetchVersion() {
      try {
        this.version = await fetch('/api/version').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load version info:', err);
      }
    },

    async fetchFeatures() {
      try {
        this.features = await fetch('/api/features').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load features:', err);
      }
    },

    async fetchBusts() {
      try {
        const res = await fetch('/api/busts').then((r) => r.json());
        this.busts = res.busts || [];
      } catch (err) {
        console.error('Failed to refresh busts:', err);
      }
    },

    // DB logged_at is UTC "YYYY-MM-DD HH:MM:SS"; show just HH:MMz.
    bustTime(loggedAt) {
      if (!loggedAt) return '—';
      const d = new Date(loggedAt.replace(' ', 'T') + 'Z');
      return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().slice(11, 16)}z`;
    },

    async fetchSolar() {
      try {
        this.solar = await fetch('/api/solar').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load solar data:', err);
      }
    },

    // Hover text for the header chip -- the fuller picture the three
    // headline numbers leave out.
    solarTooltip() {
      const s = this.solar;
      const parts = [];
      if (s.sfi != null) parts.push(`SFI ${s.sfi}`);
      if (s.sunspots != null) parts.push(`SN ${s.sunspots}`);
      if (s.a != null) parts.push(`A ${s.a}`);
      if (s.k != null) parts.push(`K ${s.k}`);
      if (s.xray) parts.push(`X-ray ${s.xray}`);
      if (s.geomag) parts.push(s.geomag);
      if (s.updated) {
        const d = new Date(s.updated.replace(' ', 'T') + 'Z');
        if (!Number.isNaN(d.getTime())) parts.push(`updated ${d.toISOString().slice(0, 16).replace('T', ' ')}Z`);
      }
      return parts.join('  ·  ');
    },
  };
}

// Minimal Chart.js config shared by the Score/Rate cards' sparklines --
// same colors as charts.html's full trend charts (dataviz reference
// palette slots 1/2) so a viewer sees the same series as the same color on
// either page, but with every axis/legend/grid stripped since this is
// decorative-but-informative filler for a card, not an analytical chart.
function sparklineConfig(values, borderColor, backgroundColor) {
  // The ring around the highlighted point needs to sit on the card's own
  // surface color to read as "floating" rather than a plain dot -- same
  // white/near-black split as dashboard.css's --surface token. Chart.js
  // draws on canvas, invisible to CSS, so it's picked once here, the same
  // approach charts.js's themeColors() uses (a theme toggle reloads the
  // page, so this never needs to react live).
  const theme = document.documentElement.getAttribute('data-theme');
  const ring = theme === 'light' ? '#ffffff' : (theme === 'wt2p' ? '#121212' : '#0a0a0a');
  const isLast = (ctx) => ctx.dataIndex === ctx.dataset.data.length - 1;
  return {
    type: 'line',
    data: {
      labels: values.map((_, i) => i),
      datasets: [{
        data: values,
        borderColor,
        backgroundColor,
        fill: true,
        tension: 0.3,
        borderWidth: 2,
        // Every point stays invisible except the latest one, which gets a
        // solid dot -- "where the number on the tile came from," at a
        // glance, without needing the axis/legend this sparkline has no
        // room for. Scriptable so it keeps tracking the last point across
        // the .update() calls above (the trailing window keeps sliding),
        // not just the point that happened to be last at first render.
        pointRadius: (ctx) => (isLast(ctx) ? 4 : 0),
        pointHoverRadius: (ctx) => (isLast(ctx) ? 4 : 0),
        pointBackgroundColor: borderColor,
        pointBorderColor: ring,
        pointBorderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true },
      },
    },
  };
}
