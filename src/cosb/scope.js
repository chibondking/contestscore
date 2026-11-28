// Scope for the COSB standings (CJ, 2026-11-28): rank this station within
// its category among only the stations in one part of the world -- a
// continent or a CQ zone -- instead of the whole board.
//
// COSB itself filters by continent only, through a per-browser cookie, so
// the board is filtered here instead: every station's place comes from its
// callsign.
//
//   continent  the country file (cty.csv), which is exact for continents
//   CQ zone    our callsign lookup (HamQTH, cached and synced across boxes)
//              when we have one -- big countries (W, VE, UA, VK...) span
//              several zones -- else the country file's zone for the call
//
// A station whose place can't be told is left out of a scoped view, never
// guessed into one.
//
// ARRL divisions are not here yet: they need each station's ARRL section,
// which a state alone doesn't settle (CA, NY and NJ are split).

const CONTINENTS = ['NA', 'SA', 'EU', 'AS', 'AF', 'OC'];
const SCOPE_RE = /^(world|cont:(NA|SA|EU|AS|AF|OC)|zone:([1-9]|[1-3][0-9]|40))$/;
const LOCATE_TTL_MS = 10 * 60000; // a fresh lookup can sharpen a zone

function isScope(s) { return SCOPE_RE.test(String(s || '')); }

// "cont:EU" -> "EU", "zone:5" -> "Zone 5", "world" -> "World".
function scopeLabel(scope) {
  if (!scope || scope === 'world') return 'World';
  const [kind, v] = scope.split(':');
  return kind === 'zone' ? `Zone ${v}` : v;
}

// call -> { continent, zone } (either may be null), memoised for a while.
// resolveCall: the country file (src/analyze/geo.js); getCachedLocation:
// the callsign cache (src/db/queries.js). Both injectable for tests.
function createLocator({ resolveCall, getCachedLocation, now = Date.now }) {
  const memo = new Map();
  return function locate(call) {
    const hit = memo.get(call);
    if (hit && now() - hit.at < LOCATE_TTL_MS) return hit.loc;
    let cty = null;
    let cached = null;
    try { cty = resolveCall(call); } catch { /* unknown prefix */ }
    try { cached = getCachedLocation(call) || getCachedLocation(String(call).split('/')[0]); } catch { /* no cache */ }
    const zone = parseInt((cached && cached.cqzone) || (cty && cty.cqzone) || '', 10);
    const continent = String((cty && cty.continent) || (cached && cached.continent) || '').toUpperCase();
    const loc = {
      continent: CONTINENTS.includes(continent) ? continent : null,
      zone: zone >= 1 && zone <= 40 ? zone : null,
    };
    memo.set(call, { at: now(), loc });
    return loc;
  };
}

function inScope(loc, scope) {
  if (!scope || scope === 'world') return true;
  const [kind, v] = scope.split(':');
  if (kind === 'cont') return loc.continent === v;
  if (kind === 'zone') return loc.zone === Number(v);
  return false;
}

// The board with every category cut down to the stations in `scope` and
// re-ranked 1..n. Each row keeps COSB's own rank as `board_rank`. `keep`
// (our call) stays in even when it's outside the scope -- so picking EU
// from NA still shows EU's leaders against us -- marked `outside`, with no
// rank and not counted.
function scopeBoard(st, scope, locate, keep = null) {
  if (!st || !st.sections || !scope || scope === 'world') return st;
  return {
    ...st,
    sections: st.sections.map((sec) => {
      let n = 0;
      const rows = [];
      for (const r of sec.rows) {
        if (inScope(locate(r.call), scope)) rows.push({ ...r, board_rank: r.rank, rank: ++n });
        else if (r.call === keep) rows.push({ ...r, board_rank: r.rank, rank: null, outside: true });
      }
      return { ...sec, rows };
    }),
  };
}

// The scopes worth offering for one category: the continents and zones its
// stations are in, each with how many. -> { continents: [{ scope, label,
// count }], zones: [...] }
function scopeChoices(section, locate) {
  const conts = new Map();
  const zones = new Map();
  for (const r of (section && section.rows) || []) {
    const loc = locate(r.call);
    if (loc.continent) conts.set(loc.continent, (conts.get(loc.continent) || 0) + 1);
    if (loc.zone) zones.set(loc.zone, (zones.get(loc.zone) || 0) + 1);
  }
  return {
    continents: CONTINENTS.filter((c) => conts.has(c)).map((c) => ({ scope: `cont:${c}`, label: c, count: conts.get(c) })),
    zones: [...zones.keys()].sort((a, b) => a - b).map((z) => ({ scope: `zone:${z}`, label: `Zone ${z}`, count: zones.get(z) })),
  };
}

module.exports = { CONTINENTS, isScope, scopeLabel, createLocator, inScope, scopeBoard, scopeChoices };
