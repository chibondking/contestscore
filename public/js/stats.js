// Not type="module" -- same reason as dashboard.js/charts.js/admin.js:
// Alpine's x-data="stats()" is evaluated in global scope, and a module's
// top-level declarations don't land there.
//
// A post-contest analysis page in the spirit of SH5 / CBS: many breakdowns
// of the same QSO log -- by band, mode, hour, operator, multiplier,
// continent, DXCC, points, callsign shape. Everything is computed
// client-side from GET /api/qsos (same approach as charts.js -- no new
// backend endpoint), and re-derived whenever a contact:new / contact:delete
// / db:cleared socket event lands, with a 30s poll as a missed-event
// fallback.
//
// The operator dropdown in the header scopes every section except the
// Operator Leaderboard (which always compares all operators).
function stats() {
  return {
    qsos: [],
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

    get hasData() { return this.qsos.length > 0; },

    get operators() {
      return [...new Set(this.qsos.map((q) => q.operator || '—'))].sort();
    },

    // Every section below the top table honours the operator dropdown;
    // 'ALL' is the whole station.
    get scopedQsos() {
      return this.selectedOp === 'ALL'
        ? this.qsos
        : this.qsos.filter((q) => (q.operator || '—') === this.selectedOp);
    },

    // ================================================================
    // 1. EXISTING: band x mode / multiplier by operator -- kept at the
    //    very top of the page, unchanged in spirit from the first version.
    // ================================================================
    get modeGroups() { return presentModeGroups(this.qsos); },

    get tables() {
      if (!this.hasData) return [];
      const out = [];
      const ops = this.operators;
      if (this.selectedOp === 'ALL') {
        if (ops.length > 1) out.push(this.buildTable('All Operators', this.qsos));
        for (const op of ops) {
          out.push(this.buildTable(op, this.qsos.filter((q) => (q.operator || '—') === op)));
        }
      } else {
        out.push(this.buildTable(
          this.selectedOp,
          this.qsos.filter((q) => (q.operator || '—') === this.selectedOp),
        ));
      }
      return out;
    },

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

      const byBand = new Map();
      for (const q of rows) {
        const band = q.band || '—';
        if (!byBand.has(band)) byBand.set(band, zeroRow());
        const acc = byBand.get(band);
        const g = modeGroup(q.mode);
        const m = multCount(q);
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
          return { key: band, band: bandLabel(band), ...acc };
        });

      return {
        title,
        columns,
        rows: bandRows,
        totalRow: { band: 'Total', ...total },
      };
    },

    // ================================================================
    // At a Glance -- headline numbers for the current scope
    // ================================================================
    get headline() {
      const qs = this.scopedQsos;
      const times = sortedTimes(qs);
      const pts = sum(qs, (q) => Number(q.points) || 0);
      const mults = sum(qs, multCount);
      const elapsedMs = times.length > 1 ? times[times.length - 1] - times[0] : 0;
      const elapsedHrs = elapsedMs / 3600000;
      return [
        { label: 'QSOs', value: qs.length.toLocaleString() },
        { label: 'Points', value: pts.toLocaleString() },
        { label: 'Mults', value: mults.toLocaleString() },
        { label: 'Pts / QSO', value: qs.length ? (pts / qs.length).toFixed(2) : '0' },
        { label: 'Avg Rate', value: elapsedHrs > 0 ? `${Math.round(qs.length / elapsedHrs)}/h` : '—' },
        { label: 'DXCC', value: distinct(qs, (q) => q.countryprefix) },
        { label: 'CQ Zones', value: distinct(qs, (q) => (q.zone && q.zone !== '0' ? q.zone : '')) },
        { label: 'Bands', value: distinct(qs, (q) => q.band) },
        { label: 'Hrs Active', value: new Set(times.map((t) => Math.floor(t / 3600000))).size },
        { label: 'Elapsed', value: elapsedMs ? fmtDur(elapsedMs) : '—' },
      ];
    },

    // ================================================================
    // Rate records -- best sliding windows, first/last, longest gap
    // ================================================================
    get rateRecords() {
      const qs = this.scopedQsos;
      const times = sortedTimes(qs);
      if (times.length < 2) return [];

      const b60 = bestWindow(times, 60 * 60000);
      const b30 = bestWindow(times, 30 * 60000);
      const b10 = bestWindow(times, 10 * 60000);

      let gap = 0;
      let gapAt = NaN;
      for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] > gap) { gap = times[i] - times[i - 1]; gapAt = times[i - 1]; }
      }

      const bestHr = this.hourly.rows.reduce((a, r) => (r._q > (a ? a._q : -1) ? r : a), null);

      return [
        { label: 'First QSO', value: fmtStamp(times[0]) },
        { label: 'Last QSO', value: fmtStamp(times[times.length - 1]) },
        { label: 'Best clock hour', value: bestHr ? `${bestHr._q} Q  (${bestHr.hour})` : '—' },
        { label: 'Best 60 min', value: `${b60.count} Q  (from ${fmtStamp(b60.start)})` },
        { label: 'Best 30 min', value: `${b30.count} Q  (≈ ${b30.count * 2}/h)` },
        { label: 'Best 10 min', value: `${b10.count} Q  (≈ ${b10.count * 6}/h)` },
        { label: 'Longest gap', value: gap >= 60000 ? `${fmtDur(gap)}  (from ${fmtStamp(gapAt)})` : '— (no gap over 1 min)' },
      ];
    },

    // ================================================================
    // Every matrix-shaped card, in display order. Each returns
    //   { title, columns:[{key,label,num?}], rows:[{key,...}], totalRow, barKey? }
    // or null when there's nothing to show, and the template renders them
    // all through one generic <table> block.
    // ================================================================
    get matrixCards() {
      if (!this.hasData) return [];
      return [
        this.summaryCard,
        this.leaderboardCard,
        this.hourly,
        this.runSpCard,
        this.multBandsCard,
        this.continentCard,
        this.dxccCard,
        this.pointsDistCard,
        this.callLenCard,
      ].filter(Boolean);
    },

    get summaryCard() {
      const qs = this.scopedQsos;
      const groups = presentModeGroups(qs);

      const columns = [{ key: 'band', label: 'Band' }];
      for (const g of groups) columns.push({ key: g, label: g, num: true });
      columns.push({ key: 'q', label: 'Total Q', num: true });
      columns.push({ key: 'pts', label: 'Points', num: true });
      columns.push({ key: 'ppq', label: 'Pts/Q', num: true });

      const blank = () => {
        const o = { q: 0, pts: 0 };
        for (const g of groups) o[g] = 0;
        return o;
      };

      const byBand = new Map();
      for (const q of qs) {
        const b = q.band || '—';
        if (!byBand.has(b)) byBand.set(b, blank());
        const e = byBand.get(b);
        e[modeGroup(q.mode)] = (e[modeGroup(q.mode)] || 0) + 1;
        e.q += 1;
        e.pts += Number(q.points) || 0;
      }

      const tot = blank();
      const rows = [...byBand.entries()]
        .sort((a, b) => bandSortKey(a[0]) - bandSortKey(b[0]))
        .map(([b, e]) => {
          for (const g of groups) tot[g] += e[g] || 0;
          tot.q += e.q;
          tot.pts += e.pts;
          return { key: b, band: bandLabel(b), ...e, ppq: e.q ? (e.pts / e.q).toFixed(2) : '0' };
        });

      return {
        title: 'Station Summary — QSOs by Band & Mode',
        columns,
        rows,
        totalRow: { band: 'Total', ...tot, ppq: tot.q ? (tot.pts / tot.q).toFixed(2) : '0' },
      };
    },

    get leaderboardCard() {
      const ops = this.operators;
      if (ops.length === 0) return null;

      const columns = [
        { key: 'op', label: 'Operator' },
        { key: 'q', label: 'Q', num: true },
        { key: 'pts', label: 'Pts', num: true },
        { key: 'mults', label: 'Mult', num: true },
        { key: 'runpct', label: 'Run %', num: true },
        { key: 'best60', label: 'Best 60′', num: true },
        { key: 'bands', label: 'Bands', num: true },
        { key: 'dxcc', label: 'DXCC', num: true },
        { key: 'ppq', label: 'Pts/Q', num: true },
      ];

      const rows = ops.map((op) => {
        const r = this.qsos.filter((q) => (q.operator || '—') === op);
        const times = sortedTimes(r);
        const pts = sum(r, (q) => Number(q.points) || 0);
        const runN = sum(r, (q) => (q.is_run_qso ? 1 : 0));
        return {
          key: op,
          op,
          q: r.length,
          pts,
          mults: sum(r, multCount),
          runpct: r.length ? Math.round((runN / r.length) * 100) : 0,
          best60: bestWindow(times, 3600000).count,
          bands: distinct(r, (q) => q.band),
          dxcc: distinct(r, (q) => q.countryprefix),
          ppq: r.length ? (pts / r.length).toFixed(2) : '0',
        };
      }).sort((a, b) => b.q - a.q);

      const t = rows.reduce(
        (a, r) => ({ q: a.q + r.q, pts: a.pts + r.pts, mults: a.mults + r.mults }),
        { q: 0, pts: 0, mults: 0 },
      );

      return {
        title: 'Operator Leaderboard',
        note: this.selectedOp !== 'ALL'
          ? 'Always shows every operator, regardless of the filter above.'
          : '',
        columns,
        rows,
        totalRow: {
          op: 'Total', q: t.q, pts: t.pts, mults: t.mults,
          runpct: '', best60: '', bands: '', dxcc: '',
          ppq: t.q ? (t.pts / t.q).toFixed(2) : '0',
        },
      };
    },

    get hourly() {
      const qs = this.scopedQsos;

      const columns = [
        { key: 'hour', label: 'Hour (UTC)' },
        { key: 'q', label: 'Q', num: true },
        { key: 'cq', label: 'Cum Q', num: true },
        { key: 'pts', label: 'Pts', num: true },
        { key: 'cpts', label: 'Cum Pts', num: true },
        { key: 'mults', label: 'Mult', num: true },
        { key: 'cmults', label: 'Cum M', num: true },
      ];

      const buckets = new Map(); // hour index (epoch hours) -> {q, pts, mults}
      for (const q of qs) {
        const t = qsoTime(q);
        if (Number.isNaN(t)) continue;
        const h = Math.floor(t / 3600000);
        const e = buckets.get(h) || { q: 0, pts: 0, mults: 0 };
        e.q += 1;
        e.pts += Number(q.points) || 0;
        e.mults += multCount(q);
        buckets.set(h, e);
      }

      if (buckets.size === 0) {
        return { title: 'Hourly Breakdown', columns, rows: [], totalRow: null, barKey: 'q' };
      }

      const hs = [...buckets.keys()].sort((a, b) => a - b);
      const first = hs[0];
      const last = hs[hs.length - 1];
      const multiDay = last - first >= 24;
      const maxQ = Math.max(...[...buckets.values()].map((e) => e.q));

      let cq = 0;
      let cpts = 0;
      let cmults = 0;
      const rows = [];
      for (let h = first; h <= last; h++) {
        const e = buckets.get(h) || { q: 0, pts: 0, mults: 0 };
        cq += e.q;
        cpts += e.pts;
        cmults += e.mults;
        rows.push({
          key: String(h),
          hour: fmtHour(h * 3600000, multiDay),
          _q: e.q,
          _bar: maxQ ? Math.round((e.q / maxQ) * 100) : 0,
          _cls: e.q === maxQ && e.q > 0 ? 'is-best' : '',
          q: e.q, cq, pts: e.pts, cpts, mults: e.mults, cmults,
        });
      }

      const tot = [...buckets.values()].reduce(
        (a, e) => ({ q: a.q + e.q, pts: a.pts + e.pts, mults: a.mults + e.mults }),
        { q: 0, pts: 0, mults: 0 },
      );

      return {
        title: 'Hourly Breakdown',
        columns,
        rows,
        barKey: 'q',
        totalRow: { hour: 'Total', q: tot.q, cq: '', pts: tot.pts, cpts: '', mults: tot.mults, cmults: '' },
      };
    },

    get runSpCard() {
      const qs = this.scopedQsos;
      const columns = [
        { key: 'band', label: 'Band' },
        { key: 'run', label: 'Run Q', num: true },
        { key: 'sp', label: 'S&P Q', num: true },
        { key: 'runpct', label: 'Run %', num: true },
      ];

      const byBand = new Map();
      let anyRun = false;
      for (const q of qs) {
        const b = q.band || '—';
        const e = byBand.get(b) || { run: 0, sp: 0 };
        if (q.is_run_qso) { e.run += 1; anyRun = true; } else { e.sp += 1; }
        byBand.set(b, e);
      }

      const rows = [...byBand.entries()]
        .sort((a, b) => bandSortKey(a[0]) - bandSortKey(b[0]))
        .map(([b, e]) => ({
          key: b, band: bandLabel(b), run: e.run, sp: e.sp,
          runpct: e.run + e.sp ? Math.round((e.run / (e.run + e.sp)) * 100) : 0,
        }));

      const t = rows.reduce((a, r) => ({ run: a.run + r.run, sp: a.sp + r.sp }), { run: 0, sp: 0 });

      return {
        title: 'Run vs. Search & Pounce',
        note: anyRun ? '' : 'No Run QSOs flagged in the log — an all-S&P effort, or the logger didn’t send IsRunQSO.',
        columns,
        rows,
        totalRow: {
          band: 'Total', run: t.run, sp: t.sp,
          runpct: t.run + t.sp ? Math.round((t.run / (t.run + t.sp)) * 100) : 0,
        },
      };
    },

    get multBandsCard() {
      const qs = this.scopedQsos;
      const has2 = qs.some((q) => q.is_mult2);
      const has3 = qs.some((q) => q.is_mult3);

      const columns = [{ key: 'band', label: 'Band' }, { key: 'm1', label: 'Mult 1', num: true }];
      if (has2) columns.push({ key: 'm2', label: 'Mult 2', num: true });
      if (has3) columns.push({ key: 'm3', label: 'Mult 3', num: true });
      columns.push({ key: 'mtot', label: 'Total', num: true });
      columns.push({ key: 'q', label: 'Q', num: true });
      columns.push({ key: 'qpm', label: 'Q / Mult', num: true });

      const byBand = new Map();
      for (const q of qs) {
        const b = q.band || '—';
        const e = byBand.get(b) || { m1: 0, m2: 0, m3: 0, q: 0 };
        e.m1 += q.is_mult1 ? 1 : 0;
        e.m2 += q.is_mult2 ? 1 : 0;
        e.m3 += q.is_mult3 ? 1 : 0;
        e.q += 1;
        byBand.set(b, e);
      }

      const rows = [...byBand.entries()]
        .sort((a, b) => bandSortKey(a[0]) - bandSortKey(b[0]))
        .map(([b, e]) => {
          const mtot = e.m1 + e.m2 + e.m3;
          return {
            key: b, band: bandLabel(b), m1: e.m1, m2: e.m2, m3: e.m3, mtot, q: e.q,
            qpm: mtot ? (e.q / mtot).toFixed(1) : '—',
          };
        });

      const t = rows.reduce(
        (a, r) => ({ m1: a.m1 + r.m1, m2: a.m2 + r.m2, m3: a.m3 + r.m3, mtot: a.mtot + r.mtot, q: a.q + r.q }),
        { m1: 0, m2: 0, m3: 0, mtot: 0, q: 0 },
      );

      return {
        title: 'Multipliers by Band',
        note: 'N1MM per-QSO multiplier flags (is_mult1/2/3); which multiplier type each column is depends on the contest.',
        columns,
        rows,
        totalRow: {
          band: 'Total', m1: t.m1, m2: t.m2, m3: t.m3, mtot: t.mtot, q: t.q,
          qpm: t.mtot ? (t.q / t.mtot).toFixed(1) : '—',
        },
      };
    },

    get continentCard() {
      const qs = this.scopedQsos;
      const bands = [...new Set(qs.map((q) => q.band).filter(Boolean))]
        .sort((a, b) => bandSortKey(a) - bandSortKey(b));

      const columns = [{ key: 'cont', label: 'Continent' }];
      for (const b of bands) columns.push({ key: `b_${b}`, label: bandLabel(b), num: true });
      columns.push({ key: 'q', label: 'Total', num: true });
      columns.push({ key: 'pct', label: '%', num: true });

      const byCont = new Map();
      for (const q of qs) {
        const c = (q.continent || '—').toUpperCase();
        const e = byCont.get(c) || { q: 0 };
        if (q.band) e[`b_${q.band}`] = (e[`b_${q.band}`] || 0) + 1;
        e.q += 1;
        byCont.set(c, e);
      }

      const total = qs.length;
      const rows = [...byCont.entries()]
        .sort((a, b) => b[1].q - a[1].q)
        .map(([c, e]) => {
          const row = { key: c, cont: c, q: e.q, pct: total ? Math.round((e.q / total) * 100) : 0 };
          for (const b of bands) row[`b_${b}`] = e[`b_${b}`] || 0;
          return row;
        });

      const tr = { cont: 'Total', q: sum(rows, (r) => r.q), pct: 100 };
      for (const b of bands) tr[`b_${b}`] = sum(rows, (r) => r[`b_${b}`] || 0);

      return { title: 'QSOs by Continent & Band', columns, rows, totalRow: tr };
    },

    get dxccCard() {
      const qs = this.scopedQsos;
      const by = new Map();
      for (const q of qs) {
        const p = q.countryprefix;
        if (!p) continue;
        const e = by.get(p) || { q: 0, mults: 0, bands: new Set() };
        e.q += 1;
        e.mults += multCount(q);
        if (q.band) e.bands.add(q.band);
        by.set(p, e);
      }
      if (by.size === 0) return null;

      const rows = [...by.entries()]
        .sort((a, b) => b[1].q - a[1].q)
        .slice(0, 25)
        .map(([p, e]) => ({ key: p, p, q: e.q, bands: e.bands.size, mults: e.mults, _bar: 0 }));

      const maxQ = rows.length ? rows[0].q : 0;
      for (const r of rows) r._bar = maxQ ? Math.round((r.q / maxQ) * 100) : 0;

      return {
        title: `Top DXCC Entities — ${by.size} worked`,
        note: rows.length < by.size ? `Showing the top ${rows.length} by QSO count.` : '',
        columns: [
          { key: 'p', label: 'DXCC' },
          { key: 'q', label: 'Q', num: true },
          { key: 'bands', label: 'Bands', num: true },
          { key: 'mults', label: 'Mults', num: true },
        ],
        rows,
        barKey: 'q',
        totalRow: null,
      };
    },

    get pointsDistCard() {
      const qs = this.scopedQsos;
      const by = new Map();
      for (const q of qs) {
        const p = Number(q.points) || 0;
        by.set(p, (by.get(p) || 0) + 1);
      }
      if (by.size === 0) return null;

      const total = qs.length;
      const rows = [...by.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([p, n]) => ({
          key: String(p), p, n,
          pct: total ? Math.round((n / total) * 100) : 0,
          sub: p * n,
          _bar: total ? Math.round((n / total) * 100) : 0,
        }));

      return {
        title: 'Points-per-QSO Distribution',
        columns: [
          { key: 'p', label: 'Points / QSO' },
          { key: 'n', label: 'QSOs', num: true },
          { key: 'pct', label: '%', num: true },
          { key: 'sub', label: 'Subtotal', num: true },
        ],
        rows,
        barKey: 'n',
        totalRow: { p: 'Total', n: total, pct: 100, sub: sum(qs, (q) => Number(q.points) || 0) },
      };
    },

    get callLenCard() {
      const qs = this.scopedQsos;
      const by = new Map();
      for (const q of qs) {
        const L = (q.call || '').length;
        if (!L) continue;
        const bucket = L >= 10 ? '10+' : String(L);
        by.set(bucket, (by.get(bucket) || 0) + 1);
      }
      if (by.size === 0) return null;

      const order = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+'];
      const total = [...by.values()].reduce((a, b) => a + b, 0);
      const rows = order.filter((k) => by.has(k)).map((k) => ({
        key: k, len: k, n: by.get(k),
        pct: total ? Math.round((by.get(k) / total) * 100) : 0,
        _bar: total ? Math.round((by.get(k) / total) * 100) : 0,
      }));

      const avg = qs.length
        ? (sum(qs, (q) => (q.call || '').length) / qs.length).toFixed(1)
        : '0';

      return {
        title: `Callsign Length Distribution — avg ${avg} chars`,
        columns: [
          { key: 'len', label: 'Call length' },
          { key: 'n', label: 'QSOs', num: true },
          { key: 'pct', label: '%', num: true },
        ],
        rows,
        barKey: 'n',
        totalRow: { len: 'Total', n: total, pct: 100 },
      };
    },

    // ================================================================
    // Chip cards -- zones and sections/exchanges worked
    // ================================================================
    get chipCards() {
      if (!this.hasData) return [];
      const qs = this.scopedQsos;
      const cards = [];

      const zones = new Map();
      for (const q of qs) {
        const z = q.zone;
        if (z && z !== '0') zones.set(z, (zones.get(z) || 0) + 1);
      }
      if (zones.size) {
        cards.push({
          key: 'zones',
          title: `CQ Zones Worked — ${zones.size}`,
          items: [...zones.entries()]
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([z, n]) => ({ key: z, label: z, n })),
        });
      }

      const sections = new Map();
      for (const q of qs) {
        const s = (q.section || '').trim();
        if (s) sections.set(s, (sections.get(s) || 0) + 1);
      }
      if (sections.size) {
        cards.push({
          key: 'sections',
          title: `Sections / Exchanges Worked — ${sections.size}`,
          items: [...sections.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([s, n]) => ({ key: s, label: s, n })),
        });
      }

      return cards;
    },

    // ================================================================
    // Duplicates -- same call on the same band + mode group more than once
    // ================================================================
    get dupes() {
      const seen = new Map();
      for (const q of this.scopedQsos) {
        const k = `${(q.call || '').toUpperCase()}|${q.band || ''}|${modeGroup(q.mode)}`;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      return [...seen.entries()]
        .filter(([, n]) => n > 1)
        .map(([k, n]) => {
          const [call, band] = k.split('|');
          return { key: k, call, band: bandLabel(band), n };
        })
        .sort((a, b) => b.n - a.n);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (module scope -- not on the Alpine object)
// ---------------------------------------------------------------------------

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

// The mode-group columns to show for a set of QSOs, in canonical contest
// order (CW, phone, digital), limited to the groups actually worked.
function presentModeGroups(qs) {
  const present = new Set(qs.map((q) => modeGroup(q.mode)));
  const ordered = MODE_GROUP_ORDER.filter((g) => present.has(g));
  const extra = [...present].filter((g) => !ordered.includes(g)).sort();
  return [...ordered, ...extra];
}

function multCount(q) {
  return (q.is_mult1 ? 1 : 0) + (q.is_mult2 ? 1 : 0) + (q.is_mult3 ? 1 : 0);
}

function sum(arr, fn) {
  let s = 0;
  for (const x of arr) s += fn(x) || 0;
  return s;
}

function distinct(arr, fn) {
  const s = new Set();
  for (const x of arr) {
    const v = fn(x);
    if (v) s.add(v);
  }
  return s.size;
}

// Prefer N1MM's own logged QSO time for post-hoc analysis (what SH5 / CBS
// work from); fall back to our ingestion time. Both are UTC
// "YYYY-MM-DD HH:MM:SS". This deliberately differs from charts.js and the
// live rate meter, which stick to logged_at to stay immune to logging-PC
// clock skew -- for a rate that refreshes every few seconds that matters
// more than absolute accuracy, but for a static "what happened each hour"
// breakdown the real QSO timestamp is the right axis.
function qsoTime(q) {
  const raw = q.n1mm_timestamp || q.logged_at;
  if (!raw) return NaN;
  const t = new Date(raw.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(t) ? NaN : t;
}

function sortedTimes(qs) {
  return qs.map(qsoTime).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
}

// Largest number of entries of `times` (sorted ascending, ms) that fall
// within any window of `windowMs`. Amortized O(n) two-pointer sweep.
function bestWindow(times, windowMs) {
  if (!times.length) return { count: 0, start: NaN };
  let best = 0;
  let bestStart = times[0];
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    if (j < i) j = i;
    while (j + 1 < times.length && times[j + 1] - times[i] < windowMs) j += 1;
    if (j - i + 1 > best) { best = j - i + 1; bestStart = times[i]; }
  }
  return { count: best, start: bestStart };
}

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtDur(ms) {
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  return h ? `${h}h ${pad2(mins % 60)}m` : `${mins}m`;
}

function fmtStamp(ms) {
  if (Number.isNaN(ms)) return '—';
  const d = new Date(ms);
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}z`;
}

function fmtHour(ms, withDate) {
  const d = new Date(ms);
  return withDate
    ? `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}z`
    : `${pad2(d.getUTCHours())}:00z`;
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
