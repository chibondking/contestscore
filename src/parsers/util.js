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

module.exports = { tensOfHzToHz };
