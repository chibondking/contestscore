# Log Analyzer

A second, **offline** path alongside the realtime dashboard: take a whole
contest log — however you have it — parse it into the same per-QSO array
the Stats and Charts pages already consume, save it, and hand back a
shareable `https://<host>/analyze/<id>` link that renders through those
exact pages.

It reuses the dashboard's rendering wholesale. `stats.js` and `charts.js`
grew one hook — a `?log=<id>` query param — and when it's set they fetch
`GET /api/analyze/<id>` instead of the live feed, skip all socket/poll
wiring, and hide the sections the source couldn't populate. There is no
separate "analysis engine".

## Three ways in

All three land in the same place (a stored `analyzed_logs` row) and are
equivalent from then on. Uploading / entering / snapshotting all require
the `CONTESTSCORE_API_TOKEN` bearer token (pasted on the page, same secret
as `DELETE /api/db`); **viewing** a saved analysis is public.

| Source | How | Fidelity |
| --- | --- | --- |
| **Upload ADIF** (`.adi`, N1MM export) | file picker / drag-drop | full — `APP_N1MM_POINTS` / `MULT1..3` / `ISRUNQSO` / `OPERATOR` / `CONT` / `CQZ` all come through |
| **Upload Cabrillo** (`.cbr` / `.log`) | file picker / drag-drop | band / mode / time / rate / dupes / call-length + continent·DXCC·zone (from cty.dat) + section·serial·grid·name (from the per-contest exchange map). **No** points / multipliers / per-operator / run — a submitted Cabrillo doesn't carry them |
| **Enter manually** | header fields + a paste box, `[HHMM] [band] CALL [their exchange…]` per line | same as Cabrillo — the form is turned into a Cabrillo string client-side (`public/js/manual.js`) and POSTed to the normal upload route |
| **Snapshot the live contest** | one button, `POST /api/analyze/from-live` | **full** — it copies the realtime `qsos` table, which is the complete N1MM feed. Nothing to export |

### Capability matrix

| Section | full-fidelity source | generic Cabrillo / manual |
| --- | --- | --- |
| band × mode matrix, hourly, rate records, cumulative, hour-of-day, dupes, call-length, band / mode share | yes | yes |
| continent breakdown, DXCC table, top entities, continent-over-time, CQ zones | yes | yes (via cty.dat) |
| sections / exchanges worked | yes | yes (per-contest exchange map, or a best-effort trailing token) |
| points, points/QSO, points distribution, cumulative points | yes | hidden |
| multipliers by band, cumulative mults, mult-over-time | yes | hidden |
| operator leaderboard, per-operator table, operator selector | yes | hidden |
| run vs S&P (table + over time) | yes | hidden |

`stats.js` / `charts.js` decide what to hide from `logMeta.has_points` /
`has_mults` / `has_operator` / `has_run_flag` on the fetched analysis.

## Pages

- **`/analyze`** — the entry page: a three-tab card (Upload file / Enter
  manually / Live contest), a compare form, and — once a token is entered —
  the saved-analyses list (open / delete per row, "Nd left" until it ages
  out of retention).
- **`/analyze/<id>`** — a small landing card: contest / call / QSO count /
  format, the detected `contest_key` and whether the exchange parsed, any
  removed (`X-QSO`) QSOs, then **Open Stats** / **Open Charts** (→
  `stats.html?log=<id>` / `charts.html?log=<id>`), **Copy share link**,
  **Download report**, and a "Compare with…" box.
- **`/compare?a=<id>&b=<id>`** (`public/compare.js`) — two saved analyses
  side by side: a headline table (QSOs, points, mults, pts/Q, DXCC, zones,
  bands, hours, avg rate, best-60, each with a B−A delta) and a per-band
  QSO table with deltas. Public — you only need the two ids.
- `chrome.js` lights up the **Analyze** nav link (not Stats / Charts)
  whenever the URL carries `?log=<id>`, so a result view reads as part of
  the analyzer.

## `src/analyze/`

Pure functions, no DOM, no Node built-ins beyond `fs`/`path`/`crypto` in
`index.js`/`geo.js` — so the parsers run server-side today and could run
in-browser unchanged.

