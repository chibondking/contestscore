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
  it('defaults to enabled, 120 min, 365 days', () => {
    assert.deepEqual(resolveSolarConfig({}, { solar: {} }), {
      enabled: true, refreshMs: 120 * 60000, retentionDays: 365,
    });
  });

  it('SOLAR_ENABLED=false disables it', () => {
    assert.equal(resolveSolarConfig({ SOLAR_ENABLED: 'false' }, { solar: {} }).enabled, false);
  });

  it('env overrides the interval and retention', () => {
    const r = resolveSolarConfig({ SOLAR_REFRESH_MINUTES: '5', SOLAR_RETENTION_DAYS: '30' }, { solar: {} });
    assert.equal(r.refreshMs, 5 * 60000);
    assert.equal(r.retentionDays, 30);
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
        pruneSolarSnapshots: () => {},
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
