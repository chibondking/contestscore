// ADIF -> { meta, qsos, flags }. Pure function, same contract as
// cabrillo.js.
//
// Unlike Cabrillo, an ADIF export from N1MM is close to lossless for our
// purposes: it carries OPERATOR, CONT, CQZ, plus N1MM's app-specific
// APP_N1MM_POINTS / APP_N1MM_MULT1..3 / APP_N1MM_ISRUNQSO. When those are
// present the analyzer shows points / multiplier / per-operator / run
// breakdowns; the flags below report what was actually found.
//
// ADIF field syntax: <NAME:LEN> or <NAME:LEN:TYPE>, value is the LEN
// characters immediately after '>'. Field names are case-insensitive.
// Header (if any) ends at <EOH>; records are separated by <EOR>.

const { canonicalBand } = require('./bands');

const ADIF_BAND_MHZ = {
  '2190m': '0.1357', '630m': '0.472', '160m': '1.8', '80m': '3.5', '60m': '5.3',
  '40m': '7', '30m': '10.1', '20m': '14', '17m': '18.1', '15m': '21',
  '12m': '24.9', '10m': '28', '8m': '40', '6m': '50', '5m': '60', '4m': '70',
  '2m': '144', '1.25m': '222', '70cm': '432', '33cm': '902', '23cm': '1240',
  '13cm': '2300', '9cm': '3300', '6cm': '5650', '3cm': '10000',
};

const MODE_MAP = {
  SSB: 'SSB', USB: 'SSB', LSB: 'SSB', CW: 'CW', FM: 'FM', AM: 'AM',
  RTTY: 'RTTY', PSK: 'PSK', PSK31: 'PSK', PSK63: 'PSK', FT8: 'FT8', FT4: 'FT4',
  MFSK: 'MFSK', JT65: 'JT65', JT9: 'JT9', DIGITALVOICE: 'DIGITAL', DIGI: 'DIGITAL',
};

function truthy(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === '1' || s === 'y' || s === 'yes' || s === 'true' || s === 't';
}

function normMode(mode, submode) {
  const m = String(mode || '').toUpperCase();
  if (m === 'MFSK' && String(submode || '').toUpperCase() === 'FT4') return 'FT4';
  return MODE_MAP[m] || m || '';
}

function bandToCanonical(band, freqMhz) {
  const f = parseFloat(freqMhz);
  if (!Number.isNaN(f) && f > 0) return canonicalBand(f) || String(f);
  const key = String(band || '').toLowerCase();
  const mhz = ADIF_BAND_MHZ[key];
  return mhz ? canonicalBand(mhz) || mhz : String(band || '');
}

function pad2(n) { return String(n).padStart(2, '0'); }