| File | Role |
| --- | --- |
| `index.js` | orchestrator. `analyzeLog(text, filename)` — detect format → parse → per-contest exchange (Cabrillo) → `enrichGeo` → `{ meta, qsos, excluded }`. `analyzeLiveQsos(rows)` — the same shape from `qsos`-table rows. `newId()`, `detectFormat()`. |
| `cabrillo.js` | `parseCabrillo(text)` → `{ meta, qsos, flags }`. 4 fixed leading `QSO:` tokens (freq kHz, mode, `YYYY-MM-DD`, `HHMM` UTC), `token[4]` = my call, worked call by a symmetric-split heuristic (overridden later when a contest grammar matches). Raw exchange tokens stashed on `q._exchTokens` for `contests.js`, stripped before storage. `X-QSO:` → `q.excluded = 1`. |
| `adif.js` | `parseAdif(text)` → `{ meta, qsos, flags }`. `<name:len>` field parsing, records split on `<eor>`, header dropped at `<eoh>`. Reads `APP_N1MM_*` for points / mults / run, `OPERATOR`, `CONT`/`CQZ`, `ARRL_SECT`. `APP_N1MM_ISCLAIMEDQSO=0` → excluded. |
| `bands.js` | `canonicalBand(mhz)` — snap a frequency to a canonical band string ("14", "7", "3.5") so Cabrillo kHz, ADIF band tokens and the live feed all bucket identically. |
| `contests.js` | per-contest exchange maps — see below. |
| `cty.js` | country-file parser/resolver. `loadResolver(text)` → `resolve(call)` → `{ entity, name, prefix, continent, cqzone }`. Prefix trie + `=CALL` exception map + per-alias `(zone)` / `{cont}` overrides; strips `/P` etc. and picks the location token from a portable call. |
| `geo.js` | `enrichGeo(qso)` — fill blank `continent` / `zone` / `countryprefix` from `cty.csv`, never overriding what's already there. Caches the resolver. **Also called from the realtime contact pipeline** (`src/udp/index.js`) so the dashboard's by-continent breakdown works for a logger (TR4W, older N1MM) that omits those fields. `resolveCall(call)` exposes the raw record (used for ARRL-DX domestic detection). |
| `cty.csv` | bundled "big CTY" from country-files.com. A source asset (not under `data/`, which is gitignored). Refreshed monthly by `.github/workflows/cty-refresh.yml`, which opens a PR when it changes. |

## Per-contest exchange maps (`contests.js`)

A Cabrillo `QSO:` line past the four fixed tokens is
`<sent…> <call> <rcvd…> [txid]`, and the grammar is contest-specific.
`specForContest(header)` matches the normalized `CONTEST:` header against a
registry; `applyExchange(qsos, spec, ctx)` then splits `sent | call | rcvd`
deterministically and maps the received fields onto QSO columns:

```
serial→rcv_nr  zone→zone  section/state/prov/loc/county/hq→section
grid→gridsquare  name→op_name  check→ck  prec→prec  class/age/memnum→exchange1  power→power
```

Per-token pseudo-fields resolve by shape: `hqzone` (digits → zone, else HQ
abbrev), `stnum` (digits → serial, else state), `spcnum` (digits → club
number, else state).

- **Covered:** CQ WW / WPX / 160, WAE, IARU HF, Stew Perry, ARRL SS / Field
  Day / DX / 160 / 10 / RTTY Roundup, RAC, All Asian, Oceania, SAC, JIDX,
  Russian DX, EU HF Championship, ARI, NAQP, NA Sprint, the weekly sprints
  (CWT, K1USN SST, ICWC MST, OK1WC MWC), and a flexible handler for
  `*-QSO-PARTY` / `*QP` (incl. `7QP`, `NEQP`).
- **ARRL DX / 160** are asymmetric — a `resolve(ctx)` spec keyed on
  `ctx.isDomestic`, which `index.js` derives from the uploader's DXCC
  entity (`291` US / `1` Canada), so Alaska and Hawaii correctly count as
  DX.
- The worked call becomes deterministic when a grammar matches. On a token
  count mismatch it keeps the heuristic call and maps whatever trailing
  tokens line up.
