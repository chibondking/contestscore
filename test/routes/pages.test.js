// src/pages.js: the dashboard and Map TV share the map card's markup
// through an include, filled in by the server.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPage } = require('../../src/pages');

describe('pages: shared partials', () => {
  it('fills an include with the partial', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
    fs.mkdirSync(path.join(dir, 'partials'));
    fs.writeFileSync(path.join(dir, 'partials', 'box.html'), '<div>box</div>\n');
    fs.writeFileSync(path.join(dir, 'p.html'), '<main>\n  <!-- #include box -->\n</main>\n');
    assert.equal(buildPage('p.html', dir), '<main>\n  <div>box</div>\n\n</main>\n');
  });

  it('index.html and map.html carry the same map card and mult bell, nothing left unfilled', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../public/partials', f), 'utf8');
    const parts = [read('map-panel.html'), read('mult-bell.html')];
    for (const page of ['index.html', 'map.html']) {
      let html = buildPage(page);
      for (const p of parts) {
        assert.ok(html.includes(p), page);
        html = html.replace(p, '');
      }
      assert.equal(/#include/.test(html), false, page);
    }
  });

  it('stamps every local script and stylesheet with the build, leaves CDN URLs alone', () => {
    for (const page of ['index.html', 'map.html', 'stats.html', 'admin.html']) {
      const html = buildPage(page, undefined, 'abc1234');
      const local = html.match(/(?:src|href)="\/(?:js|css)\/[^"]+"/g) || [];
      assert.ok(local.length > 0, page);
      for (const u of local) assert.match(u, /\?v=abc1234"$/, `${page}: ${u}`);
      assert.match(html, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/alpinejs@3\/dist\/cdn\.min\.js"/);
    }
  });
});
