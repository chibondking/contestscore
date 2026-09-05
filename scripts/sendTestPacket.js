/**
 * Simulate N1MM+ UDP traffic for local testing.
 *
 * Packet shapes match the real N1MM wire format documented at
 * https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/ — lowercase
 * <contactinfo>/<contactdelete> roots, and a <dynamicresults> Score broadcast
 * with a per-band/mode <breakdown>.
 *
 * Usage:
 *   node scripts/sendTestPacket.js [options]
 *
 * Options:
 *   --type <radio|contact|delete|score|lookup|session>
 *          What to send. 'session' (default) sends radio state, then --count
 *          contacts (occasionally editing or deleting one), with a Score
 *          update after each.
 *   --count <n>      Number of contacts in a session, or repeat count for
 *                    single-type sends. Default: 5
 *   --delay <ms>     Milliseconds between packets. Default: 300
 *   --host <addr>    Destination address. Default: 127.0.0.1
 *                    Use 255.255.255.255 to broadcast to the local network.
 *   --mycall <call>  Station callsign. Default: W1TEST
 *   --contest <name> Contest name. Default: CQ-WPX-CW
 */

const dgram = require('dgram');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  return fallback;
}

const TYPE    = arg('type', 'session');
const COUNT   = Number(arg('count', 5));
const DELAY   = Number(arg('delay', 300));
const HOST    = arg('host', '127.0.0.1');
const MYCALL  = arg('mycall', 'W1TEST');
const CONTEST = arg('contest', 'CQ-WPX-CW');
const CONTESTNR = '1';

const VALID_TYPES = ['radio', 'contact', 'delete', 'score', 'lookup', 'session'];
if (!VALID_TYPES.includes(TYPE)) {
  console.error(`Unknown --type "${TYPE}". Valid: ${VALID_TYPES.join(', ')}`);
  process.exit(1);
}

const PORTS = { radio: 12060, contact: 12061, score: 12062 };

// ---------------------------------------------------------------------------
// Realistic test data pool
// ---------------------------------------------------------------------------
const DX_CALLS = [
  'DL1ABC', 'JA1YXZ', 'VK2BNG', 'PA0RCT', 'UA9XL', 'OH2BH', 'SM5AQQ',
  'G3NKC', 'F5BZB', 'I2UIY', 'EA4KD', 'HB9CVQ', 'SP5EAQ', 'OM3JW',
  'YO8CRA', 'LY2BOS', 'ES5TV', 'OH1F', 'TF3JB', '9A2AJ', 'S59ABC',
  'VE3KZ', 'VE7GL', 'K1ZZ', 'W6YI', 'N5DX', 'K3LR', 'W2SC',
  'ZL3IX', 'ZS6EZ', 'VU2PAI', 'BY1CW', 'HL5BFT', '7Z5OO',
];

// N1MM's <band> field is the band in MHz, not meters.
const BANDS = ['28', '21', '14', '7', '3.5', '1.8'];
const MODES = ['CW', 'SSB', 'RTTY'];

// N1MM sends radio frequency in Hz.
const BAND_FREQS = {
  '28': 28025000, '21': 21025000, '14': 14025000,
  '7': 7025000, '3.5': 3525000, '1.8': 1825000,
};

let callPool = [...DX_CALLS];
function nextCall() {
  if (callPool.length === 0) callPool = [...DX_CALLS];
  return callPool.splice(Math.floor(Math.random() * callPool.length), 1)[0];
}

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

// ---------------------------------------------------------------------------
// Packet builders
// ---------------------------------------------------------------------------
function radioPacket(radioNr, freq, mode, isRunning = true) {
  return `<?xml version="1.0" encoding="utf-8"?>
<RadioInfo>
  <StationName>${MYCALL}-${radioNr}</StationName>
  <RadioNr>${radioNr}</RadioNr>
  <Freq>${freq}</Freq>
  <TXFreq>${freq}</TXFreq>
  <Mode>${mode}</Mode>
  <mycall>${MYCALL}</mycall>
  <OpCall>${MYCALL}</OpCall>
  <IsRunning>${isRunning ? 'True' : 'False'}</IsRunning>
  <IsTransmitting>False</IsTransmitting>
  <FocusEntry>1</FocusEntry>
  <Antenna>1</Antenna>
  <Rotors>90</Rotors>
  <FocusRadioNr>${radioNr}</FocusRadioNr>
  <ActiveRadioNr>${radioNr}</ActiveRadioNr>
</RadioInfo>`;
}

