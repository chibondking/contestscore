const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const CC = require('../../public/js/conditions');

const H = 3600000;
const at = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();
const reading = (fetched_at, o = {}) => ({ sfi: 120, a_index: 5, k_index: 1, sunspots: 100, fetched_at, ...o });
const qso = (ts, o = {}) => ({ call: 'DL1ABC', band: '14', continent: 'EU', points: 1, t: at(ts), ...o });
const timeFn = (q) => q.t;

describe('normalize', () => {
  it('sorts oldest first, parses the UTC stamp, and maps the index names', () => {
    const r = CC.normalize([
      reading('2026-11-14 14:00:00', { k_index: 3 }),
      reading('2026-11-14 12:00:00', { k_index: 0 }),
    ]);
    assert.deepEqual(r.map((x) => x.k), [0, 3]);
    assert.equal(r[0].t, at('2026-11-14 12:00:00'));
    assert.deepEqual(Object.keys(r[0]).sort(), ['a', 'k', 'sfi', 'sunspots', 't']);
  });

  it('drops rows with no usable time and treats SFI 0 / blanks as missing', () => {
    const r = CC.normalize([
      reading('garbage'),
      reading('2026-11-14 12:00:00', { sfi: 0, a_index: '', k_index: null }),
      null,
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].sfi, null);
    assert.equal(r[0].a, null);
    assert.equal(r[0].k, null);
  });

  it('is idempotent, so already-normalized readings can be passed again', () => {
    const once = CC.normalize([reading('2026-11-14 12:00:00', { k_index: 4 })]);
    assert.deepEqual(CC.normalize(once), once);
  });

  it('accepts nothing at all', () => {
    assert.deepEqual(CC.normalize(undefined), []);
    assert.deepEqual(CC.normalize([]), []);
  });
});

describe('readingAt / readingForHour', () => {
  const rs = CC.normalize([
    reading('2026-11-14 12:10:00', { k_index: 1 }),
    reading('2026-11-14 14:10:00', { k_index: 4 }),
  ]);

  it('returns the newest reading at or before the moment', () => {
    assert.equal(CC.readingAt(rs, at('2026-11-14 12:10:00')).k, 1);
    assert.equal(CC.readingAt(rs, at('2026-11-14 14:09:59')).k, 1);
    assert.equal(CC.readingAt(rs, at('2026-11-14 14:10:00')).k, 4);
  });

  it('returns null before the first reading and once the newest is over 6h old', () => {
    assert.equal(CC.readingAt(rs, at('2026-11-14 12:09:59')), null);
    assert.equal(CC.readingAt(rs, at('2026-11-14 20:10:00')).k, 4);
    assert.equal(CC.readingAt(rs, at('2026-11-14 20:10:01')), null);
  });

  it('an hour takes the newest reading known by its end', () => {
    const hour = (s) => Math.floor(at(s) / H);
    assert.equal(CC.readingForHour(rs, hour('2026-11-14 11:00:00')), null);
    assert.equal(CC.readingForHour(rs, hour('2026-11-14 12:00:00')).k, 1); // arrived at :10
    assert.equal(CC.readingForHour(rs, hour('2026-11-14 13:00:00')).k, 1);
    assert.equal(CC.readingForHour(rs, hour('2026-11-14 14:00:00')).k, 4);
  });
});

describe('kLevel / aLevel', () => {
  it('uses NOAA wording, matching the Solar page', () => {
    assert.deepEqual([0, 3, 4, 5, 7, 9].map(CC.kLevel), ['quiet', 'quiet', 'active', 'G1 storm', 'G3 storm', 'G5 storm']);
    assert.deepEqual([4, 8, 20, 30, 60, 150].map(CC.aLevel), ['quiet', 'unsettled', 'active', 'minor storm', 'major storm', 'severe storm']);
    assert.equal(CC.kLevel(null), '');
    assert.equal(CC.aLevel(''), '');
  });
});

describe('summary', () => {
  const rs = CC.normalize([
    reading('2026-11-14 06:00:00', { sfi: 110, k_index: 6 }), // long before: not part of the session
    reading('2026-11-14 11:00:00', { sfi: 119, k_index: 1, a_index: 4 }), // in effect at the start
    reading('2026-11-14 14:00:00', { sfi: 124, k_index: 3, a_index: 9 }),
    reading('2026-11-14 23:00:00', { sfi: 140, k_index: 8 }), // after the session
  ]);

  it('covers the reading in effect at the start plus those during the session', () => {
    const s = CC.summary(rs, at('2026-11-14 12:00:00'), at('2026-11-14 18:00:00'));
    assert.equal(s.count, 2);
    assert.deepEqual(s.sfi, { min: 119, max: 124 });
    assert.deepEqual(s.k, { min: 1, max: 3 });
    assert.deepEqual(s.a, { min: 4, max: 9 });
    assert.equal(s.latest.k, 3);
  });

  it('is null when nothing applies', () => {
    assert.equal(CC.summary(rs, at('2026-11-10 12:00:00'), at('2026-11-10 18:00:00')), null);
    assert.equal(CC.summary([], 0, 1), null);
    assert.equal(CC.summary(rs, NaN, NaN), null);
  });

  it('formats a range as one number when it never moved', () => {
    assert.equal(CC.fmtRange({ min: 4, max: 4 }), '4');
    assert.equal(CC.fmtRange({ min: 119, max: 124 }), '119–124');
    assert.equal(CC.fmtRange(null), '—');
  });
});

