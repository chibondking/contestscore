// Not type="module" -- Alpine x-data="compare()" is evaluated in global
// scope. Compares two saved analyses (GET /api/analyze/<id>) side by side:
// headline metrics with a delta column, and a per-band QSO table. Both
// logs are public by id, so this page needs no auth.
function compare() {
  return {
    aId: '', bId: '',
    a: null, b: null,        // { meta, qsos }
    loading: true,
    error: '',

    async init() {
      const p = new URLSearchParams(location.search);
      this.aId = idFrom(p.get('a'));
      this.bId = idFrom(p.get('b'));
      if (!this.aId || !this.bId) {
        this.error = 'Need two analysis ids: /compare?a=<id>&b=<id>';
        this.loading = false;
        return;
      }
      try {
        const [a, b] = await Promise.all([load(this.aId), load(this.bId)]);
        this.a = a;
        this.b = b;
      } catch (err) {
        this.error = String(err.message || err);
      }
      this.loading = false;
    },

    get ready() { return !!(this.a && this.b); },

    // [{ label, a, b, delta, fmt }]
    get metricRows() {
      if (!this.ready) return [];
      const A = summarize(this.a);
      const B = summarize(this.b);
      const rows = [
        ['QSOs', A.qsos, B.qsos],
        ['Points', A.points, B.points, A.hasPoints || B.hasPoints],
        ['Mults', A.mults, B.mults, A.hasMults || B.hasMults],
        ['Pts / QSO', A.ppq, B.ppq, A.hasPoints || B.hasPoints, 2],
        ['DXCC', A.dxcc, B.dxcc],
        ['CQ zones', A.zones, B.zones],
        ['Bands', A.bands, B.bands],
        ['Hours active', A.hours, B.hours],
        ['Avg rate /h', A.rate, B.rate],
        ['Best 60 min', A.best60, B.best60],
      ];
      return rows
        .filter((r) => r[3] === undefined || r[3])
        .map(([label, a, b, , dp]) => ({
          label,
          a: fmtNum(a, dp),
          b: fmtNum(b, dp),
          delta: fmtDelta(b - a, dp),
          up: b - a > 0,
          down: b - a < 0,
        }));
    },

    get bandRows() {
      if (!this.ready) return [];
      const A = byBand(this.a.qsos);
      const B = byBand(this.b.qsos);
      const bands = [...new Set([...A.keys(), ...B.keys()])]
        .sort((x, y) => bandKey(x) - bandKey(y));
      return bands.map((band) => {
        const a = A.get(band) || 0;
        const b = B.get(band) || 0;
        return {
          band: bandLabel(band),
          a, b,
          delta: fmtDelta(b - a),
          up: b - a > 0, down: b - a < 0,
        };
      });
    },
  };
}

// --- helpers (module scope) ---------------------------------------------

function idFrom(s) {
  const m = String(s || '').trim().match(/([A-Za-z0-9_-]{4,40})\/?$/);
  return m ? m[1] : '';
}

async function load(id) {
  const r = await fetch(`/api/analyze/${encodeURIComponent(id)}`);
  if (r.status === 404) throw new Error(`Analysis "${id}" not found or expired`);
  if (!r.ok) throw new Error(`Failed to load "${id}" (${r.status})`);
  return r.json();
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

function summarize(log) {
  const qs = log.qsos || [];
  const meta = log.meta || {};
  const times = qs.map(qTime).filter((t) => !Number.isNaN(t)).sort((x, y) => x - y);
  const points = qs.reduce((s, q) => s + (Number(q.points) || 0), 0);
  const mults = qs.reduce((s, q) => s
    + (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0), 0);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const hrs = span / 3600000;
  const distinct = (fn) => new Set(qs.map(fn).filter(Boolean)).size;
  return {
    qsos: qs.length,
    points,
    mults,
    ppq: qs.length ? points / qs.length : 0,
    hasPoints: !!meta.has_points,
    hasMults: !!meta.has_mults,
    dxcc: distinct((q) => q.countryprefix),
    zones: distinct((q) => (q.zone && q.zone !== '0' ? q.zone : '')),
    bands: distinct((q) => q.band),
    hours: new Set(times.map((t) => Math.floor(t / 3600000))).size,
    rate: hrs > 0 ? Math.round(qs.length / hrs) : 0,
    best60: bestWindow(times, 3600000),
  };
}

function byBand(qsos) {
  const m = new Map();
  for (const q of qsos || []) {
    const b = q.band || '—';
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}

function bandKey(b) {
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

function fmtNum(n, dp) {
  if (dp) return Number(n).toFixed(dp);
  return Number(n).toLocaleString();
}

function fmtDelta(n, dp) {
  if (!n) return '—';
  const s = dp ? Math.abs(n).toFixed(dp) : Math.abs(Math.round(n)).toLocaleString();
  return (n > 0 ? '+' : '−') + s;
}
