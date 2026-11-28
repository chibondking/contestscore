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

  it('index.html and map.html carry the same map card, and nothing left unfilled', () => {
    const card = fs.readFileSync(path.join(__dirname, '../../public/partials/map-panel.html'), 'utf8');
    for (const page of ['index.html', 'map.html']) {
      const html = buildPage(page);
      assert.ok(html.includes(card), page);
      assert.equal(/#include/.test(html.replace(card, '')), false, page);
    }
  });
});
