// Solar page (/solar.html): the space-weather readings src/solar/ polls
// from hamqsl.com every ~2h and keeps in solar_snapshots, charted over a
// fixed 30-day window -- always 30 days, however much history exists, so a
// fresh install shows its short history at the right end of the same axis
// rather than stretched across the whole chart.
//
// Four small charts, one measure each (SFI, sunspots, A, K): they're on
// unrelated scales, and one chart with two y-axes would invite reading a
// relationship into where the lines cross. Each value is drawn as a step --
// it holds until the next reading, which is what a 2-hourly poll of a
// daily/3-hourly index actually means -- and the line breaks across a gap
// (poller or hamqsl outage) instead of drawing a straight line through it.
//
// Plain script, no Alpine: nothing here is reactive beyond "fetch, draw".
// The pure helpers are exported for test/public/solar.test.js.

const SOLAR_WINDOW_DAYS = 30;
const DAY_MS = 86400000;
// A step longer than this means readings are missing, not just spaced:
// the poller runs every 2h, so three missed polls in a row.
const SOLAR_GAP_MS = 6 * 3600000;

// Colors: fixed per measure (SFI amber and K purple match the compare
// page's session bars), validated in page order against both themes' card
// surfaces with the dataviz validator. One series per chart, so identity
// is the card title, never the color alone.
const SOLAR_MEASURES = [
  { field: 'sfi', id: 'solarSfi', label: 'Solar flux (SFI)', color: '#c98500', suggestedMin: 50 },
  { field: 'sunspots', id: 'solarSn', label: 'Sunspot number', color: '#199e70', min: 0 },
  { field: 'a_index', id: 'solarA', label: 'A-index', color: '#d95926', min: 0 },
  { field: 'k_index', id: 'solarK', label: 'K-index', color: '#9085e9', min: 0, max: 9, stepSize: 1, stormLine: 5 },
];

// "YYYY-MM-DD HH:MM:SS" (SQLite datetime('now'), UTC, no zone) <-> ms.
function solarTime(s) {
  return new Date(String(s).replace(' ', 'T') + 'Z').getTime();
}
function sqlUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// One measure as chart points {x: ms, y}, oldest first, with a null point
// after any reading followed by a gap longer than gapMs -- Chart.js breaks
// the line at a null (spanGaps false) rather than bridging the outage.
// Readings with no value for this field are skipped.
function solarSeries(rows, field, gapMs = SOLAR_GAP_MS) {
  const pts = (rows || [])
    .map((r) => ({ x: solarTime(r.fetched_at), y: r[field] }))
    .filter((p) => !Number.isNaN(p.x) && p.y != null && p.y !== '')
    .sort((a, b) => a.x - b.x);
  const out = [];
  pts.forEach((p, i) => {
    out.push({ x: p.x, y: Number(p.y) });
    const next = pts[i + 1];
    if (next && next.x - p.x > gapMs) out.push({ x: p.x + 1, y: null });
  });
  return out;
}

// Tick positions for the time axis: UTC midnights inside [min, max], every
// `every` days, counted from the newest midnight backwards so the most
// recent day is always labeled.
function solarDayTicks(min, max, every = 5) {
  const last = Math.floor(max / DAY_MS) * DAY_MS;
  const ticks = [];
  for (let t = last; t >= min; t -= every * DAY_MS) ticks.unshift(t);
  return ticks;
}

// NOAA's reading of a K-index: below 4 is quiet/unsettled, 4 is active,
// 5 and up is a geomagnetic storm, G1 (K5) through G5 (K9).
function kLabel(k) {
  if (k == null || k === '' || Number.isNaN(Number(k))) return '';
  const n = Number(k);
  if (n >= 5) return `G${Math.min(5, n - 4)} storm`;
  if (n >= 4) return 'active';
  return 'quiet';
}

