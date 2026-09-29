const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  solarSeries, solarDayTicks, kLabel, solarTime, sqlUtc, SOLAR_MEASURES, DAY_MS,
} = require('../../public/js/solar');

const row = (fetched_at, o = {}) => ({ sfi: 100, a_index: 5, k_index: 1, sunspots: 40, fetched_at, ...o });

describe('solarSeries', () => {
  it('turns readings into {x: ms, y} points, oldest first', () => {
    const pts = solarSeries([row('2026-09-29 02:00:00', { sfi: 95 }), row('2026-09-29 00:00:00', { sfi: 97 })], 'sfi');
    assert.deepEqual(pts.map((p) => p.y), [97, 95]);
    assert.equal(pts[0].x, Date.UTC(2026, 8, 29, 0, 0, 0));
  });

  it('breaks the line across an outage instead of bridging it', () => {
    // 2h polls, then a 10h hole, then polls again.
    const pts = solarSeries([
      row('2026-09-28 00:00:00'), row('2026-09-28 02:00:00'),
      row('2026-09-28 12:00:00'), row('2026-09-28 14:00:00'),
    ], 'k_index');
    assert.deepEqual(pts.map((p) => p.y), [1, 1, null, 1, 1]);
    assert.equal(pts[2].x, Date.UTC(2026, 8, 28, 2, 0, 0) + 1); // right after the last reading before the hole
  });

  it('does not break the line for ordinary 2-hour spacing', () => {
    const pts = solarSeries([row('2026-09-28 00:00:00'), row('2026-09-28 02:05:00'), row('2026-09-28 04:02:00')], 'sfi');
    assert.equal(pts.filter((p) => p.y === null).length, 0);
  });

  it('skips readings with no value for that measure, and keeps a real 0', () => {
    const pts = solarSeries([row('2026-09-28 00:00:00', { k_index: null }), row('2026-09-28 02:00:00', { k_index: 0 })], 'k_index');
    assert.deepEqual(pts.map((p) => p.y), [0]);
  });

  it('copes with no data', () => {
    assert.deepEqual(solarSeries([], 'sfi'), []);
    assert.deepEqual(solarSeries(undefined, 'sfi'), []);
  });
});

describe('solarDayTicks', () => {
  it('labels UTC midnights every 5 days, always including the newest day', () => {
    const max = Date.UTC(2026, 8, 29, 20, 16);
    const min = max - 30 * DAY_MS;
    const ticks = solarDayTicks(min, max);
    assert.equal(ticks.at(-1), Date.UTC(2026, 8, 29));
    assert.ok(ticks.every((t) => t >= min && t <= max));
    assert.ok(ticks.every((t, i) => i === 0 || t - ticks[i - 1] === 5 * DAY_MS));
    assert.equal(ticks.length, 6);
  });
});

describe('kLabel', () => {
  it('follows NOAA: below 4 quiet, 4 active, 5-9 storms G1-G5', () => {
    assert.equal(kLabel(0), 'quiet');
    assert.equal(kLabel(3), 'quiet');
    assert.equal(kLabel(4), 'active');
    assert.equal(kLabel(5), 'G1 storm');
    assert.equal(kLabel(7), 'G3 storm');
    assert.equal(kLabel(9), 'G5 storm');
    assert.equal(kLabel(null), '');
  });
});

describe('time helpers and chart set', () => {
  it('round-trips the SQLite UTC format the history API takes', () => {
    const ms = Date.UTC(2026, 8, 29, 20, 16, 35);
    assert.equal(sqlUtc(ms), '2026-09-29 20:16:35');
    assert.equal(solarTime('2026-09-29 20:16:35'), ms);
  });

  it('charts the four stored measures, one per chart', () => {
    assert.deepEqual(SOLAR_MEASURES.map((m) => m.field), ['sfi', 'sunspots', 'a_index', 'k_index']);
    assert.equal(new Set(SOLAR_MEASURES.map((m) => m.color)).size, 4);
  });
});
