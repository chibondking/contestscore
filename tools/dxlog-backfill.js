#!/usr/bin/env node
/**
 * Backfill a live scoreboard from a DXLog.net log file -- the DXLog
 * counterpart of n1mm-backfill.js, for QSOs logged before the bridge came up.
 *
 * A DXLog log (.dxn) is a plain SQLite file holding ONE contest (named in
 * headerinfo), so unlike N1MM's .s3db there's no contest to pick. This reads
 * qsodata + qsodatacalc and POSTs each QSO to /api/ingest/contact in DXLog's
 * own native broadcast shape (<guid>, <stationid>, <exch1>, <mult1>...),
 * which src/parsers/contact.js already understands -- no server change.
 *
 * What the .dxn stores, and how it maps (checked against a real DBVersion 7
 * file, CQ WW SSB 2026-10-25):
 *   - qsoguid is the 16 raw bytes of a .NET Guid, in .NET's mixed-endian
 *     order (Guid.ToByteArray). Read that way every QSO is a well-formed v4
 *     GUID; read as-is the version nibble is random. Sent as 32 lowercase
 *     hex digits, the same shape as the broadcast's <guid>. NOT yet confirmed
 *     equal to the live broadcast's <guid> for the same QSO -- if it isn't, a
 *     backfilled QSO and a later live edit of it would show as two rows.
 *   - mult1/mult2/mult3 hold the QSO's multiplier *value* on every QSO (two
 *     VE QSOs on 40m both say VE); whether it was a NEW mult is
 *     qsodatacalc.multkey, a bitmask (1 = mult1, 2 = mult2, 4 = mult3). A
 *     native <multN> means "is a mult" when non-empty, so only the new ones
 *     are sent.
 *   - band is meters ("20"); the band sent is derived from the frequency
 *     (kHz) via src/analyze/bands.js, so it buckets like everything else.
 *   - qsotime is "2026-10-25 22:29:27.6126261Z" (UTC); trimmed to N1MM's
 *     "YYYY-MM-DD HH:MM:SS".
 *   - rcvd is the whole received string ("59  09"): a leading RST goes to
 *     <rcv>, the rest to <exch1>.
 *   - xqso / invalidqso -> X-QSO. DXLog has no deletes, so nothing to skip.
 *   - Run/S&P isn't sent: the file has no field that's clearly it.
 *   - QTCs (qtcdata, WAE) aren't sent.
 *
 * Tagged <app>ContestScore-Backfill</app>, so the server keeps DXLog's own
 * time as logged_at (see n1mm-backfill.js). Safe to re-run: the server
 * upserts by the guid. Reload any open dashboard afterwards.
 *
 * Needs Node 22.13+ (built-in node:sqlite) -- no npm install.
 *
 * Usage:
 *   node tools/dxlog-backfill.js <log.dxn> --dry-run
 *   node tools/dxlog-backfill.js <log.dxn> --api https://scoreboard.example.org --token <t>
 *
 *   --api <url>      contestscore base URL. Required to send; no default.
 *   --token <t>      Bearer token. Default: $CONTESTSCORE_API_TOKEN.
 *   --mycall <call>  <mycall> to send. Default: the log's own Callsign.
 *   --dry-run        Print the count and the first packet; send nothing.
 */

'use strict';

const { canonicalBand } = require('../src/analyze/bands');

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

const BACKFILL_APP = 'ContestScore-Backfill';

const esc = (v) => String(v == null ? '' : v).trim()
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bool = (v) => (Number(v) ? 'True' : 'False');

// .NET Guid.ToByteArray() order: the first three groups little-endian.
function guidHex(buf) {
  if (!buf || buf.length !== 16) return '';
  const b = Buffer.from(buf);
  const le = (s, e) => Buffer.from(b.subarray(s, e)).reverse().toString('hex');
  return le(0, 4) + le(4, 6) + le(6, 8) + b.subarray(8).toString('hex');
}

// "2026-10-25 22:29:27.6126261Z" -> "2026-10-25 22:29:27"
const n1mmTime = (t) => String(t || '').replace('T', ' ').slice(0, 19);

// "59  09" -> { rcv: '59', exch: '09' }; "CHAS 178" -> { rcv: '', exch: 'CHAS 178' }
function splitRcvd(rcvd) {
  const parts = String(rcvd || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length && /^[1-5][1-9][1-9]?$/.test(parts[0])) return { rcv: parts[0], exch: parts.slice(1).join(' ') };
  return { rcv: '', exch: parts.join(' ') };
}

