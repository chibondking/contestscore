// HTML pages that share markup. A page includes a partial from
// public/partials/ with a comment on its own line:
//
//   <!-- #include map-panel -->
//
// and the server swaps in public/partials/map-panel.html when it serves the
// page. That's how the dashboard (/) and Map TV (/map) show the same map
// card from one copy of its markup -- the same idea as their scripts, which
// share public/js/live-feed.js and map-panel.js (see component.js).
//
// Every local script and stylesheet URL on a page also gets ?v=<build>
// (the deployed commit). Cloudflare tells browsers to keep /js and /css for
// hours, so without it a viewer kept running the old scripts after a
// deploy -- mixing old and new code (seen live, 2026-11-28, while the mult
// bell on Map TV was being chased). Same idea as ops-dashboard's ?v=.
//
// Pages are built once per process and kept: a deploy restarts it.
const fs = require('fs');
const path = require('path');
const { getVersionInfo } = require('./version');

const PUBLIC_DIR = path.join(__dirname, '../public');
const INCLUDE_RE = /<!--\s*#include\s+([a-z0-9-]+)\s*-->/g;
const ASSET_RE = /(\s(?:src|href)=")(\/(?:js|css)\/[^"?#]+)(")/g;

function assetVersion() {
  return getVersionInfo().commit || String(Date.now());
}

function buildPage(file, dir = PUBLIC_DIR, version = assetVersion()) {
  const html = fs.readFileSync(path.join(dir, file), 'utf8');
  const v = encodeURIComponent(version);
  return html
    .replace(INCLUDE_RE, (_, name) => fs.readFileSync(path.join(dir, 'partials', `${name}.html`), 'utf8'))
    .replace(ASSET_RE, (_, pre, url, post) => `${pre}${url}?v=${v}${post}`);
}

const built = new Map();

// An Express handler that serves one page, includes filled in.
function servePage(file) {
  return (_req, res) => {
    if (!built.has(file)) built.set(file, buildPage(file));
    res.type('html').send(built.get(file));
  };
}

module.exports = { buildPage, servePage };
