const xml2js = require('xml2js');
const { tensOfHzToHz } = require('./util');

const PARSE_OPTS = { explicitArray: false, trim: true };

// N1MM sends True/False for booleans; older versions may send 1/0
function toBool(val) {
  if (val == null) return 0;
  const s = String(val).toLowerCase();
  return s === 'true' || s === '1' ? 1 : 0;
}

// Real N1MM/TR4W wire format (per
// https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/):
// root element is lowercase <contactinfo>, and an edited-in-place QSO
// re-broadcasts the same field set under <contactreplace>. Deletes are a
// wholly separate packet type — see parsers/contactDelete.js — not a flag
// inside this one.
async function parseContact(buf) {
  const result = await xml2js.parseStringPromise(buf.toString(), PARSE_OPTS);
  const c = result.contactinfo || result.contactreplace;
  if (!c) throw new Error('Not a contactinfo/contactreplace packet');
  return {
    // N1MM's <ID> is a GUID that stays stable across contactreplace edits —
    // use it as the durable identity for this QSO when present.
    ext_id:           c.ID || null,
    call:             c.call || '',
    band:             c.band || '',
    mode:             c.mode || '',
    operator:         c.operator || '',
    mycall:           c.mycall || '',
    contestname:      c.contestname || '',
    contestnr:        c.contestnr || '',
    // See parsers/util.js -- N1MM's rxfreq/txfreq are in tens of Hz, same
    // as RadioInfo's Freq/TXFreq.
    rx_freq:          tensOfHzToHz(c.rxfreq),
    tx_freq:          tensOfHzToHz(c.txfreq),
    countryprefix:    c.countryprefix || '',
    wpxprefix:        c.wpxprefix || '',
    stationprefix:    c.stationprefix || '',
    continent:        c.continent || '',
    snt:              c.snt || '',
    snt_nr:           c.sntnr || '',
    rcv:              c.rcv || '',
    rcv_nr:           c.rcvnr || '',
    gridsquare:       c.gridsquare || '',
    // documentation renders this tag as "exchangel" in at least one spot —
    // almost certainly an OCR mangling of "exchange1"; accept either.
    exchange1:        c.exchange1 || c.exchangel || '',
    section:          c.section || '',
    comment:          c.comment || '',
    op_name:          c.name || '',
    power:            c.power || '',
    misctext:         c.misctext || '',
    zone:             c.zone || '',
    prec:             c.prec || '',
    ck:               c.ck || '',
    is_mult1:         toBool(c.ismultiplier1 ?? c.ismultiplierl),
    is_mult2:         toBool(c.ismultiplier2),
    is_mult3:         toBool(c.ismultiplier3),
    points:           Number(c.points) || 0,
    radio_nr:         c.radionr != null ? Number(c.radionr) : null,
    run1run2:         c.run1run2 || '',
    rover_loc:        c.RoverLocation || '',
    radio_interfaced: c.RadioInterfaced != null ? Number(c.RadioInterfaced) : null,
    comp_nr:          c.NetworkedCompNr != null ? Number(c.NetworkedCompNr) : null,
    is_original:      c.IsOriginal != null ? toBool(c.IsOriginal) : 1,
    netbios_name:     c.NetBiosName || '',
    is_run_qso:       toBool(c.IsRunQSO),
    station_name:     c.StationName || '',
    is_claimed_qso:   toBool(c.IsClaimedQso != null ? c.IsClaimedQso : 1),
    sent_exchange:    c.SentExchange || '',
    n1mm_timestamp:   c.timestamp || '',
  };
}

module.exports = { parseContact };
