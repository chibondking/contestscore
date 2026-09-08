const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCty, makeResolver, locationToken } = require('../../src/analyze/cty');

const CTY = fs.readFileSync(path.join(__dirname, '../../src/analyze/cty.csv'), 'utf8');
const resolve = makeResolver(parseCty(CTY));

describe('cty resolver', () => {
  it('resolves common calls to the right entity / continent / zone', () => {
    const cases = [
      ['K3LR', 'K', 'NA', '5'],
      ['W1AW', 'K', 'NA', '5'],
      ['DL1XYZ', 'DL', 'EU', '14'],
      ['JA1ABC', 'JA', 'AS', '25'],
      ['VK3AA', 'VK', 'OC', '30'],
      ['PY2ZZ', 'PY', 'SA', '11'],
      ['ZS6XX', 'ZS', 'AF', '38'],
      ['G3XYZ', 'G', 'EU', '14'],
    ];
    for (const [call, prefix, cont, zone] of cases) {
      const r = resolve(call);
      assert.ok(r, `${call} should resolve`);
      assert.equal(r.prefix, prefix, `${call} prefix`);
      assert.equal(r.continent, cont, `${call} continent`);
      assert.equal(r.cqzone, zone, `${call} zone`);
    }
  });

  it('applies per-alias zone/continent overrides (KH6, KL7)', () => {
    assert.equal(resolve('KH6XX').continent, 'OC');
    assert.equal(resolve('KH6XX').cqzone, '31');
    assert.equal(resolve('KL7RA').continent, 'NA');
    assert.equal(resolve('KL7RA').cqzone, '1');
  });

  it('handles portable prefixes: uses the prepended location', () => {
    assert.equal(resolve('EA8/DL1XYZ').continent, 'AF'); // Canary Islands
    assert.equal(resolve('EA8/DL1XYZ').prefix, 'EA8');
  });

  it('handles portable suffixes: ignores /P /M and lone digits', () => {
    assert.equal(resolve('DL1XYZ/P').prefix, 'DL');
    assert.equal(resolve('W1AW/4').prefix, 'K');
  });

  it('returns null for an unresolvable string', () => {
    assert.equal(resolve('12345'), null);
    assert.equal(resolve('/////'), null);
    assert.equal(resolve(''), null);
    assert.equal(resolve(null), null);
  });

  it('locationToken picks the shorter part of a slashed call', () => {
    assert.equal(locationToken('EA8/DL1XYZ'), 'EA8');
    assert.equal(locationToken('DL1XYZ/P'), 'DL1XYZ');
    assert.equal(locationToken('W1AW'), 'W1AW');
  });
});
