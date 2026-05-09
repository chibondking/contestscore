/**
 * Simulate N1MM+ UDP traffic for local testing.
 *
 * Usage:
 *   node scripts/sendTestPacket.js [options]
 *
 * Options:
 *   --type <radio|contact|score|lookup|session>
 *          What to send. 'session' (default) sends radio state, then --count
 *          contacts with a score update after each one.
 *   --count <n>      Number of contacts in a session, or repeat count for
 *                    single-type sends. Default: 5
 *   --delay <ms>     Milliseconds between packets. Default: 300
 *   --host <addr>    Destination address. Default: 127.0.0.1
 *                    Use 255.255.255.255 to broadcast to the local network.
 *   --mycall <call>  Station callsign. Default: W1TEST
 *   --contest <name> Contest name. Default: CQ-WPX-CW
 */

const dgram = require('dgram');

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

const VALID_TYPES = ['radio', 'contact', 'score', 'lookup', 'session'];
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

const BANDS = ['10', '15', '20', '40', '80', '160'];
const MODES = ['CW', 'SSB', 'RTTY'];

// 14 MHz = 14000000 Hz; N1MM sends in Hz
const BAND_FREQS = {
  '10': 28025000, '15': 21025000, '20': 14025000,
  '40': 7025000,  '80': 3525000,  '160': 1825000,
};

let callPool = [...DX_CALLS];
function nextCall() {
  if (callPool.length === 0) callPool = [...DX_CALLS];
  return callPool.splice(Math.floor(Math.random() * callPool.length), 1)[0];
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

function contactPacket(call, band, mode, srx, isMultiplier = false) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ContactInfo>
  <call>${call}</call>
  <band>${band}</band>
  <mode>${mode}</mode>
  <operator>${MYCALL}</operator>
  <mycall>${MYCALL}</mycall>
  <contestname>${CONTEST}</contestname>
  <srx>${String(srx).padStart(3, '0')}</srx>
  <stx>${String(srx).padStart(3, '0')}</stx>
  <snt>599</snt>
  <rcv>599</rcv>
  <points>1</points>
  <mult1>${isMultiplier ? call.slice(0, 2) : ''}</mult1>
  <mult2></mult2>
  <IsMultiplier1>${isMultiplier ? 'True' : 'False'}</IsMultiplier1>
  <IsMultiplier2>False</IsMultiplier2>
  <exchange1></exchange1>
  <section></section>
  <RoverLocation></RoverLocation>
  <RadioInterfaced>1</RadioInterfaced>
  <NetworkedCompNr>1</NetworkedCompNr>
  <IsNewQso>1</IsNewQso>
  <DeleteContact>False</DeleteContact>
</ContactInfo>`;
}

function deleteContactPacket(call, band, mode) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ContactInfo>
  <call>${call}</call>
  <band>${band}</band>
  <mode>${mode}</mode>
  <operator>${MYCALL}</operator>
  <mycall>${MYCALL}</mycall>
  <contestname>${CONTEST}</contestname>
  <IsNewQso>0</IsNewQso>
  <DeleteContact>True</DeleteContact>
</ContactInfo>`;
}

function scorePacket(qsos, points, mults) {
  const total = points * mults;
  return `<?xml version="1.0" encoding="utf-8"?>
<Score>
  <contest>${CONTEST}</contest>
  <call>${MYCALL}</call>
  <operators>${MYCALL}</operators>
  <power>HIGH</power>
  <assisted>False</assisted>
  <transmitted>ALL</transmitted>
  <band>ALL</band>
  <mode>MIXED</mode>
  <qsos>${qsos}</qsos>
  <points>${points}</points>
  <mults>${mults}</mults>
  <mults2>0</mults2>
  <total>${total}</total>
</Score>`;
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
  const band = BANDS[1]; // 15m
  const mode = 'CW';
  const call = nextCall();

  switch (type) {
    case 'radio':
      await send(radioPacket(1, BAND_FREQS[band], mode, true), PORTS.radio);
      console.log(`→ RadioInfo  R1 ${BAND_FREQS[band]} Hz ${mode}`);
      break;
    case 'contact':
      await send(contactPacket(call, band, mode, 1), PORTS.contact);
      console.log(`→ ContactInfo  ${call} ${band}m ${mode}`);
      break;
    case 'score':
      await send(scorePacket(1, 1, 1), PORTS.score);
      console.log(`→ Score  QSOs:1 pts:1 mults:1 total:1`);
      break;
    case 'lookup':
      await send(lookupPacket(call), PORTS.contact);
      console.log(`→ lookupinfo  ${call}`);
      break;
  }
}

async function runSession() {
  console.log(`Session: ${COUNT} QSOs, ${DELAY}ms delay, mycall=${MYCALL}, contest=${CONTEST}, host=${HOST}\n`);

  // Establish radio state for two radios
  await send(radioPacket(1, BAND_FREQS['20'], 'CW', true), PORTS.radio);
  console.log('→ RadioInfo  R1 20m CW (running)');
  await sleep(DELAY);

  await send(radioPacket(2, BAND_FREQS['15'], 'CW', false), PORTS.radio);
  console.log('→ RadioInfo  R2 15m CW (S&P)');
  await sleep(DELAY);

  let qsos = 0;
  let points = 0;
  let mults = 0;

  for (let i = 1; i <= COUNT; i++) {
    const band = BANDS[Math.floor(Math.random() * 3)]; // 10/15/20
    const mode = 'CW';
    const call = nextCall();
    const isMultiplier = i % 4 === 0; // every 4th QSO is a new mult

    await send(contactPacket(call, band, mode, i, isMultiplier), PORTS.contact);
    qsos++;
    points += 1;
    if (isMultiplier) mults++;

    console.log(`→ ContactInfo  [${i}/${COUNT}] ${call.padEnd(8)} ${band}m ${mode}${isMultiplier ? ' MULT' : ''}`);
    await sleep(DELAY / 2);

    await send(scorePacket(qsos, points, Math.max(mults, 1)), PORTS.score);
    const total = points * Math.max(mults, 1);
    console.log(`→ Score        QSOs:${qsos} pts:${points} mults:${Math.max(mults, 1)} total:${total}`);
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
