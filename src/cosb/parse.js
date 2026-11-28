// Parsers for contestonlinescore.com (COSB) pages. COSB has no read API --
// only HTML -- so these read the markup as served (captured live during
// CQ WW CW 2026, test/fixtures/cosb/). Dependency-free and pure: hamdata
// and a standalone instance both use them through src/cosb/source.js.
//
// If COSB changes its layout, these return fewer/empty results rather than
// throwing on a partial page; the caller treats "no sections" as "nothing
// to show", never as wrong numbers.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

function decode(s) {
  return String(s).replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k in ENTITIES) return ENTITIES[k];
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });
}

function text(html) {
  return decode(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function num(s) {
  const n = parseInt(String(s).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function cells(html) {
  return [...String(html).matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
}

// The contest picker on every COSB page:
//   <option value='56' selected style='color: red;'>On air: CQ WW CW</option>
// -> [{ id: 56, name: 'CQ WW CW', status: 'on_air' | 'coming' | 'closed' }]
function parseContestList(html) {
  const out = [];
  const sel = String(html).match(/<select[^>]*name=['"]contest_id['"][^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return out;
  for (const m of sel[1].matchAll(/<option\s+value=['"](\d+)['"][^>]*>([^<]*)/gi)) {
    const label = text(m[2]);
    const st = label.match(/^(On air|Coming|Closed)\s*:\s*(.*)$/i);
    if (!st) continue;
    out.push({
      id: Number(m[1]),
      name: st[2].trim(),
      status: st[1].toLowerCase().replace(' ', '_'),
    });
  }
  return out;
}

// /settings/ "Supported Contests": # | Contest Name | Contest ID | Mult 1 ...
// "Contest ID" is the logger's contest name (N1MM's CQ-WW-CW), which is what
// a dynamicresults <contest> carries. One logger id can map to several COSB
// contests (CW-Ops -> CWops Mini-CWT 1..4).
// -> [{ name: 'CQ WW CW', loggerId: 'CQ-WW-CW' }]
function parseSupported(html) {
  const out = [];
  for (const m of String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const c = cells(m[1]).map(text);
    if (c.length >= 3 && /^\d+$/.test(c[0]) && c[1] && c[2]) {
      out.push({ name: c[1], loggerId: c[2] });
    }
  }
  return out;
}

// Case/punctuation-blind key: "CQ-WW-CW", "cq ww cw" -> "CQWWCW".
function contestKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Which COSB contest a logger's <contest> name means right now: the on-air
// entry whose name the supported list maps that logger id to; failing
// that, an on-air entry whose own name matches the logger id directly.
// null when nothing on air matches.
function resolveContest(loggerContest, list, supported) {
  const key = contestKey(loggerContest);
  if (!key) return null;
  const onAir = list.filter((c) => c.status === 'on_air');
  const names = new Set(
    supported.filter((s) => contestKey(s.loggerId) === key).map((s) => contestKey(s.name)),
  );
  return onAir.find((c) => names.has(contestKey(c.name)))
    || onAir.find((c) => contestKey(c.name) === key)
    || null;
}

// The COSB contest a logger contest name maps to, whatever its status --
// on air first, then coming, then the most recent closed one (the picker
// lists newest first). COSB accepts posts only while a contest is on air,
// so the publisher asks this before sending. null = COSB doesn't know it.
const STATUS_RANK = { on_air: 0, coming: 1, closed: 2 };
function findContest(loggerContest, list, supported) {
  const key = contestKey(loggerContest);
  if (!key) return null;
  const names = new Set(
    supported.filter((s) => contestKey(s.loggerId) === key).map((s) => contestKey(s.name)),
  );
  const hits = list.filter((c) => names.has(contestKey(c.name)) || contestKey(c.name) === key);
  if (!hits.length) return null;
  return hits.reduce((best, c) => ((STATUS_RANK[c.status] ?? 3) < (STATUS_RANK[best.status] ?? 3) ? c : best));
}

// The scoreboard page: one table per category, each opened by a
// <tr class="title5"> header ("M/M HP", "SO-ALL LP (A) CW", ...) and
// followed by <tr class="tbl1|tbl2"> station rows:
//   Rank | Call [(Op)] | Score | QSO | [Mult | Countries | Zones] | Last | Club | Log
// The mult block is a nested table; its first figure is the total.
// -> { updated: '28 Nov 2026 05:19 UTC' | null, sections: [{ label, rows }] }
function parseScoreboard(html) {
  const s = String(html);
  const upd = s.match(/class="title3">\s*(\d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2} UTC)\s*</);
  const sections = [];
  const parts = s.split(/<tr class="title5"/i);
  for (const part of parts.slice(1)) {
    // The header row ends where the column titles start ("Score").
    const head = part.split(/<td\b[^>]*>\s*Score\b/i)[0];
    // Tags dropped without a space: the header is "SO-<a>ALL</a> ...".
    const label = decode(head.replace(/^[^>]*>/, '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const rows = [];
    const chunks = part.split(/<tr class="tbl[12]"[^>]*>/i).slice(1);
    for (const chunk of chunks) {
      const row = parseRow(chunk);
      if (row) rows.push(row);
    }
    sections.push({ label, rows });
  }
  return { updated: upd ? upd[1] : null, sections };
}

function parseRow(chunk) {
  const callM = chunk.match(/\/tools\/rate\/\?call=([A-Z0-9/]+)/i);
  if (!callM) return null;
  let mults = [];
  const inner = chunk.match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
  let outer = chunk;
  if (inner) {
    mults = cells(inner[1]).map(text).map(num);
    outer = chunk.replace(inner[0], '');
  }
  const c = cells(outer);
  const t = c.map(text);
  const rank = num(t[0]);
  if (rank == null) return null;
  // "TI7W (N4YDU)" -- the parenthesised call is the operator.
  const shown = t[1] || '';
  const opM = shown.match(/\(([A-Z0-9/]+)\)/i);
  const lastIdx = t.findIndex((v, i) => i > 3 && /^\d{1,3}:\d{2}$/.test(v));
  const after = lastIdx >= 0 ? t.slice(lastIdx + 1) : [];
  return {
    rank,
    call: callM[1].toUpperCase(),
    op: opM ? opM[1].toUpperCase() : null,
    score: num(t[2]),
    qsos: num(t[3]),
    mult: mults.length ? mults[0] : null,
    mults: mults.slice(1),
    last: lastIdx >= 0 ? t[lastIdx] : null,
    club: after[1] || null,
    log: t.length ? t[t.length - 1] || null : null,
  };
}

module.exports = { parseContestList, parseSupported, parseScoreboard, resolveContest, findContest, contestKey };
