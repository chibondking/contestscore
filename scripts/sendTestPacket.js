const dgram = require('dgram');

const PACKETS = {
  radio: `<RadioInfo>
  <StationName>TESTSTATION</StationName>
  <RadioNr>1</RadioNr>
  <Freq>14025000</Freq>
  <TXFreq>14025000</TXFreq>
  <Mode>CW</Mode>
  <OpCall>W1TEST</OpCall>
  <IsRunning>1</IsRunning>
  <FocusEntry>1</FocusEntry>
  <Antenna>Yagi</Antenna>
  <Rotator>North</Rotator>
  <FocusRadioNr>1</FocusRadioNr>
</RadioInfo>`,

  contact: `<ContactInfo>
  <call>W1AW</call>
  <band>20</band>
  <mode>CW</mode>
  <operator>W1TEST</operator>
  <mycall>W1TEST</mycall>
  <contestname>TEST</contestname>
  <srx>001</srx>
  <stx>001</stx>
  <snt>599</snt>
  <rcv>599</rcv>
  <points>1</points>
  <IsMultiplier1>0</IsMultiplier1>
  <IsMultiplier2>0</IsMultiplier2>
</ContactInfo>`,

  score: `<Score>
  <contest>TEST</contest>
  <call>W1TEST</call>
  <operators>W1TEST</operators>
  <power>HIGH</power>
  <assisted>0</assisted>
  <band>ALL</band>
  <mode>CW</mode>
  <qsos>10</qsos>
  <points>30</points>
  <mults>5</mults>
  <mults2>0</mults2>
  <total>150</total>
</Score>`,
};

const PORT_MAP = { radio: 12060, contact: 12061, score: 12062 };

const typeArg = process.argv.find((a) => a.startsWith('--type=') || a === '--type');
const type = typeArg
  ? (typeArg.startsWith('--type=') ? typeArg.split('=')[1] : process.argv[process.argv.indexOf('--type') + 1])
  : 'score';

if (!PACKETS[type]) {
  console.error(`Unknown type: ${type}. Use radio|contact|score`);
  process.exit(1);
}

const payload = Buffer.from(PACKETS[type]);
const port = PORT_MAP[type];
const sock = dgram.createSocket('udp4');

sock.send(payload, 0, payload.length, port, '127.0.0.1', (err) => {
  if (err) console.error('Send error:', err);
  else console.log(`Sent ${type} packet to UDP :${port}`);
  sock.close();
});