- Runs **before** `enrichGeo`, so a zone read from the actual exchange (CQ
  WW) wins over the country file's default zone for that entity.
- A contest with **no** matching spec still gets `applyGenericExchange()` —
  a trailing 2–5 letter token is taken as a state / section.
- `meta.contest_key` and `meta.exchange_parsed` record the outcome and show
  on the result page.

ADIF is unaffected — its exchange is already in structured fields. The live
snapshot is unaffected — N1MM already parsed it.

## Storage & API

`analyzed_logs` (in `src/db/schema.sql`; `migrations/002_analyzed_logs_contest.sql`
brings an older DB forward via a table recreate):

```
id              TEXT PRIMARY KEY   -- ~10-char base32 slug
filename, format ('cabrillo' | 'adif' | 'live'), contest
contest_key, exchange_parsed
station_call, operators, claimed_score, qso_count
has_points, has_mults, has_operator, has_run_flag
raw_bytes
parsed_json      TEXT NOT NULL     -- {"qsos":[…],"excluded":[…]}  (a bare array is still accepted on read)
created_at
```

Deliberately **not** the `qsos` table — an analysis is a saved artifact and
must survive `DELETE /api/db` / the pre-contest reset. Not covered by the
`db:cleared` socket event.

`src/routes/analyze.js`, mounted at `/api/analyze`:

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /api/analyze?filename=` | bearer | raw Cabrillo/ADIF text (≤ `ANALYZE_MAX_BYTES`, default 5 MB). `analyzeLog` → `persist` → `{ id, meta }`. 422 on unrecognised format or zero QSOs. |
| `POST /api/analyze/from-live` | bearer | no body. `getQsos()` → `analyzeLiveQsos` → `persist`. 422 if the live DB is empty. |
| `GET /api/analyze` | bearer | `{ items: [...], retention: { keep, ttl_days } }` — the saved-analyses index. |
| `GET /api/analyze/:id` | none | `{ meta, qsos, excluded }`. 404 if unknown/aged-out. This is the shareable link. |
| `DELETE /api/analyze/:id` | bearer | remove one. |
| `GET /analyze`, `/analyze/:id`, `/compare` | none | static page shells (served in `app.js`); the JS fetches the API. |

Body handling mirrors `routes/ingest.js` — the POST routes read their own
raw body; the global `express.json()` only touches `application/json`.

**Retention**, enforced on every successful write (`pruneAnalyzedLogs`):
keep the newest `ANALYZE_KEEP` (default 200) and drop anything older than
`ANALYZE_TTL_DAYS` (default 365); either bound is disabled with `0`.

## Report export

`public/js/report.js` `renderReport({ meta, qsos })` → one self-contained
HTML string: inline CSS, no external references, every meta field escaped —
headline tiles, band × mode matrix, hourly table, top-20 DXCC, sections
worked. The result page's **Download report** button re-fetches the
analysis and saves it as `<call>-<contest>.html`, so an analysis can be
archived independent of the server and its retention window.

## Tests

`test/analyze/` — `cabrillo`, `adif`, `cty`, `geo`, `bands` (via others),
`contests` (a fixture per contest + the generic fallback), `index`
(`analyzeLog` end to end, format detection, `newId`), `manual` (form →
Cabrillo → `analyzeLog` round trip), `live` (`analyzeLiveQsos`), `report`
(structure, points gating, escaping). `test/routes/analyze.test.js` covers
auth (503/401), format rejection (422), store + public fetch round trip,
delete, retention pruning, `from-live`, and the saved-list shape.

The pure suites run under Deno on a machine without Node
(`deno test --unstable-detect-cjs`); CI runs the full `node --test`.

## Not done

- **No scoring engine.** Points / multipliers for a bare Cabrillo would
  mean reimplementing per-contest scoring; deliberately out of scope. Use
  an ADIF export or the live snapshot when you need them.
- ADIF removed-QSO detection is limited to `APP_N1MM_ISCLAIMEDQSO`.
- No in-browser "quick look" (parse without saving) — the parsers are pure
  enough for it, it's just not wired up.
- No N-way comparison; `/compare` is two analyses.
