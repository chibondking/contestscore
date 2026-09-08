// Snap a frequency in MHz to a canonical band value shared by both
// parsers, so a Cabrillo log (which gives exact kHz per QSO, e.g. 14042 vs
// 14043) and an ADIF log (which gives a band token) both bucket into the
// same "band" and don't split one band across dozens of near-identical
// frequencies. The returned strings line up with public/js/*.js
// bandLabel()'s ranges, so they render as "20m", "40m", etc.

const BANDS = [
  { lo: 0.10, hi: 0.20, band: '0.136' },
  { lo: 0.40, hi: 0.50, band: '0.472' },
  { lo: 1.7, hi: 2.1, band: '1.8' },
  { lo: 3.4, hi: 4.1, band: '3.5' },
  { lo: 5.2, hi: 5.5, band: '5.3' },
  { lo: 6.9, hi: 7.4, band: '7' },
  { lo: 10.0, hi: 10.2, band: '10.1' },
  { lo: 13.9, hi: 14.5, band: '14' },
  { lo: 18.0, hi: 18.2, band: '18.1' },
  { lo: 20.9, hi: 21.5, band: '21' },
  { lo: 24.8, hi: 25.1, band: '24.9' },
  { lo: 27.9, hi: 29.8, band: '28' },
  { lo: 49, hi: 55, band: '50' },
  { lo: 69, hi: 75, band: '70' },
  { lo: 143, hi: 149, band: '144' },
  { lo: 218, hi: 226, band: '222' },
  { lo: 419, hi: 451, band: '432' },
  { lo: 902, hi: 928, band: '902' },
  { lo: 1240, hi: 1300, band: '1240' },
  { lo: 2300, hi: 2450, band: '2300' },
];

function canonicalBand(mhz) {
  const n = parseFloat(mhz);
  if (Number.isNaN(n)) return '';
  const hit = BANDS.find((b) => n >= b.lo && n < b.hi);
  return hit ? hit.band : String(n);
}

module.exports = { canonicalBand };