// "20250607" + "183012" | "1830" -> "2025-06-07 18:30:12"
function toTimestamp(qsoDate, timeOn) {
  const d = String(qsoDate || '').replace(/[^\d]/g, '');
  const t = String(timeOn || '').replace(/[^\d]/g, '');
  if (d.length !== 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} `
    + `${pad2(t.slice(0, 2) || '00')}:${pad2(t.slice(2, 4) || '00')}:${pad2(t.slice(4, 6) || '00')}`;
}

function splitRecords(text) {
  const s = String(text);
  const eoh = s.search(/<eoh>/i);
  const body = eoh === -1 ? s : s.slice(eoh + 5);
  return body.split(/<eor>/i);
}

function parseFields(record) {
  const out = {};
  const re = /<([A-Za-z0-9_]+):(\d+)(?::[^>]*)?>/g;
  let m;
  while ((m = re.exec(record)) !== null) {
    const name = m[1].toLowerCase();
    const len = parseInt(m[2], 10);
    const start = m.index + m[0].length;
    out[name] = record.slice(start, start + len);
  }
  return out;
}

function blankQso() {
  return {
    call: '', band: '', mode: '', operator: '', mycall: '',
    contestname: '', contestnr: '', rx_freq: '', tx_freq: '',
    countryprefix: '', wpxprefix: '', stationprefix: '', continent: '',
    snt: '', snt_nr: '', rcv: '', rcv_nr: '', gridsquare: '', exchange1: '',
    section: '', comment: '', op_name: '', power: '', misctext: '',
    zone: '', prec: '', ck: '', is_mult1: 0, is_mult2: 0, is_mult3: 0,
    points: 0, radio_nr: null, run1run2: '', is_run_qso: 0,
    station_name: '', sent_exchange: '', n1mm_timestamp: '', logged_at: '',
    excluded: 0,
  };
}

function parseAdif(text) {
  const meta = {
    format: 'adif', contest: '', station_call: '', operators: '',
    claimed_score: null,
  };
  const flags = {
    has_points: false, has_mults: false, has_operator: false, has_run_flag: false,
  };
  const qsos = [];
  const opSet = new Set();

  const records = splitRecords(text);
  for (const rec of records) {
    if (!/<call:/i.test(rec)) continue;
    const f = parseFields(rec);
    if (!f.call) continue;

    const q = blankQso();
    q.call = String(f.call).toUpperCase().trim();
    q.mycall = String(f.station_callsign || f.operator || '').toUpperCase().trim();
    q.operator = String(f.operator || '').toUpperCase().trim();
    q.band = bandToCanonical(f.band, f.freq);
    q.rx_freq = f.freq_rx || f.freq || '';
    q.tx_freq = f.freq || '';
    q.mode = normMode(f.mode, f.submode);
    q.n1mm_timestamp = toTimestamp(f.qso_date, f.time_on);
    q.logged_at = q.n1mm_timestamp;

    q.continent = String(f.cont || '').toUpperCase();
    q.zone = String(f.cqz || f.app_n1mm_cqz || '').trim();
    q.gridsquare = f.gridsquare || '';
    q.section = String(f.arrl_sect || f.app_n1mm_exchange1 || f.state || '').toUpperCase();
    q.countryprefix = String(f.app_n1mm_countryprefix || f.pfx || f.country || '').toUpperCase();
    q.snt_nr = f.stx_string || f.stx || '';
    q.rcv_nr = f.srx_string || f.srx || '';
    q.power = f.tx_pwr || f.rx_pwr || '';
    q.gridsquare = f.gridsquare || '';

    if (f.app_n1mm_points != null && f.app_n1mm_points !== '') {
      q.points = Number(f.app_n1mm_points) || 0;
      flags.has_points = true;
    }
    for (const k of ['app_n1mm_ismultiplier1', 'app_n1mm_mult1', 'app_n1mm_ismult1']) {
      if (f[k] != null) { q.is_mult1 = truthy(f[k]) ? 1 : 0; flags.has_mults = true; }
    }
    for (const k of ['app_n1mm_ismultiplier2', 'app_n1mm_mult2', 'app_n1mm_ismult2']) {
      if (f[k] != null) { q.is_mult2 = truthy(f[k]) ? 1 : 0; flags.has_mults = true; }
    }
    for (const k of ['app_n1mm_ismultiplier3', 'app_n1mm_mult3', 'app_n1mm_ismult3']) {
      if (f[k] != null) { q.is_mult3 = truthy(f[k]) ? 1 : 0; flags.has_mults = true; }
    }
    if (f.app_n1mm_isrunqso != null && f.app_n1mm_isrunqso !== '') {
      q.is_run_qso = truthy(f.app_n1mm_isrunqso) ? 1 : 0;
      q.run1run2 = String(f.app_n1mm_run1run2 || '');
      flags.has_run_flag = true;
    } else if (f.app_n1mm_run1run2 != null && f.app_n1mm_run1run2 !== '') {
      q.run1run2 = String(f.app_n1mm_run1run2);
      q.is_run_qso = q.run1run2 === '1' ? 1 : 0;
      flags.has_run_flag = true;
    }

    // N1MM marks a not-counted QSO with APP_N1MM_ISCLAIMEDQSO=0 (the ADIF
    // equivalent of a Cabrillo X-QSO line). Excluded from every stat; still
    // surfaced in the removed-QSO list.
    if (f.app_n1mm_isclaimedqso != null && f.app_n1mm_isclaimedqso !== ''
        && !truthy(f.app_n1mm_isclaimedqso)) {
      q.excluded = 1;
    }

    if (q.operator) { opSet.add(q.operator); flags.has_operator = true; }
    if (!meta.contest && f.contest_id) meta.contest = f.contest_id;
    if (!meta.station_call && q.mycall) meta.station_call = q.mycall;

    qsos.push(q);
  }

  if (opSet.size) meta.operators = [...opSet].join(' ');
  return { meta, qsos, flags };
}

module.exports = { parseAdif, bandToCanonical, normMode, toTimestamp, parseFields };
