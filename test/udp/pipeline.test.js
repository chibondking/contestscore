// End-to-end test of the real pipeline: UDP packet -> parser -> DB -> socket.io
// emit. Uses an in-memory DB and dedicated high test ports so it can run
// alongside a real contestscore instance without colliding.
process.env.DB_PATH = ':memory:';
process.env.UDP_RADIO_PORT = '15060';
process.env.UDP_CONTACT_PORT = '15061';
process.env.UDP_SCORE_PORT = '15062';

const dgram = require('dgram');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDb, closeDb } = require('../../src/db/index');
const { resetStatements, getQsos, getRadios, getLatestScore, getScoreBreakdown } = require('../../src/db/queries');
const { startListeners, emitter } = require('../../src/udp');

const RADIO_PORT = Number(process.env.UDP_RADIO_PORT);
const CONTACT_PORT = Number(process.env.UDP_CONTACT_PORT);
const SCORE_PORT = Number(process.env.UDP_SCORE_PORT);

function send(xml, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const buf = Buffer.from(xml);
    sock.send(buf, 0, buf.length, port, '127.0.0.1', (err) => {
      sock.close();
      if (err) reject(err); else resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Listeners parse asynchronously; poll instead of a single fixed delay.
async function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(interval);
  }
  throw new Error('waitFor: condition not met before timeout');
}

// Minimal io stand-in that records every emit for assertions.
function fakeIo() {
  return {
    events: [],
    emit(name, payload) { this.events.push({ name, payload }); },
  };
}

let sockets;
let io;

before(() => {
  initDb();
  io = fakeIo();
  sockets = startListeners(io);
});

after(() => {
  for (const s of sockets) s.close();
  resetStatements();
  closeDb();
});

beforeEach(() => {
  io.events = [];
});

describe('radio pipeline', () => {
  it('RadioInfo packet reaches radio_state and emits radio:update', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<RadioInfo>
  <StationName>K1TTT-1</StationName>
  <RadioNr>1</RadioNr>
  <Freq>1402500</Freq>
  <TXFreq>1402500</TXFreq>
  <Mode>CW</Mode>
  <OpCall>K1TTT</OpCall>
  <IsRunning>True</IsRunning>
  <IsTransmitting>False</IsTransmitting>
  <FocusRadioNr>1</FocusRadioNr>
  <ActiveRadioNr>1</ActiveRadioNr>
</RadioInfo>`;
    await send(xml, RADIO_PORT);
    await waitFor(() => getRadios().length === 1);

    const [radio] = getRadios();
    assert.equal(radio.freq, '14025000');
    assert.equal(radio.op_call, 'K1TTT');

    const evt = io.events.find((e) => e.name === 'radio:update');
    assert.ok(evt);
    assert.equal(evt.payload.radio_nr, 1);
  });
});

describe('contact pipeline', () => {
  it('contactinfo reaches qsos and emits contact:new', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<contactinfo>
  <contestname>CQ-WPX-CW</contestname>
  <contestnr>73</contestnr>
  <mycall>K1TTT</mycall>
  <band>14</band>
  <operator>K1TTT</operator>
  <mode>CW</mode>
  <call>DL1ABC</call>
  <points>1</points>
  <radionr>1</radionr>
  <ID>pipeline-test-0001</ID>
  <IsOriginal>True</IsOriginal>
</contactinfo>`;
    await send(xml, CONTACT_PORT);
    await waitFor(() => getQsos().some((q) => q.call === 'DL1ABC'));

    const row = getQsos().find((q) => q.call === 'DL1ABC');
    assert.equal(row.band, '14');
    assert.equal(row.ext_id, 'pipeline-test-0001');

    const evt = io.events.find((e) => e.name === 'contact:new');
    assert.ok(evt);
    assert.equal(evt.payload.call, 'DL1ABC');
  });

  it('contactreplace updates the existing row instead of duplicating it', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<contactreplace>
  <contestname>CQ-WPX-CW</contestname>
  <contestnr>73</contestnr>
  <mycall>K1TTT</mycall>
  <band>14</band>
  <operator>K1TTT</operator>
  <mode>CW</mode>
  <call>DL1ABC</call>
  <points>3</points>
  <radionr>1</radionr>
  <ID>pipeline-test-0001</ID>
  <IsOriginal>False</IsOriginal>
</contactreplace>`;
    await send(xml, CONTACT_PORT);
    await waitFor(() => (getQsos().find((q) => q.ext_id === 'pipeline-test-0001') || {}).points === 3);

    const rows = getQsos().filter((q) => q.ext_id === 'pipeline-test-0001');
    assert.equal(rows.length, 1); // updated in place, not duplicated
  });

  it('contactdelete removes the row and emits contact:delete', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<contactdelete>
  <mycall>K1TTT</mycall>
  <band>14</band>
  <call>DL1ABC</call>
  <contestnr>73</contestnr>
  <ID>pipeline-test-0001</ID>
</contactdelete>`;
    await send(xml, CONTACT_PORT);
    await waitFor(() => !getQsos().some((q) => q.ext_id === 'pipeline-test-0001'));

    const evt = io.events.find((e) => e.name === 'contact:delete');
    assert.ok(evt);
    assert.equal(evt.payload.call, 'DL1ABC');
  });

  it('lookupinfo emits lookup:result', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<lookupinfo>
  <call>DL1ABC</call>
  <name>Test</name>
  <country>Germany</country>
</lookupinfo>`;
    await send(xml, CONTACT_PORT);
    await waitFor(() => io.events.some((e) => e.name === 'lookup:result'));

    const evt = io.events.find((e) => e.name === 'lookup:result');
    assert.equal(evt.payload.call, 'DL1ABC');
  });

  // DX cluster/RBN spot display is permanently out of scope (see CLAUDE.md's
  // Prime Directive) -- N1MM's <spot> broadcasts on this same port must be
  // silently ignored, not logged as "unexpected", since they're expected,
  // known traffic we're deliberately not acting on.
  it('spot packets are silently ignored -- no event, no warning, pipeline stays healthy', async () => {
    const originalWarn = console.warn;
    let warned = false;
    console.warn = (...args) => { warned = true; originalWarn(...args); };
    try {
      const spotXml = `<?xml version="1.0" encoding="utf-8"?>
<spot>
  <call>DL1ABC</call>
  <freq>14025.0</freq>
  <spotter>W1AW</spotter>
</spot>`;
      await send(spotXml, CONTACT_PORT);
      await sleep(100); // nothing to waitFor -- confirming absence of a reaction

      assert.equal(io.events.length, 0, 'a spot packet must not emit any socket event');
      assert.equal(warned, false, 'spot packets are expected traffic -- must not warn');

      // Prove the listener is still healthy afterward, not just quiet.
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<contactinfo>
  <contestname>CQ-WPX-CW</contestname>
  <contestnr>73</contestnr>
  <mycall>K1TTT</mycall>
  <band>14</band>
  <call>SPOT-FOLLOWUP</call>
  <ID>pipeline-test-spot-followup</ID>
</contactinfo>`;
      await send(xml, CONTACT_PORT);
      await waitFor(() => getQsos().some((q) => q.call === 'SPOT-FOLLOWUP'));
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('score pipeline', () => {
  it('a dynamicresults broadcast stores the full breakdown and emits the total', async () => {
    const xml = `<?xml version="1.0"?>
<dynamicresults>
  <contest>CQ-WPX-CW</contest>
  <call>K1TTT</call>
  <breakdown>
    <qso band="20" mode="CW">30</qso>
    <point band="20" mode="CW">60</point>
    <qso band="total" mode="ALL">30</qso>
    <point band="total" mode="ALL">60</point>
  </breakdown>
  <score>60</score>
</dynamicresults>`;
    await send(xml, SCORE_PORT);
    await waitFor(() => getLatestScore() !== null);

    const total = getLatestScore();
    assert.equal(total.qsos, 30);
    assert.equal(total.points, 60);

    const breakdown = getScoreBreakdown();
    assert.ok(breakdown.some((b) => b.band === '20' && b.qsos === 30));

    const evt = io.events.find((e) => e.name === 'score:update');
    assert.ok(evt);
    assert.equal(evt.payload.qsos, 30);
    assert.equal(evt.payload.total, 60);
  });

  it('a second broadcast for a different band does not clobber the running total', async () => {
    const xml = `<?xml version="1.0"?>
<dynamicresults>
  <contest>CQ-WPX-CW</contest>
  <call>K1TTT</call>
  <breakdown>
    <qso band="20" mode="CW">30</qso>
    <point band="20" mode="CW">60</point>
    <qso band="40" mode="CW">10</qso>
    <point band="40" mode="CW">20</point>
    <qso band="total" mode="ALL">40</qso>
    <point band="total" mode="ALL">80</point>
  </breakdown>
  <score>80</score>
</dynamicresults>`;
    await send(xml, SCORE_PORT);
    await waitFor(() => (getLatestScore() || {}).qsos === 40);

    const total = getLatestScore();
    assert.equal(total.points, 80);
  });

  it('a malformed packet is logged and does not crash the listener', async () => {
    await send('<not-xml-at-all', SCORE_PORT);
    await sleep(100);
    // Listener must still be alive for the next real packet.
    const xml = `<?xml version="1.0"?>
<dynamicresults>
  <contest>CQ-WPX-CW</contest>
  <call>K1TTT</call>
  <breakdown>
    <qso band="total" mode="ALL">41</qso>
    <point band="total" mode="ALL">81</point>
  </breakdown>
  <score>81</score>
</dynamicresults>`;
    await send(xml, SCORE_PORT);
    await waitFor(() => (getLatestScore() || {}).qsos === 41);
  });
});

describe('cross-port dispatch', () => {
  // Regression test for a real-world report: a live capture showed N1MM's
  // Score broadcast arriving on the port this deployment's own config
  // called the radio port. All three listeners now dispatch by the
  // packet's actual root element (see udp/dispatch.js), so this must still
  // work correctly instead of logging "Not a RadioInfo packet" and dropping
  // real score data on the floor. Placed last in the file, deliberately:
  // it writes score_snapshots rows earlier describe blocks assume don't
  // exist yet when they start (e.g. "score pipeline"'s first test waits for
  // getLatestScore() !== null, which only means "my packet was processed"
  // if the table was actually empty beforehand).
  it('a Score (dynamicresults) packet arriving on the radio port is still processed correctly', async () => {
    const xml = `<?xml version="1.0"?>
<dynamicresults>
  <contest>CW-OPEN</contest>
  <call>WT2P</call>
  <breakdown>
    <qso band="total" mode="ALL">7</qso>
    <point band="total" mode="ALL">14</point>
  </breakdown>
  <score>14</score>
</dynamicresults>`;
    await send(xml, RADIO_PORT); // deliberately the wrong port
    await waitFor(() => (getLatestScore() || {}).qsos === 7);

    const total = getLatestScore();
    assert.equal(total.points, 14);
    assert.equal(io.events.some((e) => e.name === 'score:update'), true);
    assert.equal(io.events.some((e) => e.name === 'radio:update'), false);
  });
});
