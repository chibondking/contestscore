// src/cosb/scope.js: COSB standings within a continent or CQ zone.
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isScope, scopeLabel, createLocator, scopeBoard, scopeChoices } = require('../../src/cosb/scope');

const board = {
  contest: { id: 1, name: 'T' },
  sections: [{
    label: 'SO-ALL HP',
    rows: [
      { rank: 1, call: 'EA8A', score: 900 },
      { rank: 2, call: 'K1AR', score: 800 },
      { rank: 3, call: 'DL1A', score: 700 },
      { rank: 4, call: 'W6XX', score: 600 },
      { rank: 5, call: 'Q9Q', score: 500 }, // unknown prefix
    ],
  }],
};
const CTY = { EA8: { continent: 'AF', cqzone: '33' }, K: { continent: 'NA', cqzone: '5' }, W: { continent: 'NA', cqzone: '5' }, DL: { continent: 'EU', cqzone: '14' } };
const resolveCall = (c) => CTY[c.slice(0, 3)] || CTY[c.slice(0, 2)] || CTY[c[0]] || null;
const LOOKUP = { W6XX: { cqzone: '3' } }; // HamQTH knows W6XX is zone 3, not cty's 5
const locate = createLocator({ resolveCall, getCachedLocation: (c) => LOOKUP[c] || null });

describe('COSB scope', () => {
  it('accepts world, a continent or a zone, nothing else', () => {
    for (const s of ['world', 'cont:EU', 'zone:5', 'zone:40']) assert.equal(isScope(s), true, s);
    for (const s of ['', 'cont:XX', 'zone:0', 'zone:41', 'zone:5;drop', 'EU']) assert.equal(isScope(s), false, s);
    assert.equal(scopeLabel('zone:5'), 'Zone 5');
    assert.equal(scopeLabel('cont:NA'), 'NA');
  });

  it('continent from the country file; zone from the lookup when we have one', () => {
    assert.deepEqual(locate('W6XX'), { continent: 'NA', zone: 3 });
    assert.deepEqual(locate('K1AR'), { continent: 'NA', zone: 5 });
    assert.deepEqual(locate('Q9Q'), { continent: null, zone: null });
  });

  it('cuts the board to the scope and re-ranks; unknown places are left out', () => {
    const na = scopeBoard(board, 'cont:NA', locate).sections[0].rows;
    assert.deepEqual(na.map((r) => [r.call, r.rank, r.board_rank]), [['K1AR', 1, 2], ['W6XX', 2, 4]]);
    const z5 = scopeBoard(board, 'zone:5', locate).sections[0].rows;
    assert.deepEqual(z5.map((r) => r.call), ['K1AR']);
    assert.equal(scopeBoard(board, 'world', locate), board);
  });

  it('keeps our own row when we are outside the scope, unranked', () => {
    const eu = scopeBoard(board, 'cont:EU', locate, 'K1AR').sections[0].rows;
    assert.deepEqual(eu.map((r) => [r.call, r.rank, Boolean(r.outside)]), [['K1AR', null, true], ['DL1A', 1, false]]);
  });

  it('offers the continents and zones the category has, with counts', () => {
    const c = scopeChoices(board.sections[0], locate);
    assert.deepEqual(c.continents.map((o) => [o.scope, o.count]), [['cont:NA', 2], ['cont:EU', 1], ['cont:AF', 1]]);
    assert.deepEqual(c.zones.map((o) => o.scope), ['zone:3', 'zone:5', 'zone:14', 'zone:33']);
  });
});
