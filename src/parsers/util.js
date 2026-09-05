// N1MM encodes several frequency fields in TENS OF HZ, not Hz -- confirmed
// against N1MM's own documented examples:
//   RadioInfo:    <Freq>352211</Freq> only makes sense as 3.52211 MHz (its
//                 own "CW-80m" StationName) once multiplied by 10 --
//                 352,211 Hz outright is nowhere near 80m.
//   ContactInfo:  <rxfreq>...</rxfreq>/<txfreq> similarly only land in the
//                 band the packet itself claims (<band>) once multiplied
//                 by 10.
// See https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/
//
// Storing the raw value directly silently reports every frequency at 1/10th
// of reality -- confirmed live in RadioInfo's Freq (dashboard showed 386.5
// kHz while actually on 3865 kHz) before this fix. Shared here, rather than
// duplicated per parser, specifically so fixing it in one field doesn't
// leave the same bug sitting in another (which is exactly how this was
// first missed: RadioInfo's Freq was fixed while ContactInfo's rxfreq/
// txfreq, doing the same conversion, kept storing the raw tens-of-Hz value).
function tensOfHzToHz(tensOfHz) {
  return tensOfHz ? String(Number(tensOfHz) * 10) : '';
}

// Amateur band edges in MHz, for reducing an exact frequency down to just
// the band it falls in. Used to keep the exact running frequency out of
// anything the dashboard sends to a browser (REST responses and the
// radio:update socket payload) -- for some contests, broadcasting the
// precise frequency to anyone with the dashboard URL amounts to
// cheerleading/spotting your own run. The exact value still passes through
// ContestPulse -> the ingest API -> radio_state (an authenticated,
// operator-only path -- no reason to touch the agent or gate that with
// nginx), it just never gets forwarded on to a public viewer from there.
const BAND_EDGES = [
  [1.8, 2.0, '160m'], [3.5, 4.0, '80m'], [5.3, 5.4, '60m'], [7.0, 7.3, '40m'],
  [10.1, 10.15, '30m'], [14.0, 14.35, '20m'], [18.068, 18.168, '17m'],
  [21.0, 21.45, '15m'], [24.89, 24.99, '12m'], [28.0, 29.7, '10m'],
  [50, 54, '6m'], [144, 148, '2m'], [222, 225, '1.25m'], [420, 450, '70cm'],
];

function freqToBand(freqHz) {
  const mhz = Number(freqHz) / 1e6;
  if (!mhz) return null;
  const match = BAND_EDGES.find(([lo, hi]) => mhz >= lo && mhz <= hi);
  return match ? match[2] : null;
}

module.exports = { tensOfHzToHz, freqToBand };
