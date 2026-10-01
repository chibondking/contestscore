// Builds tools/test-review/test-review.html: every test the suite runs, with
// its source, file:line, the commit that added it (git blame), and filters for
// the logger packet path (parsers, UDP pipeline, ingest) and tests added since
// v1.3.2 / v1.4.0.
//
//   node tools/test-review/build.js        (from the repo root)
//
// Runs the whole suite through reporter.mjs, which records each test's real
// file and line, so loop-generated tests are listed one by one.
const fs = require('fs'), path = require('path'), { execSync, spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '../..');
const HERE = __dirname;

function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? testFiles(p) : e.name.endsWith('.js') ? [p] : [];
  });
}
const run = spawnSync(process.execPath, ['--test', `--test-reporter=${path.join(HERE, 'reporter.mjs')}`, ...testFiles(path.join(REPO, 'test')).sort()],
  { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
const rows = run.stdout.split('\n').filter((l) => l.startsWith('{')).map(JSON.parse);
if (!rows.length) { console.error(run.stderr); process.exit(1); }

// suite paths: results arrive children-first; a suite claims the unclaimed items one level deeper in its file
const byFile = new Map();
for (const r of rows) {
  r.rel = path.relative(REPO, r.file); r.suites = [];
  if (!byFile.has(r.rel)) byFile.set(r.rel, []);
  const list = byFile.get(r.rel);
  if (r.kind === 'suite') {
    for (const c of list) if (!c.claimed && c.nesting === r.nesting + 1) { c.claimed = true; c.parent = r; }
  }
  list.push(r);
}
const pathOf = (r) => { const p = []; for (let s = r.parent; s; s = s.parent) p.unshift(s.name); return p; };

// source of the it(...) call starting at line:column, by bracket matching that skips strings/comments
const srcCache = new Map();
function extract(rel, line, col) {
  if (!srcCache.has(rel)) srcCache.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
  const text = srcCache.get(rel); const lines = text.split('\n');
  let i = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + (col - 1);
  const start = i; let depth = 0, seen = false;
  while (i < text.length) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (ch === '/' && nx === '*') { i = text.indexOf('*/', i) + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch; i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        else if (q === '`' && text[i] === '$' && text[i + 1] === '{') { let d = 1; i += 2; while (i < text.length && d) { if (text[i] === '{') d++; else if (text[i] === '}') d--; i++; } continue; }
        i++;
      }
      i++; continue;
    }
    if (ch === '(') { depth++; seen = true; }
    else if (ch === ')') { depth--; if (seen && depth === 0) { i++; break; } }
    i++;
  }
  let s = text.slice(start, i);
  if (text[i] === ';') s += ';';
  const indent = (lines[line - 1].match(/^\s*/) || [''])[0].length;
  return s.split('\n').map((l, k) => (k === 0 ? ' '.repeat(indent) + l : l)).map((l) => l.slice(Math.min(indent, l.match(/^\s*/)[0].length))).join('\n');
}

// git blame: which commit added each test's first line
const sinceV140 = new Set(execSync('git rev-list v1.4.0..HEAD', { cwd: REPO }).toString().split('\n').filter(Boolean));
const sinceV132 = new Set(execSync('git rev-list v1.3.2..HEAD', { cwd: REPO }).toString().split('\n').filter(Boolean));
const blame = new Map();
function blameLine(rel, line) {
  if (!blame.has(rel)) {
    const out = execSync(`git blame --line-porcelain -- ${rel}`, { cwd: REPO, maxBuffer: 64 << 20 }).toString().split('\n');
    const info = []; let cur = null; const meta = {};
    for (const l of out) {
      const m = l.match(/^([0-9a-f]{40}) \d+ (\d+)/);
      if (m) { cur = { sha: m[1], line: +m[2] }; continue; }
      if (!cur) continue;
      if (l.startsWith('author-time ')) cur.time = +l.slice(12);
      else if (l.startsWith('summary ')) cur.summary = l.slice(8);
      else if (l.startsWith('\t')) { info[cur.line] = cur; cur = null; }
    }
    blame.set(rel, info);
  }
  return blame.get(rel)[line];
}

const head = execSync('git rev-parse HEAD', { cwd: REPO }).toString().trim();
const tests = rows.filter((r) => r.kind === 'test').map((r, idx) => {
  const b = blameLine(r.rel, r.line) || {};
  const area = r.rel.split('/')[1];
  const loggerPath = /^test\/(parsers|udp)\//.test(r.rel) || r.rel === 'test/routes/ingest.test.js';
  return {
    id: `${r.rel}:${r.line}:${idx}`, file: r.rel, line: r.line, area, suites: pathOf(r), name: r.name, ok: r.ok,
    src: extract(r.rel, r.line, r.column),
    sha: (b.sha || '').slice(0, 7), date: b.time ? new Date(b.time * 1000).toISOString().slice(0, 10) : '', summary: b.summary || '',
    newSince140: sinceV140.has(b.sha), newSince132: sinceV132.has(b.sha), loggerPath,
  };
});
const sameLine = new Map(); for (const t of tests) sameLine.set(`${t.file}:${t.line}`, (sameLine.get(`${t.file}:${t.line}`) || 0) + 1);
for (const t of tests) t.generated = sameLine.get(`${t.file}:${t.line}`) > 1;
const data = JSON.stringify({ head, generatedAt: new Date().toISOString(), tests }).replace(/<\//g, '<\\/');
const page = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8').replace('__DATA__', () => data);
fs.writeFileSync(path.join(HERE, 'test-review.html'), page);
console.log(tests.length, 'tests;', tests.filter((t) => t.loggerPath).length, 'logger-path;', tests.filter((t) => t.newSince140).length, 'new since v1.4.0;', tests.filter((t) => t.newSince132).length, 'new since v1.3.2;', tests.filter((t) => t.generated).length, 'loop-generated');
console.log('wrote', path.relative(REPO, path.join(HERE, 'test-review.html')), `(${tests.filter((t) => t.ok).length}/${tests.length} passing)`);