// root: 'contactinfo' for a fresh QSO, 'contactreplace' for an edited one.
function contactPacket(root, { id, call, band, mode, srx, radioNr, isMultiplier, isOriginal }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<${root}>
  <app>N1MM</app>
  <contestname>${CONTEST}</contestname>
  <contestnr>${CONTESTNR}</contestnr>
  <timestamp>${new Date().toISOString().replace('T', ' ').slice(0, 19)}</timestamp>
  <mycall>${MYCALL}</mycall>
  <band>${band}</band>
  <rxfreq>${BAND_FREQS[band]}</rxfreq>
  <txfreq>${BAND_FREQS[band]}</txfreq>
  <operator>${MYCALL}</operator>
  <mode>${mode}</mode>
  <call>${call}</call>
  <snt>599</snt>
  <sntnr>${String(srx).padStart(3, '0')}</sntnr>
  <rcv>599</rcv>
  <rcvnr>${String(srx).padStart(3, '0')}</rcvnr>
  <exchange1></exchange1>
  <section></section>
  <ismultiplier1>${isMultiplier ? '1' : '0'}</ismultiplier1>
  <ismultiplier2>0</ismultiplier2>
  <points>1</points>
  <radionr>${radioNr}</radionr>
  <RoverLocation></RoverLocation>
  <RadioInterfaced>${radioNr}</RadioInterfaced>
  <NetworkedCompNr>1</NetworkedCompNr>
  <IsOriginal>${isOriginal ? 'True' : 'False'}</IsOriginal>
  <StationName>${MYCALL}-${radioNr}</StationName>
  <ID>${id}</ID>
  <IsClaimedQso>1</IsClaimedQso>
</${root}>`;
}

function deleteContactPacket({ id, call, band }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<contactdelete>
  <app>N1MM</app>
  <timestamp>${new Date().toISOString().replace('T', ' ').slice(0, 19)}</timestamp>
  <mycall>${MYCALL}</mycall>
  <band>${band}</band>
  <call>${call}</call>
  <contestnr>${CONTESTNR}</contestnr>
  <StationName>${MYCALL}-1</StationName>
  <ID>${id}</ID>
</contactdelete>`;
}

// state: Map of "band|mode" -> { qsos, points }
function scorePacket(state) {
  let totalQsos = 0;
  let totalPoints = 0;
  const rows = [];
  for (const [key, v] of state) {
    const [band, mode] = key.split('|');
    rows.push(`    <qso band="${band}" mode="${mode}">${v.qsos}</qso>`);
    rows.push(`    <point band="${band}" mode="${mode}">${v.points}</point>`);
    totalQsos += v.qsos;
    totalPoints += v.points;
  }
  rows.push(`    <qso band="total" mode="ALL">${totalQsos}</qso>`);
  rows.push(`    <point band="total" mode="ALL">${totalPoints}</point>`);

  return `<?xml version="1.0"?>
<dynamicresults>
  <contest>${CONTEST}</contest>
  <call>${MYCALL}</call>
  <ops>${MYCALL}</ops>
  <class power="HIGH" assisted="NON-ASSISTED" transmitter="ONE" ops="SINGLE-OP" bands="ALL" mode="MIXED" overlay="N/A"></class>
  <breakdown>
${rows.join('\n')}
  </breakdown>
  <score>${totalPoints}</score>
  <timestamp>${new Date().toISOString().replace('T', ' ').slice(0, 19)}</timestamp>
</dynamicresults>`;
}

