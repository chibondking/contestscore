const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { enrichGeo, resolveCall, _setResolver } = require('../../src/analyze/geo');

describe('enrichGeo (shared by the analyzer and the realtime pipeline)', () => {
  it('fills blank continent / zone / countryprefix from the country file', () => {
    const q = { call: 'DL1XYZ', continent: '', zone: '', countryprefix: '' };
    enrichGeo(q);
    assert.equal(q.continent, 'EU');
    assert.equal(q.zone, '14');
    assert.equal(q.countryprefix, 'DL');
  });

  it('never overrides what the logger already sent', () => {
    const q = { call: 'DL1XYZ', continent: 'XX', zone: '99', countryprefix: 'ZZ' };
    enrichGeo(q);
    assert.deepEqual(q, { call: 'DL1XYZ', continent: 'XX', zone: '99', countryprefix: 'ZZ' });
  });

  it('override: forces the named fields from the country file over a stale packet value', () => {
    // not1mm's contactinfo packet hardcodes continent=NA countryprefix=K on
    // every QSO; the realtime pipeline passes override to correct it.
    const q = { call: 'DL1XYZ', continent: 'NA', zone: '5', countryprefix: 'K' };
    enrichGeo(q, { override: ['continent', 'countryprefix'] });
    assert.equal(q.continent, 'EU');
    assert.equal(q.countryprefix, 'DL');
    assert.equal(q.zone, '5'); // not in the override list -> left as sent
  });

  it('override: keeps the packet value when the lookup produces nothing', () => {
    const q = { call: '12345', continent: 'NA', countryprefix: 'K' };
    enrichGeo(q, { override: ['continent', 'countryprefix'] });
    assert.equal(q.continent, 'NA');
    assert.equal(q.countryprefix, 'K');
  });

  it('treats a zone of "0" as blank', () => {
    const q = { call: 'JA1ABC', continent: 'AS', zone: '0', countryprefix: 'JA' };
    enrichGeo(q);
    assert.equal(q.zone, '25');
  });

  it('is a no-op for a QSO with no call, or an unresolvable one', () => {
    const empty = { call: '', continent: '' };
    assert.equal(enrichGeo(empty), empty);
    assert.equal(empty.continent, '');
    const junk = { call: '12345', continent: '', zone: '', countryprefix: '' };
    enrichGeo(junk);
    assert.equal(junk.continent, '');
  });

  it('degrades cleanly when no country file is available', () => {
    _setResolver(null);
    const q = { call: 'DL1XYZ', continent: '', zone: '', countryprefix: '' };
    enrichGeo(q);
    assert.equal(q.continent, '');
    assert.equal(resolveCall('DL1XYZ'), null);
    _setResolver(undefined); // let the next test reload the real file
  });

  it('resolveCall returns the raw country-file record', () => {
    const r = resolveCall('K3LR');
    assert.equal(r.continent, 'NA');
    assert.equal(r.prefix, 'K');
  });
});
