#!/usr/bin/env node
/**
 * Capture a contestscore instance's current state to a JSON snapshot that
 * tools/demo/replay.js can play back as live UDP traffic.
 *
 * Pulls only public GET endpoints -- no token needed, nothing written to
 * the source.
 *
 * Usage:
 *   node tools/demo/snapshot.js [--api <url>] [--out <file>]
 *
 *   --api   Base URL. Default: https://scoreboard.wt2p.us
 *   --out   Output path. Default: tools/demo/snapshot-<UTC timestamp>.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const API = opt('api', 'https://scoreboard.wt2p.us').replace(/\/$/, '');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const OUT = opt('out', path.join(__dirname, `snapshot-${stamp}.json`));

const PATHS = [
  '/api/qsos',
  '/api/score/history',
  '/api/score',
  '/api/radios',
  '/api/solar',
  '/api/version',
  '/api/features',
];

(async () => {
  const out = { capturedAt: new Date().toISOString(), source: API };
  for (const p of PATHS) {
    try {
      const r = await fetch(API + p);
      out[p] = r.ok ? await r.json() : { __status: r.status };
    } catch (e) {
      out[p] = { __error: e.message };
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const q = out['/api/qsos'] || [];
  const sh = out['/api/score/history'] || [];
  const span = q.length
    ? `${q.map((x) => x.n1mm_timestamp || x.logged_at).sort()[0]} → `
      + `${q.map((x) => x.n1mm_timestamp || x.logged_at).sort().slice(-1)[0]}`
    : '(none)';
  console.log(`saved ${OUT}`);
  console.log(`  ${q.length} QSOs   ${sh.length} score rows`);
  console.log(`  ops:   ${[...new Set(q.map((x) => x.operator))].join(', ') || '(none)'}`);
  console.log(`  bands: ${[...new Set(q.map((x) => x.band))].join(', ') || '(none)'}`);
  console.log(`  span:  ${span}`);
})();