function lookupPacket(call) {
  return `<?xml version="1.0" encoding="utf-8"?>
<lookupinfo>
  <call>${call}</call>
  <name>Test Operator</name>
  <country>Germany</country>
  <grid>JO31</grid>
  <state></state>
  <county></county>
  <cqzone>14</cqzone>
  <ituzone>28</ituzone>
  <dxcc>DL</dxcc>
  <continent>EU</continent>
</lookupinfo>`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function send(xml, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const buf = Buffer.from(xml);
    sock.send(buf, 0, buf.length, port, HOST, (err) => {
      sock.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function sendSingle(type) {
  const band = BANDS[2]; // 14 MHz (20m)
  const mode = 'CW';
  const call = nextCall();

  switch (type) {
    case 'radio':
      await send(radioPacket(1, BAND_FREQS[band], mode, true), PORTS.radio);
      console.log(`→ RadioInfo  R1 ${BAND_FREQS[band]} Hz ${mode}`);
      break;
    case 'contact':
      await send(
        contactPacket('contactinfo', { id: newId(), call, band, mode, srx: 1, radioNr: 1, isMultiplier: false, isOriginal: true }),
        PORTS.contact
      );
      console.log(`→ contactinfo  ${call} ${band}MHz ${mode}`);
      break;
    case 'delete':
      await send(deleteContactPacket({ id: newId(), call, band }), PORTS.contact);
      console.log(`→ contactdelete  ${call} ${band}MHz`);
      break;
    case 'score': {
      const state = new Map([[`${band}|${mode}`, { qsos: 1, points: 1 }]]);
      await send(scorePacket(state), PORTS.score);
      console.log(`→ dynamicresults  QSOs:1 pts:1`);
      break;
    }
    case 'lookup':
      await send(lookupPacket(call), PORTS.contact);
      console.log(`→ lookupinfo  ${call}`);
      break;
  }
}

async function runSession() {
  console.log(`Session: ${COUNT} QSOs, ${DELAY}ms delay, mycall=${MYCALL}, contest=${CONTEST}, host=${HOST}\n`);

  // Establish radio state for two radios
  await send(radioPacket(1, BAND_FREQS['14'], 'CW', true), PORTS.radio);
  console.log('→ RadioInfo  R1 20m CW (running)');
  await sleep(DELAY);

  await send(radioPacket(2, BAND_FREQS['21'], 'CW', false), PORTS.radio);
  console.log('→ RadioInfo  R2 15m CW (S&P)');
  await sleep(DELAY);

  const state = new Map(); // "band|mode" -> { qsos, points }
  const sent = []; // { id, call, band, mode } for edit/delete demos

  for (let i = 1; i <= COUNT; i++) {
    const band = BANDS[Math.floor(Math.random() * 3)]; // 28/21/14 MHz
    const mode = 'CW';
    const call = nextCall();
    const id = newId();
    const isMultiplier = i % 4 === 0; // every 4th QSO is a new mult

    await send(
      contactPacket('contactinfo', { id, call, band, mode, srx: i, radioNr: 1, isMultiplier, isOriginal: true }),
      PORTS.contact
    );
    sent.push({ id, call, band, mode });

    const key = `${band}|${mode}`;
    const row = state.get(key) || { qsos: 0, points: 0 };
    row.qsos += 1;
    row.points += 1;
    state.set(key, row);

    console.log(`→ contactinfo  [${i}/${COUNT}] ${call.padEnd(8)} ${band}MHz ${mode}${isMultiplier ? ' MULT' : ''}`);
    await sleep(DELAY / 2);

    // Every 5th QSO, simulate the operator deleting a busted contact.
    if (i % 5 === 0 && sent.length > 1) {
      const victim = sent.shift();
      await send(deleteContactPacket(victim), PORTS.contact);
      const vKey = `${victim.band}|${victim.mode}`;
      const vRow = state.get(vKey);
      if (vRow) { vRow.qsos -= 1; vRow.points -= 1; }
      console.log(`→ contactdelete  ${victim.call} ${victim.band}MHz`);
      await sleep(DELAY / 2);
    }
    // Every 7th QSO, simulate the operator correcting the exchange in place.
    else if (i % 7 === 0) {
      const last = sent[sent.length - 1];
      await send(
        contactPacket('contactreplace', { id: last.id, call: last.call, band: last.band, mode: last.mode, srx: i, radioNr: 1, isMultiplier: false, isOriginal: false }),
        PORTS.contact
      );
      console.log(`→ contactreplace  ${last.call} (exchange corrected)`);
      await sleep(DELAY / 2);
    }

    await send(scorePacket(state), PORTS.score);
    const totalQsos = [...state.values()].reduce((a, r) => a + r.qsos, 0);
    const totalPoints = [...state.values()].reduce((a, r) => a + r.points, 0);
    console.log(`→ dynamicresults  QSOs:${totalQsos} pts:${totalPoints}`);
    await sleep(DELAY / 2);
  }

  console.log('\nSession complete.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
(async () => {
  try {
    if (TYPE === 'session') {
      await runSession();
    } else {
      for (let i = 0; i < COUNT; i++) {
        await sendSingle(TYPE);
        if (i < COUNT - 1) await sleep(DELAY);
      }
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
})();