// One qsodata + qsodatacalc row -> DXLog's native <contactinfo>.
function contactPacket(r, { mycall, contest }) {
  const { rcv, exch } = splitRcvd(r.rcvd);
  const mk = Number(r.multkey) || 0;
  const tensOfHz = r.frequency ? Math.round(Number(r.frequency) * 100) : 0;
  const xqso = Number(r.xqso) || Number(r.invalidqso);
  return `<?xml version="1.0" encoding="utf-8"?>
<contactinfo>
  <app>${BACKFILL_APP}</app>
  <logger>DXLog.net</logger>
  <contestname>${esc(contest)}</contestname>
  <timestamp>${esc(n1mmTime(r.qsotime))}</timestamp>
  <mycall>${esc(mycall)}</mycall>
  <band>${esc(r.frequency ? canonicalBand(Number(r.frequency) / 1000) : '')}</band>
  <txfreq>${tensOfHz}</txfreq>
  <rxfreq>${tensOfHz}</rxfreq>
  <operator>${esc(r.operator)}</operator>
  <mode>${esc(r.mode)}</mode>
  <call>${esc(r.callsign)}</call>
  <countryprefix>${esc(r.dxcc)}</countryprefix>
  <snt>${esc(r.sent)}</snt>
  <rcv>${esc(rcv)}</rcv>
  <nr>${Number(r.nr) || 0}</nr>
  <exch1>${esc(exch)}</exch1>
  <exch2>${esc(r.recinfo)}</exch2>
  <exch3>${esc(r.recinfo2)}</exch3>
  <exch4>${esc(r.recinfo3)}</exch4>
  <xqso>${bool(xqso)}</xqso>
  <stationid>${esc(r.originstnid)}</stationid>
  <mult1>${mk & 1 ? esc(r.mult1) : ''}</mult1>
  <mult2>${mk & 2 ? esc(r.mult2) : ''}</mult2>
  <mult3>${mk & 4 ? esc(r.mult3) : ''}</mult3>
  <points>${xqso ? 0 : Number(r.points) || 0}</points>
  <period>${Number(r.period) || 1}</period>
  <guid>${guidHex(r.qsoguid)}</guid>
</contactinfo>`;
}

async function main() {
  const file = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (!file) {
    console.error('usage: node tools/dxlog-backfill.js <log.dxn> [--api <url> --token <t>] [--dry-run]');
    process.exit(2);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });

  const header = Object.fromEntries(db.prepare('SELECT hdrname, hdrvalue FROM headerinfo').all()
    .map((h) => [h.hdrname, h.hdrvalue]));
  const contest = header.ContestName || '';
  const mycall = opt('mycall', header.Callsign || '');
  const rows = db.prepare(`
    SELECT q.*, c.points, c.mult1, c.mult2, c.mult3, c.dxcc, c.invalidqso, c.multkey
    FROM qsodata q LEFT JOIN qsodatacalc c ON c.idqso = q.idqso
    ORDER BY q.qsotime
  `).all();

  const first = rows.length ? n1mmTime(rows[0].qsotime) : '';
  const last = rows.length ? n1mmTime(rows[rows.length - 1].qsotime) : '';
  console.log(`${contest} (${header.ContestMode || '?'}): ${rows.length} QSOs, ${first} -> ${last} UTC, mycall ${mycall}`);
  if (!rows.length) return;

  if (flag('dry-run')) {
    console.log('\nFirst packet:\n' + contactPacket(rows[0], { mycall, contest }));
    return;
  }

  const api = opt('api', null);
  const token = opt('token', process.env.CONTESTSCORE_API_TOKEN);
  if (!api) { console.error('--api <url> is required to send (or use --dry-run).'); process.exit(2); }
  if (!token) { console.error('--token (or CONTESTSCORE_API_TOKEN) is required.'); process.exit(2); }
  const url = `${api.replace(/\/$/, '')}/api/ingest/contact`;

  // Oldest first: a live dashboard prepends each one, so the newest ends on top.
  let sent = 0;
  for (const r of rows) {
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/xml' },
          body: contactPacket(r, { mycall, contest }),
        });
        if (res.status < 500 || attempt >= 5) break;
      } catch (err) {
        if (attempt >= 5) throw err;
      }
      await new Promise((ok) => setTimeout(ok, 1000 * attempt));
    }
    if (res.status !== 202) {
      console.error(`\n${n1mmTime(r.qsotime)} ${r.callsign}: HTTP ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    sent++;
    if (sent % 50 === 0 || sent === rows.length) process.stdout.write(`\r${sent}/${rows.length} sent`);
  }
  console.log('\nDone. Reload any open dashboard so the QSO list is in order.');
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}

module.exports = { contactPacket, guidHex, splitRcvd };
