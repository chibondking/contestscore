// Not type="module" -- same reason as dashboard.js/charts.js/admin.js:
// Alpine's x-data="stats()" is evaluated in global scope, and a module's
// top-level declarations don't land there.
//
// QSO count and multiplier credit broken down by band x mode, one table per
// operator (plus a combined "All Operators" table). Computed entirely
// client-side from /api/qsos -- same approach as charts.js, no new backend
// endpoint. Live-refreshed on the same socket events the dashboard listens
// for, with a slow poll as a missed-event fallback.
function stats() {
  return {
    qsos: [],
    // 'ALL' shows the combined table plus one per operator; a specific
    // operator name narrows it to just that operator's table. Per-viewer
    // convenience only -- not worth persisting.
    selectedOp: 'ALL',

    async init() {
      await this.fetchData();
      const socket = io();
      const refresh = () => this.fetchData();
      socket.on('contact:new', refresh);
      socket.on('contact:delete', refresh);
      socket.on('db:cleared', refresh);
      setInterval(() => this.fetchData(), 30000);
    },

    async fetchData() {
      try {
        this.qsos = await fetch('/api/qsos').then((r) => r.json());
      } catch (err) {
        console.error('Failed to load stats data:', err);
      }
    },

    get operators() {
      return [...new Set(this.qsos.map((q) => q.operator || '—'))].sort();
    },

    // The mode-group columns to show, in canonical contest order (CW, then
    // phone, then digital), limited to the groups actually worked so a
    // CW-only contest doesn't render three empty PH/DG columns. Any group
    // modeGroup() can't place (shouldn't happen, but be safe) trails after,
    // sorted.
    get modeGroups() {
      const present = new Set(this.qsos.map((q) => modeGroup(q.mode)));
      const ordered = MODE_GROUP_ORDER.filter((g) => present.has(g));
      const extra = [...present].filter((g) => !ordered.includes(g)).sort();
      return [...ordered, ...extra];
    },

    get tables() {
      const out = [];
      const ops = this.operators;
      if (this.selectedOp === 'ALL') {
        if (ops.length > 1) out.push(this.buildTable('All Operators', this.qsos));
        for (const op of ops) {
          out.push(this.buildTable(op, this.qsos.filter((q) => (q.operator || '—') === op)));
        }
        if (ops.length === 0) out.push(this.buildTable('All Operators', []));
      } else {
        out.push(this.buildTable(
          this.selectedOp,
          this.qsos.filter((q) => (q.operator || '—') === this.selectedOp),
        ));
      }
      return out;
    },

    // rows: the QSO subset for this table (already operator-filtered).
    // Returns a flat column list plus per-band and total rows keyed by
    // column key, so the template stays a pair of dumb x-for loops.
    buildTable(title, rows) {
      const groups = this.modeGroups;

      const columns = [{ key: 'band', label: 'Band' }];
      for (const g of groups) {
        columns.push({ key: `${g}_q`, label: `${g} Q`, num: true });
        columns.push({ key: `${g}_m`, label: `${g} M`, num: true });
      }
      columns.push({ key: 'tot_q', label: 'Q', num: true });
      columns.push({ key: 'tot_m', label: 'M', num: true });
      columns.push({ key: 'pts', label: 'Pts', num: true });

      const zeroRow = () => {
        const o = { tot_q: 0, tot_m: 0, pts: 0 };
        for (const g of groups) { o[`${g}_q`] = 0; o[`${g}_m`] = 0; }
        return o;
      };

      const byBand = new Map(); // raw band value -> accumulator
      for (const q of rows) {
        const band = q.band || '—';
        if (!byBand.has(band)) byBand.set(band, zeroRow());
        const acc = byBand.get(band);
        const g = modeGroup(q.mode);
        // is_mult1/2/3 are N1MM's per-QSO multiplier flags -- the right
        // per-operator multiplier credit (score_snapshots.mults is a
        // per-broadcast contest total, not attributable to one op). Same
        // choice as charts.js's operatorTimeSeries().
        const m = (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0);
        acc[`${g}_q`] = (acc[`${g}_q`] || 0) + 1;
        acc[`${g}_m`] = (acc[`${g}_m`] || 0) + m;
        acc.tot_q += 1;
        acc.tot_m += m;
        acc.pts += Number(q.points) || 0;
      }

      const total = zeroRow();
      const bandRows = [...byBand.entries()]
        .sort((a, b) => bandSortKey(a[0]) - bandSortKey(b[0]))
        .map(([band, acc]) => {
          for (const c of columns) {
            if (c.key === 'band') continue;
            total[c.key] += acc[c.key] || 0;
          }
          // key on the raw band value -- two raw values could share a
          // display label (e.g. "10" and "10.1" -> "30m") and an x-for
          // :key must stay unique.
          return { key: band, band: bandLabel(band), ...acc };
        });

      return {
        title,
        columns,
        bandRows,
        totalRow: { band: 'Total', ...total },
      };
    },
  };
}

const MODE_GROUP_ORDER = ['CW', 'PH', 'DG'];

// Collapse N1MM's raw mode strings into the three buckets a contest score
// breakdown uses. Anything that isn't CW or a recognized phone mode is
// treated as digital (RTTY, PSK31, FT8, FT4, MFSK, DIGITAL, ...).
function modeGroup(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return '—';
  if (m === 'CW') return 'CW';
  if (['USB', 'LSB', 'SSB', 'AM', 'FM', 'PH', 'PHONE', 'DV', 'FMN'].includes(m)) return 'PH';
  return 'DG';
}

// N1MM's contactinfo `band` is in MHz as a string ("14", "3.5", "7"). Map
// the common HF/VHF bands to their wavelength label; fall back to the raw
// value for anything unrecognized.
function bandLabel(band) {
  const n = parseFloat(band);
  if (Number.isNaN(n)) return band || '—';
  const ranges = [
    [1.7, 2.1, '160m'], [3.4, 4.1, '80m'], [5.2, 5.5, '60m'], [6.9, 7.4, '40m'],
    [10.0, 10.2, '30m'], [13.9, 14.5, '20m'], [18.0, 18.2, '17m'], [20.9, 21.5, '15m'],
    [24.8, 25.1, '12m'], [27.9, 29.8, '10m'], [49, 55, '6m'], [69, 75, '4m'],
    [143, 149, '2m'], [218, 226, '1.25m'], [419, 451, '70cm'], [900, 928, '33cm'],
    [1240, 1300, '23cm'],
  ];
  const hit = ranges.find(([lo, hi]) => n >= lo && n < hi);
  return hit ? hit[2] : String(band);
}

function bandSortKey(band) {
  const n = parseFloat(band);
  return Number.isNaN(n) ? Infinity : n;
}
