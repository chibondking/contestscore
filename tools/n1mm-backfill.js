#!/usr/bin/env node
/**
 * Backfill a live scoreboard from N1MM's own log database.
 *
 * ContestPulse only relays what N1MM broadcasts while it's running, and N1MM
 * has no "re-broadcast the log" button -- so QSOs logged before the bridge
 * came up (operator arrived late, PC rebooted, bridge crashed) never reach
 * the board. This reads them straight out of N1MM's .s3db (a plain SQLite
 * file: Documents\N1MM Logger+\Databases\) and POSTs each one to
 * /api/ingest/contact as the same <contactinfo> packet N1MM would have sent.
 *
 * Safe to run at any time, and to re-run: every QSO carries N1MM's own <ID>
 * GUID (DXLOG.ID is the same value N1MM broadcasts), and the server upserts
 * by it -- a QSO already on the board is updated in place, never doubled,
 * and later live edits/deletes still find it. Deleted QSOs aren't sent:
 * N1MM moves those to its DELETEDQS contest (ContestNR -1).
 *
 * Packets are tagged <app>ContestScore-Backfill</app>, which tells the
 * server to keep N1MM's own timestamp as the QSO's logged_at (see
 * src/parsers/contact.js) so the rate meter and charts aren't spiked with
 * hundreds of "just now" QSOs. Old QSOs don't ring the mult bell (it skips
 * anything over 15 min old). Reload any open dashboard afterwards: live
 * clients prepend each QSO as it arrives, so the list order is only right
 * after a fresh load.
 *
 * One .s3db holds every contest that database has ever logged; pick one by
 * its ContestNR. With no --contest, this lists them and exits.
 *
 * Needs Node 22.13+ (built-in node:sqlite; 22.5-22.12 need
 * --experimental-sqlite) -- no npm install.
 *
 * Usage:
 *   node tools/n1mm-backfill.js <log.s3db>                       # list contests
 *   node tools/n1mm-backfill.js <log.s3db> --contest latest --dry-run
 *   node tools/n1mm-backfill.js <log.s3db> --contest 38 \
 *        --api https://scoreboard.example.org --token <t>
 *
 *   --contest <nr|latest>  ContestNR from the listing, or "latest" (the
 *                          newest contest that has QSOs).
 *   --api <url>            contestscore base URL. Required to send; no
 *                          default, so it never writes anywhere by habit.
 *   --token <t>            Bearer token (the instance's CONTESTSCORE_API_TOKEN).
 *                          Default: $CONTESTSCORE_API_TOKEN.
 *   --mycall <call>        <mycall> to send. Default: the database's Station call.
 *   --dry-run              Print the count and the first packet; send nothing.
 */

'use strict';

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

const BACKFILL_APP = 'ContestScore-Backfill';

const esc = (v) => String(v == null ? '' : v).trim()
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// DXLOG.Freq is kHz; N1MM broadcasts rxfreq/txfreq in tens of Hz.
const tensOfHz = (khz) => (khz ? Math.round(Number(khz) * 100) : 0);
// DXLOG.Band is a float (7.0, 3.5); the broadcast sends "7", "3.5".
const bandStr = (b) => (b == null || b === '' ? '' : String(Number(b)));
const n = (v) => (v == null || v === '' ? 0 : Number(v) || 0);

