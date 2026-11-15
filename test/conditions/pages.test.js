// The Stats and Charts pages' use of conditions.js. Both are plain classic
// scripts (no module.exports for their page objects), so load them the way
// a browser does -- conditions.js first, as stats.html / charts.html do --
// and drive the page object directly. Nothing here touches the DOM, the
// network or Chart.js: only the getters/builders that turn data into rows
// and chart configs.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function page(...files) {
  const sandbox = vm.createContext({
    console,
    document: { documentElement: { getAttribute: () => null } },
  });
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js', f), 'utf8'), sandbox);
  }
  return (code) => vm.runInContext(code, sandbox);
}

const reading = (fetched_at, k, o = {}) => ({ sfi: 120, a_index: 5, k_index: k, sunspots: 100, fetched_at, ...o });
const qso = (ts, o = {}) => ({
  call: `K${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
  band: '14', mode: 'CW', operator: 'WT2P', continent: 'EU', countryprefix: 'DL',
  points: 1, is_mult1: 0, is_mult2: 0, is_mult3: 0,
  n1mm_timestamp: ts, logged_at: ts, ...o,
});

// 12z: 3 Q at K1 | 13z: nothing | 14z: 2 Q at K4 (one on 21 MHz from NA)
const QSOS = [
  qso('2026-11-14 12:05:00'), qso('2026-11-14 12:15:00'), qso('2026-11-14 12:45:00'),
  qso('2026-11-14 14:35:00'), qso('2026-11-14 14:50:00', { band: '21', continent: 'NA' }),
];
const SOLAR = [
  reading('2026-11-14 11:30:00', 1, { sfi: 119, a_index: 4 }),
  reading('2026-11-14 14:20:00', 4, { sfi: 124, a_index: 18 }),
];

describe('Stats page conditions', () => {
  const run = page('conditions.js', 'stats.js');
  run('var S = stats();');
  const load = (qsos, solar, logId = null) => {
    run(`S.qsos = ${JSON.stringify(qsos)}; S.solar = ContestConditions.normalize(${JSON.stringify(solar)}); S.logId = ${JSON.stringify(logId)}; S.selectedOp = 'ALL';`);
  };
  const get = (expr) => JSON.parse(run(`JSON.stringify(${expr})`) || 'null');

  it('shows nothing about conditions when no readings cover the log', () => {
    load(QSOS, []);
    assert.deepEqual(get('S.conditions'), []);
    assert.equal(get('S.kRateContinentCard'), null);
    assert.equal(get('S.kRateBandCard'), null);
    assert.equal(get('S.hourly.columns').some((c) => c.key === 'k'), false);
    assert.equal(get('S.matrixCards.map((c) => c.title)').some((t) => /K-index/.test(t)), false);
  });

  it('adds SFI / A / K to each hour of the Hourly Breakdown', () => {
    load(QSOS, SOLAR, 'saved');
    const h = get('S.hourly');
    assert.deepEqual(h.columns.slice(-3).map((c) => c.label), ['SFI', 'A', 'K']);
    assert.deepEqual(h.rows.map((r) => [r.q, r.sfi, r.a, r.k]), [
      [3, 119, 4, 1],
      [0, 119, 4, 1],
      [2, 124, 18, 4],
    ]);
  });

  it('summarises the session in the Conditions card (a saved log has no "Now")', () => {
    load(QSOS, SOLAR, 'saved');
    const rows = Object.fromEntries(get('S.conditions').map((r) => [r.label, r.value]));
    assert.equal('Now' in rows, false);
    assert.equal(rows.SFI, '119–124');
    assert.equal(rows['A-index'], '4–18  (peak: active)');
    assert.equal(rows['K-index'], '1–4  (peak: active)');
    assert.equal(rows['Active hours at K ≥ 4'], '1 of 2');
    assert.equal(rows.Readings, '2');
  });

  it('leads with the current reading when live', () => {
    // Live looks from the first QSO to now, so date the log at "now".
    const iso = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const now = Date.now();
    load([qso(iso(now - 30 * 60000))], [reading(iso(now - 45 * 60000), 2, { sfi: 131, a_index: 7 })]);
    const [first] = get('S.conditions');
    assert.equal(first.label, 'Now');
    assert.match(first.value, /^SFI 131 · A 7 · K 2 \(quiet\) {2}\(as of \d\d\/\d\d \d\d:\d\dz\)$/);
  });

  it('builds Rate by K-index cards broken down by continent and by band', () => {
    load(QSOS, SOLAR, 'saved');
    const c = get('S.kRateContinentCard');
    assert.deepEqual(c.columns.map((x) => x.label), ['K', 'Level', 'Hours', 'Q', 'Q/h', 'Pts/h', 'EU/h', 'NA/h']);
    assert.deepEqual(c.rows.map((r) => [r.k, r.level, r.hours, r.q, r.qph, r.x_EU, r.x_NA]), [
      [1, 'quiet', 1, 3, '3.0', '3.0', '0.0'],
      [4, 'active', 1, 2, '2.0', '1.0', '1.0'],
    ]);
    assert.equal(c.totalRow.qph, '2.5');
    assert.equal(c.barKey, 'qph');
    assert.equal(c.rows[0]._bar, 100);

    const b = get('S.kRateBandCard');
    assert.deepEqual(b.columns.slice(-2).map((x) => x.label), ['20m/h', '15m/h']); // low band first
    assert.deepEqual(get('S.matrixCards.map((c) => c.title)').slice(2, 5), [
      'Hourly Breakdown', 'Rate by K-index — by Continent', 'Rate by K-index — by Band',
    ]);
  });

  it('says so when some active hours had no reading', () => {
    load([qso('2026-11-14 05:00:00'), ...QSOS], SOLAR, 'saved');
    assert.match(get('S.kRateContinentCard').note, /1 active hour \(1 Q\) had no reading/);
  });
});

describe('Charts page', () => {
  const run = page('conditions.js', 'charts.js');
  run('var C = charts();');
  const get = (expr) => JSON.parse(run(`JSON.stringify(${expr})`) || 'null');
  run(`C.qsos = ${JSON.stringify(QSOS)}; C.solar = ContestConditions.normalize(${JSON.stringify(SOLAR)});`);

  it('labels time in UTC, with the date once a chart spans a day', () => {
    assert.equal(run('utcLabel(Date.UTC(2026, 10, 15, 13, 5), false)'), '13:05z');
    assert.equal(run('utcLabel(Date.UTC(2026, 10, 15, 13, 5), true)'), '11/15 13:05z');
  });

  it('fills idle time with a zero rate instead of skipping it', () => {
    const pts = get('C.rateOverTime(60)');
    assert.deepEqual(pts.map((p) => [p.label, p.rate]), [['12:00z', 3], ['13:00z', 0], ['14:00z', 2]]);
  });

  it('offers the Rate vs. K-index chart only when readings cover the log', () => {
    assert.equal(get('C.extraCharts.map((s) => s.id)')[0], 'cx-rate-k');
    run('C.solar = [];');
    assert.equal(get('C.extraCharts.map((s) => s.id)').includes('cx-rate-k'), false);
    assert.equal(run('buildRateVsK(C.qsos, 60, C.solar)'), null);
    run(`C.solar = ContestConditions.normalize(${JSON.stringify(SOLAR)});`);
  });

  it('still drops charts a saved log has no data for', () => {
    run('C.logMeta = { has_points: 0, has_mults: 0, has_run_flag: 0 };');
    const ids = get('C.extraCharts.map((s) => s.id)');
    assert.equal(ids.includes('cx-cum-points'), false);
    assert.equal(ids.includes('cx-rate-k'), true);
    run('C.logMeta = null;');
  });

  it('plots rate as bars and K as a stepped line on its own 0-9 axis', () => {
    run('var cfg = buildRateVsK(C.qsos, 60, C.solar);');
    const d = get('cfg.data');
    assert.deepEqual(d.labels, ['12:00z', '13:00z', '14:00z']);
    const k = d.datasets.find((s) => s.label === 'K-index');
    const rate = d.datasets.find((s) => s.label === 'QSOs/hr');
    assert.deepEqual(k.data, [1, 1, 4]);
    assert.equal(k.stepped, true);
    assert.equal(k.yAxisID, 'yK');
    assert.deepEqual(rate.data, [3, 0, 2]);
    const yK = get('cfg.options.scales.yK');
    assert.equal(yK.min, 0);
    assert.equal(yK.max, 9);
    assert.equal(yK.position, 'right');
    assert.equal(run('cfg.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: 2 }])'), 'SFI 124 · A 18');
  });
});
