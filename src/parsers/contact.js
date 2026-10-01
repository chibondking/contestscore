const xml2js = require('xml2js');
const { tensOfHzToHz } = require('./util');

const PARSE_OPTS = { explicitArray: false, trim: true };

// N1MM sends True/False for booleans; older versions may send 1/0
function toBool(val) {
  if (val == null) return 0;
  const s = String(val).toLowerCase();
  return s === 'true' || s === '1' ? 1 : 0;
}

// DXLog.net's own (native) broadcast, as opposed to its N1MM-compatible one:
// same <contactinfo> root, but its own field names -- <guid> for the QSO ID,
// <stationid>, <nr>, <exch1>..<exch4>, <runqso>, <xqso>, and <mult1>..<mult3>
// holding the multiplier itself (e.g. the call, in CW-OPS) or empty when the
// QSO isn't one. An edit (including marking an X-QSO) re-sends the whole
// record with the same <guid>, <newqso>False. Recognised by its <guid> or
// <logger>DXLog...; each field below falls back to the native name, so the
// N1MM-format path is unchanged. See test/fixtures/dxlog/native-*.xml.
function isDxlogNative(c) {
  return c.guid != null || /^dxlog/i.test(String(c.logger || ''));
}

// Native <multN> is the multiplier's value, not a flag: any value means yes.
function nativeMult(val) {
  return val != null && String(val).trim() !== '' ? 1 : 0;
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
  const native = isDxlogNative(c);
  const nativeExchange = native
    ? [c.exch1, c.exch2, c.exch3, c.exch4].filter((x) => x != null && String(x).trim() !== '').join(' ')
    : '';
  return {
    // N1MM's <ID> is a GUID that stays stable across contactreplace edits —
    // use it as the durable identity for this QSO when present.
    ext_id:           c.ID || (native ? c.guid : null) || null,
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
    snt_nr:           c.sntnr || (native ? c.nr : '') || '',
    rcv:              c.rcv || '',
    rcv_nr:           c.rcvnr || '',
    gridsquare:       c.gridsquare || '',
    // documentation renders this tag as "exchangel" in at least one spot —
    // almost certainly an OCR mangling of "exchange1"; accept either.
    exchange1:        c.exchange1 || c.exchangel || nativeExchange,
    section:          c.section || '',
    comment:          c.comment || '',
    op_name:          c.name || '',
    power:            c.power || '',
    misctext:         c.misctext || '',
    zone:             c.zone || '',
    prec:             c.prec || '',
    ck:               c.ck || '',
    is_mult1:         native && c.ismultiplier1 == null ? nativeMult(c.mult1) : toBool(c.ismultiplier1 ?? c.ismultiplierl),
    is_mult2:         native && c.ismultiplier2 == null ? nativeMult(c.mult2) : toBool(c.ismultiplier2),
    is_mult3:         native && c.ismultiplier3 == null ? nativeMult(c.mult3) : toBool(c.ismultiplier3),
    points:           Number(c.points) || 0,
    radio_nr:         c.radionr != null ? Number(c.radionr) : null,
    run1run2:         c.run1run2 || '',
    rover_loc:        c.RoverLocation || '',
    radio_interfaced: c.RadioInterfaced != null ? Number(c.RadioInterfaced) : null,
    comp_nr:          c.NetworkedCompNr != null ? Number(c.NetworkedCompNr) : null,
    is_original:      c.IsOriginal != null ? toBool(c.IsOriginal) : (native && c.local != null ? toBool(c.local) : 1),
    netbios_name:     c.NetBiosName || '',
    is_run_qso:       toBool(c.IsRunQSO ?? (native ? c.runqso : null)),
    station_name:     c.StationName || (native ? c.stationid : '') || '',
    // Native: <xqso>True is DXLog's X-QSO (also flagged <invalid>True).
    is_claimed_qso:   c.IsClaimedQso != null ? toBool(c.IsClaimedQso)
      : (native && c.xqso != null ? 1 - toBool(c.xqso) : 1),
    sent_exchange:    c.SentExchange || '',
    n1mm_timestamp:   c.timestamp || '',
  };
}

module.exports = { parseContact };