// One DXLOG row -> the <contactinfo> N1MM broadcasts for it.
function contactPacket(r, { mycall, sentExchange }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<contactinfo>
  <app>${BACKFILL_APP}</app>
  <contestname>${esc(r.ContestName)}</contestname>
  <contestnr>${esc(r.ContestNR)}</contestnr>
  <timestamp>${esc(r.TS)}</timestamp>
  <mycall>${esc(mycall)}</mycall>
  <band>${bandStr(r.Band)}</band>
  <rxfreq>${tensOfHz(r.Freq)}</rxfreq>
  <txfreq>${tensOfHz(r.QSXFreq || r.Freq)}</txfreq>
  <operator>${esc(r.Operator)}</operator>
  <mode>${esc(r.Mode)}</mode>
  <call>${esc(r.Call)}</call>
  <countryprefix>${esc(r.CountryPrefix)}</countryprefix>
  <wpxprefix>${esc(r.WPXPrefix)}</wpxprefix>
  <stationprefix>${esc(r.StationPrefix)}</stationprefix>
  <continent>${esc(r.Continent)}</continent>
  <snt>${esc(r.SNT)}</snt>
  <sntnr>${n(r.SentNr)}</sntnr>
  <rcv>${esc(r.RCV)}</rcv>
  <rcvnr>${n(r.NR)}</rcvnr>
  <gridsquare>${esc(r.GridSquare)}</gridsquare>
  <exchange1>${esc(r.Exchange1)}</exchange1>
  <section>${esc(r.Sect)}</section>
  <comment>${esc(r.Comment)}</comment>
  <qth>${esc(r.QTH)}</qth>
  <name>${esc(r.Name)}</name>
  <power>${esc(r.Power)}</power>
  <misctext>${esc(r.MiscText)}</misctext>
  <zone>${n(r.ZN)}</zone>
  <prec>${esc(r.Prec)}</prec>
  <ck>${n(r.CK)}</ck>
  <ismultiplier1>${n(r.IsMultiplier1) ? 1 : 0}</ismultiplier1>
  <ismultiplier2>${n(r.IsMultiplier2) ? 1 : 0}</ismultiplier2>
  <ismultiplier3>${n(r.isMultiplier3) ? 1 : 0}</ismultiplier3>
  <points>${n(r.Points)}</points>
  <radionr>${r.RadioNR == null ? 1 : n(r.RadioNR)}</radionr>
  <run1run2>${n(r.Run1Run2)}</run1run2>
  <RoverLocation>${esc(r.RoverLocation)}</RoverLocation>
  <RadioInterfaced>${n(r.RadioInterfaced)}</RadioInterfaced>
  <NetworkedCompNr>${n(r.NetworkedCompNr)}</NetworkedCompNr>
  <IsOriginal>${r.IsOriginal == null || n(r.IsOriginal) ? 'True' : 'False'}</IsOriginal>
  <NetBiosName>${esc(r.NetBiosName)}</NetBiosName>
  <IsRunQSO>${n(r.IsRunQSO) ? 1 : 0}</IsRunQSO>
  <StationName>${esc(r.NetBiosName)}</StationName>
  <ID>${esc(r.ID)}</ID>
  <IsClaimedQso>${r.CLAIMEDQSO == null || n(r.CLAIMEDQSO) ? 1 : 0}</IsClaimedQso>
  <SentExchange>${esc(sentExchange)}</SentExchange>
</contactinfo>`;
}

function listContests(db) {
  return db.prepare(`
    SELECT ci.ContestNR AS nr, ci.ContestName AS name, ci.StartDate AS start,
           COUNT(d.ID) AS qsos, MIN(d.TS) AS first, MAX(d.TS) AS last
    FROM ContestInstance ci
    LEFT JOIN DXLOG d ON d.ContestNR = ci.ContestNR
    WHERE ci.ContestNR >= 0
    GROUP BY ci.ContestNR
    ORDER BY ci.ContestNR
  `).all();
}

async function main() {
  const file = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
  if (!file) {
    console.error('usage: node tools/n1mm-backfill.js <log.s3db> [--contest <nr|latest>] [--api <url>] [--dry-run]');
    process.exit(2);
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const contests = listContests(db);

  const want = opt('contest', null);
  if (!want) {
    console.log('ContestNR  Contest      Start                QSOs  First QSO            Last QSO');
    for (const c of contests) {
      console.log(`${String(c.nr).padStart(9)}  ${String(c.name).padEnd(11)}  ${String(c.start || '').padEnd(19)}  ${String(c.qsos).padStart(4)}  ${(c.first || '').padEnd(19)}  ${c.last || ''}`);
    }
    console.log('\nPick one with --contest <ContestNR> (or --contest latest).');
    return;
  }

  const contest = want === 'latest'
    ? [...contests].reverse().find((c) => c.qsos > 0)
    : contests.find((c) => String(c.nr) === String(want));
  if (!contest) {
    console.error(`No contest ${want} in ${file}. Run without --contest to list them.`);
    process.exit(1);
  }

  const station = db.prepare('SELECT Call FROM Station LIMIT 1').get();
  const mycall = opt('mycall', station ? station.Call : '');
  const instance = db.prepare('SELECT SentExchange FROM ContestInstance WHERE ContestNR = ?').get(contest.nr);
  const sentExchange = instance ? instance.SentExchange : '';
  const rows = db.prepare('SELECT * FROM DXLOG WHERE ContestNR = ? ORDER BY TS').all(contest.nr);

  console.log(`${contest.name} (ContestNR ${contest.nr}): ${rows.length} QSOs, ${contest.first} -> ${contest.last} UTC, mycall ${mycall}`);
  if (!rows.length) return;

  if (flag('dry-run')) {
    console.log('\nFirst packet:\n' + contactPacket(rows[0], { mycall, sentExchange }));
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
          body: contactPacket(r, { mycall, sentExchange }),
        });
        if (res.status < 500 || attempt >= 5) break;
      } catch (err) {
        if (attempt >= 5) throw err;
      }
      await new Promise((ok) => setTimeout(ok, 1000 * attempt));
    }
    if (res.status !== 202) {
      console.error(`\n${r.TS} ${r.Call}: HTTP ${res.status} ${await res.text()}`);
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

module.exports = { contactPacket, BACKFILL_APP };
