const EventEmitter = require('events');
const { createRadioListener } = require('./radioListener');
const { createContactListener } = require('./contactListener');
const { createScoreListener } = require('./scoreListener');
const { upsertRadio, insertQso, insertScore, cacheCallsign } = require('../db/queries');
const config = require('../../config/default.json');

const emitter = new EventEmitter();

function startListeners(io) {
  emitter.on('radio:update', (data) => {
    upsertRadio(data);
    io.emit('radio:update', data);
  });

  emitter.on('contact:new', (data) => {
    insertQso(data);
    io.emit('contact:new', data);
  });

  emitter.on('score:update', (data) => {
    insertScore(data);
    io.emit('score:update', data);
  });

  emitter.on('lookup:result', (data) => {
    if (data.call) cacheCallsign(data.call, data, 'n1mm');
    io.emit('lookup:result', data);
  });

  const radioPorts = Number(process.env.UDP_RADIO_PORT) || config.udp.radioPort;
  const contactPort = Number(process.env.UDP_CONTACT_PORT) || config.udp.contactPort;
  const scorePort = Number(process.env.UDP_SCORE_PORT) || config.udp.scorePort;

  createRadioListener(radioPorts, emitter);
  createContactListener(contactPort, emitter);
  createScoreListener(scorePort, emitter);
}

module.exports = { startListeners, emitter };