describe('rateByK', () => {
  const rs = CC.normalize([
    reading('2026-11-14 11:30:00', { k_index: 1 }),
    reading('2026-11-14 14:30:00', { k_index: 4 }),
  ]);
  // 12z: 4 Q (K1) | 13z: 2 Q (K1) | 14z: 3 Q (K4, reading lands at :30) | 15z: off | 16z: 1 Q (K4)
  const qsos = [
    qso('2026-11-14 12:01:00'), qso('2026-11-14 12:10:00'), qso('2026-11-14 12:20:00'),
    qso('2026-11-14 12:50:00', { continent: 'NA' }),
    qso('2026-11-14 13:05:00'), qso('2026-11-14 13:40:00', { points: 3 }),
    qso('2026-11-14 14:05:00', { continent: 'NA' }), qso('2026-11-14 14:15:00', { continent: 'NA' }),
    qso('2026-11-14 14:45:00'),
    qso('2026-11-14 16:10:00', { continent: 'NA' }),
    { call: 'NOTIME', t: NaN },
  ];
  const byK = CC.rateByK(qsos, rs, { timeFn, pointsFn: (q) => q.points || 0, keyFn: (q) => q.continent });

  it('groups active hours by the K in effect, and rates are per active hour', () => {
    assert.deepEqual(byK.rows.map((r) => [r.k, r.level, r.hours, r.q, r.qph]), [
      [1, 'quiet', 2, 6, 3],
      [4, 'active', 2, 4, 2], // the idle 15z hour is not counted
    ]);
    assert.deepEqual(byK.total, { hours: 4, q: 10, pts: 12, qph: 2.5, pph: 3 });
  });

  it('carries points and the per-key breakdown', () => {
    assert.equal(byK.rows[0].pts, 8);
    assert.equal(byK.rows[0].pph, 4);
    assert.deepEqual(byK.rows[0].byKey, { EU: 5, NA: 1 });
    assert.deepEqual(byK.rows[1].byKey, { NA: 3, EU: 1 });
    assert.deepEqual(byK.keys, ['EU', 'NA']); // busiest first
  });

  it('counts hours at or above a K threshold', () => {
    assert.deepEqual(CC.disturbedHours(byK), { hours: 2, of: 4 });
    assert.deepEqual(CC.disturbedHours(byK, 5), { hours: 0, of: 4 });
  });

  it('leaves hours with no reading out of the rows and reports them', () => {
    const early = CC.rateByK([qso('2026-11-14 09:00:00'), ...qsos], rs, { timeFn });
    assert.equal(early.unknownHours, 1);
    assert.equal(early.unknownQ, 1);
    assert.equal(early.total.q, 10);
  });

  it('returns no rows when there are no readings', () => {
    const none = CC.rateByK(qsos, [], { timeFn });
    assert.deepEqual(none.rows, []);
    assert.equal(none.unknownHours, 4);
    assert.equal(none.total.qph, 0);
  });
});

describe('forSavedLog', () => {
  it('uses the readings a from-live snapshot was saved with, without fetching', async () => {
    const solar = [reading('2026-11-14 12:00:00')];
    const got = await CC.forSavedLog({ solar, qsos: [] }, timeFn);
    assert.equal(got, solar);
  });

  it('looks the log\'s own time span up when it carries none', async () => {
    const realFetch = global.fetch;
    let asked = null;
    global.fetch = async (url) => { asked = url; return { ok: true, json: async () => [reading('2026-11-14 12:00:00')] }; };
    try {
      const got = await CC.forSavedLog({ qsos: [qso('2026-11-14 13:00:00'), qso('2026-11-14 12:00:00')] }, timeFn);
      assert.equal(got.length, 1);
      assert.equal(asked, `/api/solar/history?from=${encodeURIComponent('2026-11-14 12:00:00')}&to=${encodeURIComponent('2026-11-14 13:00:00')}`);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('returns [] when the lookup fails or the log has no times', async () => {
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('offline'); };
    try {
      assert.deepEqual(await CC.forSavedLog({ qsos: [qso('2026-11-14 12:00:00')] }, timeFn), []);
      assert.deepEqual(await CC.forSavedLog({ qsos: [] }, timeFn), []);
      assert.deepEqual(await CC.forSavedLog(null, timeFn), []);
    } finally {
      global.fetch = realFetch;
    }
  });
});
