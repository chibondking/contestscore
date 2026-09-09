// renderReport({ meta, qsos }) -> a single self-contained HTML string: the
// headline numbers plus the band x mode, hourly, top-DXCC and
// sections-worked tables, frozen for archiving. Loaded by analyze.js as a
// plain global (browser) and exported for tests (node). No dependencies.

function renderReport(data) {
  const meta = data.meta || {};
  const qsos = data.qsos || [];

  const times = qsos.map(qTime).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const points = qsos.reduce((s, q) => s + (Number(q.points) || 0), 0);
  const mults = qsos.reduce((s, q) => s + mc(q), 0);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const hrs = span / 3600000;
  const distinct = (fn) => new Set(qsos.map(fn).filter(Boolean)).size;

  const tiles = [
    ['QSOs', qsos.length.toLocaleString()],
    meta.has_points && ['Points', points.toLocaleString()],
    meta.has_mults && ['Mults', mults.toLocaleString()],
    meta.has_points && ['Pts / QSO', qsos.length ? (points / qsos.length).toFixed(2) : '0'],
    ['DXCC', distinct((q) => q.countryprefix)],
    ['CQ zones', distinct((q) => (q.zone && q.zone !== '0' ? q.zone : ''))],
    ['Bands', distinct((q) => q.band)],
    ['Hours active', new Set(times.map((t) => Math.floor(t / 3600000))).size],
    ['Avg rate', hrs > 0 ? `${Math.round(qsos.length / hrs)}/h` : '—'],
    ['Best 60 min', String(bestWindow(times, 3600000))],
  ].filter(Boolean);

  const title = esc([meta.contest || meta.contest_key || 'Contest log',
    meta.station_call].filter(Boolean).join(' — '));

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — report</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem; background: #000; color: #e6edf3;
    font-family: ui-monospace, Consolas, 'Roboto Mono', monospace; font-size: 14px; }
  h1 { font-size: 1.2rem; color: #58a6ff; margin: 0 0 .25rem; }
  h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .12em;
    color: #8b949e; margin: 2rem 0 .5rem; }
  .sub { color: #8b949e; font-size: .8rem; margin-bottom: 1.5rem; }
  .tiles { display: flex; flex-wrap: wrap; gap: 1rem 2.5rem; }
  .tile b { display: block; font-size: 1.6rem; color: #58a6ff; line-height: 1; }
  .tile span { font-size: .7rem; text-transform: uppercase; letter-spacing: .1em; color: #8b949e; }
  table { border-collapse: collapse; font-size: .85rem; margin-top: .25rem; }
  th, td { padding: .25rem .6rem; border-bottom: 1px solid #262626; text-align: left; }
  th { color: #8b949e; font-weight: normal; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-top: 2px solid #262626; font-weight: bold; }
  .chips { display: flex; flex-wrap: wrap; gap: .35rem; }
  .chip { border: 1px solid #262626; border-radius: 999px; padding: .15rem .5rem;
    font-size: .78rem; color: #8b949e; }
  .chip b { color: #e6edf3; }
  footer { margin-top: 3rem; color: #8b949e; font-size: .7rem; }
</style></head><body>

<h1>${title}</h1>
<div class="sub">
  ${esc(meta.filename || '')} &middot; ${qsos.length} QSOs${meta.excluded_count ? ` (+${meta.excluded_count} removed)` : ''}
  &middot; ${esc((meta.format || '').toUpperCase())}${meta.contest_key ? ` &middot; ${esc(meta.contest_key)}${meta.exchange_parsed ? ' exchange parsed' : ''}` : ''}
  &middot; generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}Z
</div>

<div class="tiles">
  ${tiles.map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('\n  ')}
</div>

<h2>QSOs by band &amp; mode</h2>
${bandModeTable(qsos, meta)}

<h2>Hourly</h2>
${hourlyTable(qsos)}

<h2>Top DXCC entities</h2>
${dxccTable(qsos)}

${sectionsBlock(qsos)}

<footer>ContestPulse analyzer report</footer>
</body></html>`;
}

// --- helpers ----------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mc(q) {
  return (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0);
}

function qTime(q) {
  const raw = q.n1mm_timestamp || q.logged_at;
  if (!raw) return NaN;
  const t = new Date(raw.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? NaN : t;
}

function bestWindow(times, windowMs) {
  if (!times.length) return 0;
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i += 1) {
    if (j < i) j = i;
    while (j + 1 < times.length && times[j + 1] - times[i] < windowMs) j += 1;
    if (j - i + 1 > best) best = j - i + 1;
  }
  return best;
}

function modeGroup(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return '—';
  if (m === 'CW') return 'CW';
  if (['USB', 'LSB', 'SSB', 'AM', 'FM', 'PH', 'PHONE', 'DV', 'FMN'].includes(m)) return 'PH';
  return 'DG';
}

function bandSortKey(b) {
  const n = parseFloat(b);
  return Number.isNaN(n) ? Infinity : n;
}

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

function bandModeTable(qsos, meta) {
  const groups = [...new Set(qsos.map((q) => modeGroup(q.mode)))]
    .sort((a, b) => ['CW', 'PH', 'DG', '—'].indexOf(a) - ['CW', 'PH', 'DG', '—'].indexOf(b));
  const bands = [...new Set(qsos.map((q) => q.band).filter(Boolean))]
    .sort((a, b) => bandSortKey(a) - bandSortKey(b));

  const cell = new Map();
  const bandTot = new Map();
  const grpTot = new Map();
  const bandPts = new Map();
  let grand = 0;
  let grandPts = 0;
  for (const q of qsos) {
    const b = q.band || '—';
    const g = modeGroup(q.mode);
    cell.set(`${b}|${g}`, (cell.get(`${b}|${g}`) || 0) + 1);
    bandTot.set(b, (bandTot.get(b) || 0) + 1);
    grpTot.set(g, (grpTot.get(g) || 0) + 1);
    bandPts.set(b, (bandPts.get(b) || 0) + (Number(q.points) || 0));
    grand += 1;
    grandPts += Number(q.points) || 0;
  }

  const head = ['Band', ...groups, 'Total', ...(meta.has_points ? ['Points'] : [])];
  const rows = bands.map((b) => {
    const cells = groups.map((g) => cell.get(`${b}|${g}`) || 0);
    return [bandLabel(b), ...cells, bandTot.get(b) || 0, ...(meta.has_points ? [bandPts.get(b) || 0] : [])];
  });
  const totalRow = ['Total', ...groups.map((g) => grpTot.get(g) || 0), grand,
    ...(meta.has_points ? [grandPts] : [])];

  return htmlTable(head, rows, totalRow);
}

function hourlyTable(qsos) {
  const by = new Map();
  for (const q of qsos) {
    const t = qTime(q);
    if (Number.isNaN(t)) continue;
    const h = Math.floor(t / 3600000);
    by.set(h, (by.get(h) || 0) + 1);
  }
  if (!by.size) return '<p class="chip">no timestamps</p>';
  const hs = [...by.keys()].sort((a, b) => a - b);
  const multiDay = hs[hs.length - 1] - hs[0] >= 24;
  let cum = 0;
  const rows = [];
  for (let h = hs[0]; h <= hs[hs.length - 1]; h += 1) {
    const n = by.get(h) || 0;
    cum += n;
    const d = new Date(h * 3600000);
    const label = multiDay
      ? `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}z`
      : `${pad(d.getUTCHours())}:00z`;
    rows.push([label, n, cum]);
  }
  return htmlTable(['Hour (UTC)', 'Q', 'Cum'], rows, ['Total', qsos.length, '']);
}

function dxccTable(qsos) {
  const by = new Map();
  for (const q of qsos) {
    const p = q.countryprefix;
    if (!p) continue;
    const e = by.get(p) || { q: 0, bands: new Set() };
    e.q += 1;
    if (q.band) e.bands.add(q.band);
    by.set(p, e);
  }
  if (!by.size) return '<p class="chip">no DXCC data</p>';
  const rows = [...by.entries()]
    .sort((a, b) => b[1].q - a[1].q)
    .slice(0, 20)
    .map(([p, e]) => [p, e.q, e.bands.size]);
  return htmlTable([`DXCC (${by.size} worked)`, 'Q', 'Bands'], rows, null);
}

function sectionsBlock(qsos) {
  const by = new Map();
  for (const q of qsos) {
    const s = (q.section || '').trim();
    if (s) by.set(s, (by.get(s) || 0) + 1);
  }
  if (!by.size) return '';
  const chips = [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([s, n]) => `<span class="chip"><b>${esc(s)}</b> ${n}</span>`)
    .join('');
  return `<h2>Sections / exchanges worked — ${by.size}</h2><div class="chips">${chips}</div>`;
}

function htmlTable(head, rows, totalRow) {
  const th = head.map((h, i) => `<th${i ? ' class="n"' : ''}>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${
    r.map((c, i) => `<td${i ? ' class="n"' : ''}>${esc(typeof c === 'number' ? c.toLocaleString() : c)}</td>`).join('')
  }</tr>`).join('');
  const tot = totalRow ? `<tr class="total">${
    totalRow.map((c, i) => `<td${i ? ' class="n"' : ''}>${esc(typeof c === 'number' ? c.toLocaleString() : c)}</td>`).join('')
  }</tr>` : '';
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}${tot}</tbody></table>`;
}

function pad(n) { return String(n).padStart(2, '0'); }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderReport };
}