// NOAA's bands for the (planetary) A-index -- a day's overall geomagnetic
// disturbance, where K is a 3-hour snapshot. Shared by the tile, the
// tooltip and the legend under the A chart (solar.html), so all three
// always agree.
const A_LEVELS = [
  { max: 7, label: 'quiet' },
  { max: 15, label: 'unsettled' },
  { max: 29, label: 'active' },
  { max: 49, label: 'minor storm' },
  { max: 99, label: 'major storm' },
  { max: Infinity, label: 'severe storm' },
];

function aLabel(a) {
  if (a == null || a === '' || Number.isNaN(Number(a))) return '';
  return A_LEVELS.find((l) => Number(a) <= l.max).label;
}

function fmtUtc(ms, withTime = true) {
  const d = new Date(ms);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return withTime
    ? `${date} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })} UTC`
    : date;
}

// --- browser only ---------------------------------------------------------

function solarThemeColors() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light
    ? { muted: '#5b5a52', text: '#1a1a1a', grid: '#c7c2a8', surface: '#ffffff' }
    : { muted: '#8b949e', text: '#e6edf3', grid: '#262626', surface: '#0a0a0a' };
}

// Vertical hover line at the tooltip's position -- the crosshair half of
// "crosshair + tooltip" on a line chart.
const solarCrosshair = {
  id: 'solarCrosshair',
  afterDraw(chart) {
    const active = chart.tooltip && chart.tooltip.getActiveElements();
    if (!active || !active.length) return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = solarThemeColors().muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Dashed reference line at the K-index storm threshold, labeled in muted
// ink -- context, not data.
function solarThreshold(value, label) {
  return {
    id: 'solarThreshold',
    beforeDatasetsDraw(chart) {
      const y = chart.scales.y.getPixelForValue(value);
      const { left, right } = chart.chartArea;
      const c = solarThemeColors();
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = c.muted;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = c.muted;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(label, right - 4, y - 4);
      ctx.restore();
    },
  };
}

function solarChartConfig(m, points, min, max) {
  const c = solarThemeColors();
  const ticks = solarDayTicks(min, max);
  return {
    type: 'line',
    data: {
      datasets: [{
        label: m.label,
        data: points,
        borderColor: m.color,
        backgroundColor: m.color,
        borderWidth: 2,
        stepped: 'after', // each reading holds until the next one
        pointRadius: points.length === 1 ? 4 : 0, // a lone reading still shows
        pointHoverRadius: 5,
        pointHoverBorderColor: c.surface,
        pointHoverBorderWidth: 2,
        spanGaps: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false }, // one series: the card heading names it
        tooltip: {
          filter: (item) => item.raw && item.raw.y != null,
          callbacks: {
            title: (items) => fmtUtc(items[0].raw.x),
            label: (item) => {
              const lvl = m.field === 'k_index' ? kLabel(item.raw.y) : m.field === 'a_index' ? aLabel(item.raw.y) : '';
              const extra = lvl ? ` (${lvl})` : '';
              return ` ${m.label}: ${item.raw.y}${extra}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min,
          max,
          afterBuildTicks: (axis) => { axis.ticks = ticks.map((value) => ({ value })); },
          ticks: { color: c.muted, callback: (v) => fmtUtc(v, false), maxRotation: 0, autoSkip: false },
          grid: { color: c.grid },
        },
        y: {
          min: m.min,
          max: m.max,
          suggestedMin: m.suggestedMin,
          ticks: { color: c.text, precision: 0, ...(m.stepSize ? { stepSize: m.stepSize } : {}) },
          grid: { color: c.grid },
        },
      },
    },
    plugins: [solarCrosshair, ...(m.stormLine ? [solarThreshold(m.stormLine, 'K5 = G1 storm')] : [])],
  };
}

const solarCharts = {};

function renderSolarTiles(latest) {
  const el = document.getElementById('solar-now');
  if (!latest || !latest.updated) {
    el.innerHTML = '<p class="empty">No reading yet -- the poller fetches every 2 hours (SOLAR_ENABLED must not be false).</p>';
    return;
  }
  const at = solarTime(latest.updated);
  const mins = Math.round((Date.now() - at) / 60000);
  const ago = mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  const tile = (label, value, note = '') => `
    <div class="solar-tile">
      <div class="solar-tile__label">${label}</div>
      <div class="solar-tile__value">${value ?? '—'}</div>
      ${note ? `<div class="solar-tile__note">${note}</div>` : ''}
    </div>`;
  el.innerHTML = `
    <div class="solar-tiles">
      ${tile('SFI', latest.sfi)}
      ${tile('Sunspots', latest.sunspots)}
      ${tile('A-index', latest.a, aLabel(latest.a))}
      ${tile('K-index', latest.k, kLabel(latest.k))}
      ${tile('X-ray', latest.xray)}
      ${tile('Geomag', latest.geomag)}
    </div>
    <p class="solar-updated">Latest reading ${fmtUtc(at)} (${ago})</p>`;
}

// Marks the current A-index band in the legend under the A chart.
function highlightALevel(a) {
  const current = aLabel(a);
  document.querySelectorAll('#solar-a-legend [data-level]').forEach((el) => {
    el.classList.toggle('solar-legend__item--now', el.dataset.level === current);
  });
}

function renderSolarTable(rows) {
  const el = document.getElementById('solar-table');
  const sorted = [...rows].sort((a, b) => solarTime(b.fetched_at) - solarTime(a.fetched_at));
  document.getElementById('solar-table-count').textContent = String(sorted.length);
  el.innerHTML = sorted.map((r) => `
    <tr>
      <td>${fmtUtc(solarTime(r.fetched_at))}</td>
      <td>${r.sfi ?? '—'}</td><td>${r.sunspots ?? '—'}</td>
      <td>${r.a_index ?? '—'}</td><td>${r.k_index ?? '—'} ${kLabel(r.k_index) ? `<span class="solar-note">${kLabel(r.k_index)}</span>` : ''}</td>
    </tr>`).join('');
}

async function loadSolarPage() {
  const now = Date.now();
  const min = now - SOLAR_WINDOW_DAYS * DAY_MS;
  let rows = [];
  let latest = null;
  try {
    const [hist, cur] = await Promise.all([
      fetch(`/api/solar/history?from=${encodeURIComponent(sqlUtc(min))}&to=${encodeURIComponent(sqlUtc(now))}`).then((r) => r.json()),
      fetch('/api/solar').then((r) => r.json()),
    ]);
    rows = Array.isArray(hist) ? hist : [];
    latest = cur;
  } catch (err) {
    document.getElementById('solar-status').textContent = `Couldn't load solar data: ${err.message}`;
    return;
  }

  renderSolarTiles(latest);
  highlightALevel(latest && latest.a);
  const inWindow = rows.filter((r) => solarTime(r.fetched_at) >= min);
  const first = inWindow.length ? solarTime(inWindow[0].fetched_at) : null;
  document.getElementById('solar-status').textContent = !rows.length
    ? 'No readings in the last 30 days.'
    : first - min > DAY_MS
      ? `${inWindow.length} readings; history starts ${fmtUtc(first, false)} -- earlier days have no data yet.`
      : `${inWindow.length} readings over the last 30 days.`;

  for (const m of SOLAR_MEASURES) {
    const canvas = document.getElementById(m.id);
    if (!canvas || typeof Chart === 'undefined') continue;
    if (solarCharts[m.id]) solarCharts[m.id].destroy();
    solarCharts[m.id] = new Chart(canvas, solarChartConfig(m, solarSeries(rows, m.field), min, now));
  }
  renderSolarTable(rows);
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    loadSolarPage();
    // New readings land every ~2h; checking every 15 min keeps a page left
    // open (a shack screen) current without hammering anything.
    setInterval(loadSolarPage, 15 * 60000);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { solarSeries, solarDayTicks, kLabel, aLabel, A_LEVELS, solarTime, sqlUtc, SOLAR_MEASURES, SOLAR_GAP_MS, DAY_MS };
}
