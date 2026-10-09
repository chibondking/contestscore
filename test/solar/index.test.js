const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createSolarService, parseSolarXml, resolveSolarConfig } = require('../../src/solar');

const XML = `<?xml version="1.0"?>
<solar>
<solardata>
<source url="http://www.hamqsl.com/solar.html">N0NBH</source>
<updated>10 Sep 2026 1836 GMT</updated>
<solarflux>109</solarflux>
<aindex>12</aindex>
<kindex>1</kindex>
<sunspots>90</sunspots>
<xray>B9.6</xray>
<geomagfield>VR QUIET</geomagfield>
</solardata>
</solar>`;

const ROW = {
  sfi: 109, a_index: 12, k_index: 1, sunspots: 90,
  xray: 'B9.6', geomag: 'VR QUIET', fetched_at: '2026-09-10 18:40:00',
};

const okFetch = (body = XML) => async () => ({ ok: true, status: 200, text: async () => body });

describe('parseSolarXml', () => {
  it('pulls SFI / A / K / sunspots + context out of the hamqsl feed', async () => {
    assert.deepEqual(await parseSolarXml(XML), {
      sfi: 109, a: 12, k: 1, sunspots: 90,
      xray: 'B9.6', geomag: 'VR QUIET', source_updated: '10 Sep 2026 1836 GMT',
    });
  });

  it('nulls a missing / non-numeric index rather than NaN', async () => {
    const r = await parseSolarXml('<solar><solardata><solarflux>abc</solarflux><kindex>3</kindex></solardata></solar>');
    assert.equal(r.sfi, null);
    assert.equal(r.k, 3);
    assert.equal(r.a, null);
  });

  it('throws on a response with no <solardata>', async () => {
    await assert.rejects(() => parseSolarXml('<html>down for maintenance</html>'), /unrecognised/);
  });
});

describe('resolveSolarConfig', () => {
  it('defaults to enabled, 120 min, 1826 days (5 years)', () => {
    assert.deepEqual(resolveSolarConfig({}, { solar: {} }), {
      enabled: true, refreshMs: 120 * 60000, hamdataUrl: '',
    });
  });

  it('SOLAR_ENABLED=false disables it', () => {
    assert.equal(resolveSolarConfig({ SOLAR_ENABLED: 'false' }, { solar: {} }).enabled, false);
  });

  it('env overrides the interval and retention', () => {
    const r = resolveSolarConfig({ SOLAR_REFRESH_MINUTES: '5' }, { solar: {} });
    assert.equal(r.refreshMs, 5 * 60000);
  });
});

describe('createSolarService', () => {
  function harness(overrides = {}) {
    const inserts = [];
    const emits = [];
    let stored = overrides.seed || null;
    const svc = createSolarService({
      io: { emit: (ev, data) => emits.push({ ev, data }) },
      env: overrides.env || {},
      deps: {
        fetchImpl: overrides.fetchImpl || okFetch(),
        insertSolarSnapshot: (r) => { inserts.push(r); stored = { ...ROW }; },
        getLatestSolar: () => stored,
      },
    });
    return { svc, inserts, emits, current: () => stored };
  }

  it('fetches, persists, and emits solar:update', async () => {
    const h = harness();
    await h.svc.refresh();

    assert.equal(h.inserts.length, 1);
    assert.deepEqual(h.inserts[0], {
      sfi: 109, a: 12, k: 1, sunspots: 90, xray: 'B9.6', geomag: 'VR QUIET',
      source_updated: '10 Sep 2026 1836 GMT',
    });
    assert.equal(h.emits.length, 1);
    assert.equal(h.emits[0].ev, 'solar:update');
    assert.deepEqual(h.emits[0].data, {
      sfi: 109, a: 12, k: 1, sunspots: 90, xray: 'B9.6', geomag: 'VR QUIET',
      updated: '2026-09-10 18:40:00',
    });
    assert.equal(h.svc.getCurrent().sfi, 109);
  });

  it('keeps the last good reading when a fetch fails', async () => {
    const h = harness({ seed: ROW, fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }) });
    const before = h.svc.getCurrent();
    const result = await h.svc.refresh();

    assert.equal(result, null);
    assert.equal(h.inserts.length, 0);
    assert.equal(h.emits.length, 0);
    assert.deepEqual(h.svc.getCurrent(), before);
  });

  it('is a no-op when disabled', async () => {
    let fetched = false;
    const h = harness({ env: { SOLAR_ENABLED: 'false' }, fetchImpl: async () => { fetched = true; return okFetch()(); } });
    assert.equal(h.svc.enabled, false);
    await h.svc.refresh();
    assert.equal(fetched, false);
    assert.equal(h.inserts.length, 0);
  });

  it('getCurrent() is { updated: null } before any reading', () => {
    const h = harness();
    assert.deepEqual(h.svc.getCurrent(), { updated: null });
  });
});

