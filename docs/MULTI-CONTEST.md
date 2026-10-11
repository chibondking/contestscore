# Multiple contests in one weekend — effort study

**Status: shelved 2026-10-11 by CJ**, to revisit later in the week. Not
built, nothing started. CJ operates several contests in one weekend only
"when I'm exceptionally bored" (Makrothen's break periods, 2026-10-11),
so this is a convenience, not a gap in the realtime core.

The question that produced it: *what would it take for the dashboard to
support switching between the several contests running on one weekend?*

## The data is already tagged — the readers just ignore it

Every QSO row has carried `contestname` **and** `contestnr` since day one
(`src/db/schema.sql`), and every score snapshot has `contest`. N1MM tags
each packet with the log it came from and only ever broadcasts for the log
that's open, so several contests arrive as cleanly separated, correctly
labelled streams. **Ingest, parsing, storage and ContestPulse need no
changes at all** — the relay forwards bytes blind and never knew what a
contest was.

The entire gap is on the read side:

- `getQsos()` filters band/mode/operator only — `src/db/queries.js`
- `getLatestScore()` / `getScoreHistory()` / `getScoreBreakdown()` take the
  newest rows globally — same file
- the rate meter (`getQsoCountSince`) is time-windowed only
- the frontend has no notion of a contest; the one contest string on screen
  is `score.contest` in the header (`public/index.html`)

## What mixing four contests into one DB actually does today

Traced surface by surface, because it decides how urgent this is. It
degrades into something quietly wrong, not loudly broken:

| Surface | Behaviour with several contests in the DB |
|---|---|
| Score sparkline (`getScoreHistory`) | **Sawtooths** — interleaves `is_total` rows from different contests into one series |
| Score card (`getLatestScore`) | Whichever packet landed last: right by luck while operating, wrong the moment you switch back |
| Band/mode breakdown | `MAX(id) GROUP BY band, mode` silently merges contests |
| QSO list, Stats, Charts | All contests rendered as one log |
| Rate meter | Sums every contest (arguably "your rate", but not a contest's) |
| Mult bell "after N mults" | Counts mults across contests, so the threshold unmutes early |
| From-live snapshot | Labelled `topValue(contestname)` (`src/analyze/index.js`) while containing everything |
| Radio state, busts panel | Correct as-is — physical radios and data quality are contest-independent |

## The zero-code workaround (what to do until this is built)

At each switch: snapshot to the analyzer (`POST /api/analyze/from-live`,
the one-click "live" tab on `/analyze`), then `DELETE /api/db`. The live
view stays correct for whatever is being operated, and each finished
contest keeps full Stats/Charts at its own shareable `/analyze/<id>`.

Costs: the finished contest's *live* score sparkline is gone (a snapshot
stores QSOs + claimed score, not `score_snapshots`), and the reset drops
`radio_state`, which is what a reset is for.

## Phase 1 — contest scope + picker (the MVP)

**The design call that keeps this cheap: scope at the data boundary only,
never inside the derivations.** `dashboard.js`'s `scoreStale` /
`operatorStats` / `glanceStats` — and the TUI's deliberate copies of them
(see CLAUDE.md: *change one, change the other*) — all operate on whatever
array they're handed. Scope the fetch and they are correct for free, with
no duplication tax. Doing it the other way round means touching both
copies of every derivation.

Touch points:

- `src/db/queries.js` — optional `contest` param on ~5 statements, using
  the `@param IS NULL OR col = @param` idiom `getQsos` already uses; plus a
  `listContests()` grouping `qsos` by `contestnr` with name, count and
  first/last timestamps
- `src/routes/api.js` — `?contest=` on `/api/qsos`, `/api/score`,
  `/api/score/history`, `/api/rate`; new `GET /api/contests`
- `src/udp/index.js` — tag the `score:update` emission with the resolved
  contest key so clients can filter live events (`contact:new` already
  carries `contestnr`)
- `public/js/dashboard.js`, `public/index.html`, `public/js/chrome.js` — a
  header picker defaulting to **auto-follow** (track the newest QSO's
  contest), per-viewer persisted choice, and a filter on incoming socket
  events. `chrome.js` already carries `?log=` across nav links, so
  `?contest=` rides the same rail
- `public/js/stats.js`, `public/js/charts.js` — plumb the param; identical
  shape to the existing `?log=` hook
- `src/routes/analyze.js` — `contest` param on from-live, which makes
  "snapshot just this contest" exact
- `tui/index.js` — same scoping plus a switch key
- tests — `test/routes/api.test.js`, `test/db/queries.test.js`,
  `test/analyze/live.test.js`, `test/dashboard/dashboard.test.js`
- docs — CLAUDE.md (behaviour + scope note), `docs/ANALYZER.md`

**Estimate: ~400–600 lines across a dozen files plus tests, one focused
day.** Breadth, not depth; nothing architecturally hard.

## Phase 2 — half a day

Per-contest mult-bell counting, a "clear just this contest" reset, a
contest column/filter on the QSO list, the TUI switch key if it slipped.

## Cheapest useful subset — 1–2 hours

Auto-follow with no picker: the dashboard shows only the newest QSO's
contest. Fixes every wrong number in the table above for the screen
actually being watched, leaves the other contests intact in the DB for
later snapshots. No switching UI, no `/api/contests`, no TUI change.

## The one genuine unknown

`contactinfo` carries `contestname` + `contestnr`; `contactdelete` carries
**`contestnr` but not the name** (`src/parsers/contactDelete.js`), so
`contestnr` is the identity key — which the delete fallback already matches
on. But **score packets carry only the contest *name***
(`src/parsers/score.js`), no `contestnr`. So correlating a score snapshot
to a set of QSOs has to go through the name, and whether N1MM's
`<contest>` in `dynamicresults` is byte-identical to `contactinfo`'s
`<contestname>` is **unverified** — exactly the class of assumption that
earned CLAUDE.md's "do not trust field lists from memory" warning.

No capture tooling needed to settle it. After any weekend with more than
one contest logged, ask the database:

```sql
SELECT DISTINCT contestname, contestnr FROM qsos;
SELECT DISTINCT contest FROM score_snapshots;
```

If the strings line up, the name is a safe join key and Phase 1 is as
scoped above. If they don't, add a small observed-pairs mapping
(`contestnr` ↔ `contestname` seen together in the same packet stream) —
perhaps another 50 lines.

**Build Phase 1 against real multi-contest data, not against an assumption
about N1MM's string formatting.**
