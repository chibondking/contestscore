// Do N1MM-format contact packets parse the same before and after a change?
//
//   node tools/test-review/compare-n1mm-parse.js [base-ref]   (from the repo root)
//
// base-ref defaults to 3cf5157^ (just before the DXLog native-broadcast
// change). Takes src/parsers/contact.js as of base-ref, then runs every
// <contactinfo>/<contactreplace> packet in the tests (skipping templated
// ones with ${...}) and the test/fixtures/dxlog/contact*.xml captures through
// both it and the working tree's parser, and compares the results field by
// field. DXLog native-format fixtures (native-*.xml) are left out on purpose:
// they're the format the change added, so they're expected to differ.
const fs = require('fs'), path = require('path'), assert = require('assert'), { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const base = process.argv[2] || '3cf5157^';
const oldPath = path.join(REPO, 'src/parsers/.contact.base.tmp.js'); // beside contact.js so its require('./util') resolves

fs.writeFileSync(oldPath, execSync(`git show ${base}:src/parsers/contact.js`, { cwd: REPO }));
const OLD = require(oldPath).parseContact;
const NEW = require(path.join(REPO, 'src/parsers/contact.js')).parseContact;

const sources = [];
const testFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? testFiles(path.join(dir, e.name)) : e.name.endsWith('.test.js') ? [path.join(dir, e.name)] : []);
for (const f of testFiles(path.join(REPO, 'test')).sort()) {
  const txt = fs.readFileSync(f, 'utf8');
  for (const m of txt.matchAll(/<(contactinfo|contactreplace)>[\s\S]*?<\/\1>/g)) {
    if (m[0].includes('${')) continue;
    sources.push([`${path.relative(REPO, f)}:${txt.slice(0, m.index).split('\n').length}`, m[0]]);
  }
}
const fx = path.join(REPO, 'test/fixtures/dxlog');
for (const f of fs.readdirSync(fx).filter((x) => /^contact.*\.xml$/.test(x)).sort())
  sources.push([`test/fixtures/dxlog/${f}`, fs.readFileSync(path.join(fx, f), 'utf8')]);

(async () => {
  let same = 0, diff = 0;
  try {
    for (const [where, xml] of sources) {
      let a, b;
      try { a = await OLD(Buffer.from(xml)); } catch (e) { a = 'ERR ' + e.message; }
      try { b = await NEW(Buffer.from(xml)); } catch (e) { b = 'ERR ' + e.message; }
      try { assert.deepStrictEqual(b, a); same++; console.log('same     ', where); }
      catch { diff++; console.log('DIFFERENT', where, '\n  base:', JSON.stringify(a), '\n  now: ', JSON.stringify(b)); }
    }
  } finally {
    fs.rmSync(oldPath, { force: true });
  }
  console.log(`\n${sources.length} N1MM-format contact packets vs ${base}: ${same} identical, ${diff} different`);
  process.exitCode = diff ? 1 : 0;
})();
