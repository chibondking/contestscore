const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { enrichGeo, resolveCall, gridToLatLon, resolveLatLon, _setResolver } = require('../../src/analyze/geo');

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

  it('override: forces only the named fields from the country file over a stale packet value', () => {
    // Demonstrates the mechanism is per-field selective: continent gets
    // corrected, zone (not in this call's override list) is left as sent.
    const q = { call: 'DL1XYZ', continent: 'NA', zone: '5', countryprefix: 'K' };
    enrichGeo(q, { override: ['continent'] });
    assert.equal(q.continent, 'EU');
    assert.equal(q.zone, '5');
    assert.equal(q.countryprefix, 'K');
  });

  it('override: the realtime pipeline\'s actual call corrects continent + countryprefix + zone', () => {
    // not1mm's contactinfo packet hardcodes continent=NA countryprefix=K on
    // every QSO; separately, a key-name typo in its ADD-path sender means
    // its zone field never gets touched either and stays frozen at its own
    // class-level default ("5") for every QSO -- confirmed against
    // not1mm's source. This is the exact override list src/udp/index.js
    // passes.
    const q = { call: 'DL1XYZ', continent: 'NA', zone: '5', countryprefix: 'K' };
    enrichGeo(q, { override: ['continent', 'countryprefix', 'zone'] });
    assert.equal(q.continent, 'EU');
    assert.equal(q.countryprefix, 'DL');
    assert.equal(q.zone, '14');
  });

  it('override: keeps the packet value when the lookup produces nothing', () => {
    const q = { call: '12345', continent: 'NA', countryprefix: 'K', zone: '5' };
    enrichGeo(q, { override: ['continent', 'countryprefix', 'zone'] });
    assert.equal(q.continent, 'NA');
    assert.equal(q.countryprefix, 'K');
    assert.equal(q.zone, '5');
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

describe('gridToLatLon (world map)', () => {
  it('centers a bare 2-char field (20 x 10 deg)', () => {
    // 'AA' -> field origin (-180,-90), centered on a 20x10 box.
    assert.deepEqual(gridToLatLon('AA'), { lat: -85, lon: -170 });
  });

  it('centers a 4-char square (2 x 1 deg) within its field', () => {
    // 'AA00' -> square origin still (-180,-90), centered on a 2x1 box.
    assert.deepEqual(gridToLatLon('AA00'), { lat: -89.5, lon: -179 });
    // 'FN31' (a real 4-char US grid): F=5th letter->lon -180+100=-80,
    // N=13th->lat -90+130=40, then +3*2=+6 lon, +1*1=+1 lat, +square center.
    const fn31 = gridToLatLon('FN31');
    assert.equal(fn31.lon, -80 + 6 + 1);
    assert.equal(fn31.lat, 40 + 1 + 0.5);
  });

  it('resolves the finer 6-char subsquare within its 4-char square', () => {
    const fourChar = gridToLatLon('FN31');
    const sixChar = gridToLatLon('FN31AA'); // 'AA' subsquare = bottom-left corner of the square
    // The 6-char center sits within the 4-char square's own bounds, at its
    // south-west corner's subsquare rather than dead center.
    assert.ok(sixChar.lat < fourChar.lat);
    assert.ok(sixChar.lon < fourChar.lon);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    assert.deepEqual(gridToLatLon(' fn31 '), gridToLatLon('FN31'));
  });

  it('returns null for anything that is not a valid locator', () => {
    assert.equal(gridToLatLon(''), null);
    assert.equal(gridToLatLon(null), null);
    assert.equal(gridToLatLon(undefined), null);
    assert.equal(gridToLatLon('599'), null);      // an ordinary signal report, not a grid
    assert.equal(gridToLatLon('A'), null);        // too short
    assert.equal(gridToLatLon('AA000'), null);    // 5 chars -- not a valid locator length
    assert.equal(gridToLatLon('ZZ99'), null);     // Z is out of the A-R field range
  });
});

describe('resolveLatLon (world map)', () => {
  it('prefers a real grid square over the country-file entity center', () => {
    const q = { call: 'W1AW', gridsquare: 'FN31' };
    assert.deepEqual(resolveLatLon(q), gridToLatLon('FN31'));
  });

  it('falls back to the country file when there is no usable grid square', () => {
    for (const gridsquare of [undefined, '', '599', 'not-a-grid']) {
      const q = { call: 'W1AW', gridsquare };
      const r = resolveLatLon(q);
      const k = resolveCall('W1AW');
      assert.equal(r.lat, k.lat);
      assert.equal(r.lon, k.lon);
    }
  });

  it('returns null when neither a grid square nor the call resolves', () => {
    assert.equal(resolveLatLon({ call: '12345' }), null);
    assert.equal(resolveLatLon({ call: '' }), null);
    assert.equal(resolveLatLon(null), null);
  });

  it('degrades cleanly with no country file and no grid square', () => {
    _setResolver(null);
    assert.equal(resolveLatLon({ call: 'W1AW' }), null);
    _setResolver(undefined);
  });
});