describe('createSolarService in hamdata mode', () => {
  const HROW = (sfi, fetched_at) => ({
    sfi, a_index: 5, k_index: 1, sunspots: 40, xray: 'B1', geomag: 'QUIET', source_updated: 'x', fetched_at,
  });

  function harness(pages) {
    const table = [];
    const emits = [];
    const asked = [];
    const svc = createSolarService({
      io: { emit: (ev, data) => emits.push({ ev, data }) },
      env: { HAMDATA_URL: 'http://127.0.0.1:3100' },
      deps: {
        hamdataClient: { solarSince: async (after) => { asked.push(after); return pages.shift() || []; } },
        insertSolarSnapshot: (r) => table.push({ sfi: r.sfi, a_index: r.a, fetched_at: r.fetched_at }),
        getLatestSolar: () => table[table.length - 1] || null,
        fetchImpl: async () => { throw new Error('must not hit hamqsl in hamdata mode'); },
      },
    });
    return { svc, table, emits, asked };
  }

  it('copies new rows with hamdata\'s fetched_at and emits once', async () => {
    const h = harness([[HROW(100, '2026-10-01 00:00:00'), HROW(110, '2026-10-01 02:00:00')]]);
    assert.equal(h.svc.source, 'hamdata');
    await h.svc.refresh();
    assert.deepEqual(h.table.map((r) => [r.sfi, r.a_index, r.fetched_at]), [
      [100, 5, '2026-10-01 00:00:00'], [110, 5, '2026-10-01 02:00:00'],
    ]);
    assert.deepEqual(h.asked, ['']); // a short page is the last one
    assert.equal(h.emits.length, 1);
    assert.equal(h.emits[0].data.sfi, 110);
  });

  it('asks only for rows after its newest one and emits nothing when there are none', async () => {
    const h = harness([[HROW(100, '2026-10-01 00:00:00')], [], []]);
    await h.svc.refresh();
    await h.svc.refresh();
    assert.equal(h.asked.at(-1), '2026-10-01 00:00:00');
    assert.equal(h.emits.length, 1);
  });

  it('pages through a long history on a cold start', async () => {
    const big = Array.from({ length: 1000 }, (_, i) => HROW(i, `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`));
    const h = harness([big, [HROW(5000, '2026-10-01 00:00:00')]]);
    await h.svc.refresh();
    assert.equal(h.table.length, 1001);
    assert.equal(h.asked.length, 2);
  });

  it('keeps the last reading when hamdata is unreachable', async () => {
    const svc = createSolarService({
      io: null,
      env: { HAMDATA_URL: 'http://127.0.0.1:3100' },
      deps: {
        hamdataClient: { solarSince: async () => { throw new Error('ECONNREFUSED'); } },
        insertSolarSnapshot: () => { throw new Error('no'); },
        getLatestSolar: () => ROW,
      },
    });
    assert.equal(await svc.refresh(), null);
    assert.equal(svc.getCurrent().sfi, 109);
  });
});
