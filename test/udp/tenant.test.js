process.env.DB_PATH = ':memory:';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements } = require('../../src/db/queries');

before(() => initDb());
after(() => { resetStatements(); closeDb(); });

describe('startListeners in tenant mode', () => {
  it('opens no UDP sockets but still wires the ingest pipeline', async () => {
    process.env.CONTESTSCORE_TENANT = 'k9ct';
    process.env.UDP_RADIO_PORT = '0';
    try {
      const { startListeners, getUdpListeners, emitter } = require('../../src/udp');
      const emitted = [];
      const sockets = startListeners({ emit: (ev, d) => emitted.push([ev, d]) });
      assert.deepEqual(sockets, []);
      assert.equal(getUdpListeners(), null);
      emitter.emit('radio:update', { station_name: 'PC1', radio_nr: 1 });
      assert.equal(emitted[0][0], 'radio:update');
    } finally {
      delete process.env.CONTESTSCORE_TENANT;
      delete process.env.UDP_RADIO_PORT;
    }
  });
});
