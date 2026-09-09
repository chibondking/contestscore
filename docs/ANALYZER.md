# Log Analyzer

Status: **v1 implemented.** Upload a Cabrillo or ADIF log at `/analyze`; it
is parsed, enriched, saved, and given a shareable `/analyze/<id>` link that
renders through the same Stats and Charts pages as the realtime dashboard.

**What shipped vs. the plan below:** the "shared analysis core" extraction
was *not* done — it was high-risk for the two just-shipped pages and turned
out unnecessary. Instead `stats.js` / `charts.js` gained a `?log=<id>` data
source: when that param is present they fetch `GET /api/analyze/<id>`
instead of the live feed, skip all socket/poll wiring, and hide the
sections the source format can't populate (`logMeta.has_*`). The
`/analyze/<id>` page is a light landing card linking into
`stats.html?log=<id>` and `charts.html?log=<id>`. The country file lives at
`src/analyze/cty.csv` (a source asset — `data/` is gitignored), refreshed by
`.github/workflows/cty-refresh.yml`. The `analyzed_logs` table is in
`src/db/schema.sql`, not a numbered migration. Everything else matches.

## Why this is a distinct thing

The Stats (`stats.js`) and Charts (`charts.js`) pages are already pure
client-side transforms over an array of QSO objects — the *rendering* is
reusable as-is. The open question was never "can we draw these charts from a
file" but "can a file produce that array". A realtime N1MM feed carries
per-QSO `points`, `is_mult1/2/3`, `operator`, `is_run_qso`, `continent`,
`zone`. A submitted log mostly does not.

This also sits at the edge of the Prime Directive (CLAUDE.md): showing a
*submitted log's* post-contest breakdown is not *realtime* results. It earns
its place by reusing the analysis work, not by appealing to the original
dashboard. Kept to **one clearly-labelled nav link**, that's within bounds.

## Decisions

| Question | Decision |
| --- | --- |
| Where it lives | An **"Analyze" page in this repo** for now. The shared-core extraction (below) is done regardless, so lifting it into its own app later is a move, not a rewrite. Revisit after v1. |
| Input formats | **Both ADIF and Cabrillo**, detected by content (`<eoh>` / `<call:` → ADIF; `START-OF-LOG:` / `QSO:` → Cabrillo). |
| Scoring | **No scoring engine.** Points / multipliers / per-operator / run-vs-S&P render **only when the file carries them** (an N1MM ADIF export). A bare Cabrillo shows the supported subset; the rest of the cards are omitted with a one-line note. |
| Persistence | **Uploads are saved and shareable by URL** (`/analyze/<id>`). There is a backend piece. |

### Working defaults for the items left open in discussion

These can still change, but implementation proceeds on them unless revised:

- **Upload is token-gated** (`Authorization: Bearer <CONTESTSCORE_API_TOKEN>`,
  the same secret as `DELETE /api/db`, pasted on the page like
  `admin.html`). **Viewing a shared analysis is public** — that's the point
  of a share link. Anonymous upload on a public VPS is a storage-abuse
  vector not worth taking on for a single-operator tool.
- **`cty.dat` resolution happens server-side, once, at upload time.** The
  parsed QSO array is stored with `continent` / `dxcc` / `cqzone` already
  baked in. The browser never loads the ~1 MB country file, and the data is
  frozen at upload anyway.
- **Parsers are plain functions with zero DOM and zero Node built-in
  dependencies**, so the exact same `cabrillo.js` / `adif.js` run
  server-side (the upload path) and could later run in-browser (a no-save
  "quick look" mode) unchanged.

## Architecture

### 1. Shared analysis core (refactor first)

Pull the pure computation out of the two pages:

```
public/js/analysis/
  core-stats.js    # get*Card / buildTable / bestWindow / helpers, lifted from stats.js
  core-charts.js   # build* + EXTRA_CHART_SPECS, lifted from charts.js
  cabrillo.js      # Cabrillo text -> QSO[]
  adif.js          # ADIF text   -> QSO[]
  cty.js           # callsign -> { dxcc, continent, cqzone }   (server-side use in v1)
src/analyze/
  cty.js           # same resolver, loaded with the bundled data file for the upload path
data/
  cty.csv          # bundled country file (country-files.com "big CTY"), refreshed by a job
```

- Each `core-*` export takes `(qsos, opts)` and returns view-model objects.
  No Alpine, no `fetch`, no DOM.
- `stats.js` / `charts.js` become thin wrappers: `fetch('/api/qsos')` → core
  → bind. `analyze.js` does the same with parsed-file data in place of the
  fetch.
- Loaded as plain global-namespace scripts (`window.ContestAnalysis.*`), not
  ES modules — same constraint as every other page script (see CLAUDE.md).
- The Deno harness used while building Stats/Charts is committed as
  `test/analysis/*.test.js` so the extraction can't silently regress the
  live pages. (`node` isn't on the dev machine; the harness runs under Deno
  and CI runs the Node suite — keep the analysis tests runnable by both, or
  add a `deno task`.)

### 2. Parsers → the common QSO shape

Both parsers emit the shape the core already consumes — `call, band, mode,
operator, points, is_mult1/2/3, countryprefix, continent, zone, section,
is_run_qso, n1mm_timestamp, logged_at` — filling what the format allows:

| QSO field | ADIF (N1MM export) | Cabrillo (generic) |
| --- | --- | --- |
| call, band (from `FREQ` kHz), mode, time | `CALL`,`BAND`,`MODE`,`QSO_DATE`+`TIME_ON` | cols 1–4 + worked-call heuristic |
| operator | `OPERATOR` / `STATION_CALLSIGN` | not present → omitted |
| points | `APP_N1MM_POINTS` | not present |
| is_mult1/2/3 | `APP_N1MM_MULT1/2/3` | not present |
| is_run_qso | `APP_N1MM_ISRUNQSO` | not present |
| continent / dxcc / zone | `CONT`,`DXCC`,`CQZ`, else cty resolver | cty resolver on worked call |
| section / exchange | `ARRL_SECT` etc. | only via a per-contest column map (v2) |

Parsing notes:

- **Cabrillo `QSO:` tokenising** — 4 fixed leading tokens (freq/kHz, mode,
  `YYYY-MM-DD`, `HHMM` UTC), then `token[4]` = my call, worked call by a
  callsign-regex scan of the remaining tokens, trailing transmitter-id digit
  ignored. `X-QSO:` lines are parsed but flagged `excluded` — kept out of
  every count, surfaced in a "removed QSOs" note.
- **Mode** normalised through the existing CW / PH / DG buckets
  (`PH`/`SSB`/`USB`/`LSB`/`FM` → PH; `RY`/`RTTY`/`DG`/`FT8`/`FT4`/`PSK*`/
  `MFSK` → DG).
- **Band** — Cabrillo frequency is kHz; `bandLabel()` currently expects
  MHz, so divide by 1000 (and accept the literal band tokens some loggers
  emit: `50`, `144`, `1.8`, `3.5`).
- **Time** is written to `n1mm_timestamp` so the Stats page's `qsoTime()`
  keys off real log time. Charts keeps its own `logged_at` axis; for a
  static file the two converge.
- **Header** fields worth keeping: `CONTEST`, `CALLSIGN`, `OPERATORS`,
  `CLAIMED-SCORE`, `CATEGORY-*` (ADIF: the corresponding `APP_N1MM_*` /
  program-header comments). Shown on the result page; not used in the maths.

### 3. cty.dat resolver

- Parse `data/cty.csv` once into a prefix trie + exact-call exception map.
- `resolve(call)` → `{ dxcc, continent, cqzone }`, used to fill
  continent/dxcc/zone when the file doesn't carry them. This lights up the
  continent breakdown, DXCC table, top-entities, and continent-over-time
  chart **for any contest**.
- Runs **server-side at upload** (working default above): the stored
  `parsed_json` already has these fields; the browser bundle stays small.
- Refresh: a scheduled workflow (same idea as
  `.github/workflows/contestpulse-build.yml`) commits an updated `cty.csv`
  monthly. Stale-but-bundled is acceptable — a portable op's zone from
  cty.dat can be wrong, which doesn't matter for aggregate stats.

### 4. Backend — upload, storage, sharing

New router `src/routes/analyze.js`, mounted at `/api/analyze` in `app.js`
(after `ingestRouter`, before or alongside `apiRouter`).

| Route | Auth | Behaviour |
| --- | --- | --- |
| `POST /api/analyze` | Bearer `CONTESTSCORE_API_TOKEN` | Raw Cabrillo/ADIF text body, size cap (`ANALYZE_MAX_BYTES`, default 5 MB). Detect format, parse with the shared modules, run the cty resolver, store one row, enforce retention, return `{ id }`. |
| `GET /api/analyze/:id` | none (public) | `{ meta, qsos: [...] }`. 404 if unknown/expired. |
| `GET /api/analyze` | Bearer | List saved analyses (id, filename, contest, qso_count, created_at) for a "your logs" view. |
| `DELETE /api/analyze/:id` | Bearer | Manual delete. |
| `GET /analyze` and `/analyze/:id` | none | Static page shell (served from `public/`); the JS fetches the API. |

Body handling mirrors `routes/ingest.js` — these routes read their own raw
body; `express.json()` only touches `application/json`, so it doesn't
interfere.

**Storage** — a dedicated table, deliberately **not** `qsos` (which is
realtime-contest-scoped and wiped by `DELETE /api/db`). One JSON blob per
upload; the core only ever needs the array, so there's no reason to
normalise into columns.

```sql
-- migrations/002_analyzed_logs.sql
CREATE TABLE IF NOT EXISTS analyzed_logs (
  id            TEXT PRIMARY KEY,      -- ~10-char base32 slug, from crypto.randomBytes
  filename      TEXT,
  format        TEXT,                  -- 'cabrillo' | 'adif'
  contest       TEXT,
  station_call  TEXT,
  operators     TEXT,                  -- raw OPERATORS header, for display only
  claimed_score INTEGER,
  qso_count     INTEGER,
  has_points    INTEGER DEFAULT 0,     -- drives which cards the page shows
  has_mults     INTEGER DEFAULT 0,
  has_operator  INTEGER DEFAULT 0,
  has_run_flag  INTEGER DEFAULT 0,
  raw_bytes     INTEGER,
  parsed_json   TEXT NOT NULL,         -- the QSO[] array
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- Not covered by the `db:cleared` socket event; survives a contest reset.
- **Retention**, enforced opportunistically on each successful upload:
  delete rows beyond the newest `ANALYZE_KEEP` (default 200) and older than
  `ANALYZE_TTL_DAYS` (default 365). Documented in `deploy/DEPLOY.md`.
- Migration runs automatically on startup (`src/db/index.js` `runMigrations`).

### 5. Frontend — `analyze.html` + `analyze.js`

- **Upload view** (`/analyze`): token field (remembered in `localStorage`,
  like `admin.html`), drag-drop / file picker, "Analyze & save" → POST →
  redirect to `/analyze/<id>`.
- **Result view** (`/analyze/<id>`): header shows filename / contest / call
  / QSO count, a "Copy share link" button, and — when the format lacks them
  — a note like *"Cabrillo log: no points, multiplier, or per-operator data
  in this format."* Then the full Stats + Charts render from the extracted
  core, with unsupported cards/charts omitted based on the `has_*` flags.
- **Nav**: one **Analyze** link added to `chrome.js`.
- Same dark theme, Fira Code, no build step. Not `type="module"` (CLAUDE.md).

## Capability matrix

| Section | N1MM ADIF | Generic Cabrillo |
| --- | --- | --- |
| Band × mode matrix, hourly, rate records, cumulative, hour-of-day, dupes, call-length, band/mode share | yes | yes |
| Continent breakdown, DXCC table, top entities, continent-over-time, CQ zones | yes | yes (via cty.dat) |
| Points, points/QSO, points distribution, cumulative points | yes | hidden |
| Multipliers by band, cumulative mults, mult-over-time | yes | hidden |
| Operator leaderboard, per-operator top table | yes | hidden |
| Run vs S&P (table + over-time) | yes | hidden |

## Phasing

- **v1** — shared-core extraction + regression tests; ADIF + Cabrillo
  parsers (pure functions); server-side cty resolver + bundled `cty.csv` +
  refresh workflow; `analyzed_logs` table + migration; `/api/analyze` routes
  (token-gated upload, public view); `analyze.html` upload + result views;
  nav link; `DEPLOY.md` + `README.md` updates.
- **v2** — per-contest exchange column maps for the contests actually run
  (sections, serials, zones from the exchange rather than cty.dat); `X-QSO`
  UI; log-vs-log comparison.
  - **Done:** exchange maps (`src/analyze/contests.js`). A registry keyed on
    the normalized `CONTEST:` header maps `sent | call | rcvd` token
    positions onto QSO columns (`zone`, `section`, `gridsquare`, `op_name`,
    `ck`, `prec`, `rcv_nr`, `exchange1`, `power`). Covered: CQ WW / WPX /
    160, WAE, IARU HF, Stew Perry, ARRL SS / Field Day / DX / 160 / 10 /
    RTTY Roundup, RAC, All Asian, Oceania, SAC, JIDX, Russian DX, EU HF
    Championship, ARI, NAQP, NA Sprint, the weekly CW/SSB sprints (CWT,
    K1USN SST, ICWC MST, OK1WC MWC), and a flexible handler for
    `*-QSO-PARTY` / `*QP` (incl. `7QP`, `NEQP`). ARRL DX / 160 domestic-vs-DX
    is keyed on the uploader's DXCC entity (291 US / 1 Canada), so
    Alaska / Hawaii correctly count as DX. A contest with **no** matching
    spec still gets `applyGenericExchange()` — a trailing 2-5 letter token
    is taken as a state / section. The worked call becomes deterministic
    when a grammar matches; a count mismatch falls back to the v1
    symmetric-split heuristic. Runs before cty enrichment so an exchange
    zone (CQ WW) wins over the country file's default. `meta` gains
    `contest_key` + `exchange_parsed` (new `analyzed_logs` columns via
    `migrations/002_analyzed_logs_contest.sql`), surfaced on the result
    page. ADIF now also honours `APP_N1MM_ISCLAIMEDQSO=0` as a removed QSO.
    Tested per contest in `test/analyze/contests.test.js`.
  - **Done:** `X-QSO` handling. `parsed_json` now stores
    `{ qsos, excluded }` (the GET route accepts the old bare-array shape
    too); removed QSOs come back as compact `{call, band, mode, timestamp}`
    rows and the result page shows a count + expandable list. They stay out
    of every stat.
  - **Done:** log-vs-log comparison. `/compare?a=<id>&b=<id>`
    (`public/compare.js`) fetches both public analyses and renders a
    headline table (QSOs / points / mults / pts-per-Q / DXCC / zones /
    bands / hours / avg rate / best-60, each with a B−A delta) and a
    per-band QSO table with deltas. Entry points: a "Compare with…" box on
    a result page (prefills `a`), and a two-id form on the upload page.
- **Realtime reuse.** The country-file fill was pulled into
  `src/analyze/geo.js` (`enrichGeo` / `resolveCall`) and wired into the
  live contact pipeline (`src/udp/index.js`): an incoming `contact:new`
  gets its continent / CQ zone / DXCC prefix filled from cty.csv when the
  logger didn't send them (TR4W, older N1MM), so the dashboard's
  by-continent breakdown works regardless of logger. Fill-only, never
  overrides what the packet carried.
- **v3 — done.**
  - **Saved analyses list.** `GET /api/analyze` now returns
    `{ items, retention: { keep, ttl_days } }` (still token-gated). The
    upload page, once a token is entered, shows the list with open / delete
    per row and a "Nd left" retention hint (`analyze.js` `loadSaved` /
    `deleteSaved` / `ageOut`).
  - **Static report export.** `public/js/report.js` `renderReport({meta,
    qsos})` builds one self-contained HTML file (inline CSS, no external
    refs, all meta escaped) with the headline tiles, band × mode matrix,
    hourly table, top-20 DXCC and sections worked. A "Download report"
    button on the result page fetches the analysis and saves it as
    `<call>-<contest>.html`. Tested in `test/analyze/report.test.js`.
- **Nav.** `chrome.js` highlights **Analyze** (not Stats/Charts) whenever
  the page URL carries `?log=<id>`, so a result view reads as part of the
  analyzer.
- **Manual entry.** An "Enter manually" toggle on the upload page: header
  fields (contest, my call, my sent exchange, default band/mode, date) plus
  a paste box, one QSO per line as `[HHMM] [band] CALL [their exchange…]`
  (raw `QSO:` / ADIF lines pass through). `public/js/manual.js`
  `buildManualCabrillo()` turns the form into a Cabrillo string that goes to
  the **same** `POST /api/analyze` — so the exchange maps, cty enrichment
  and every stat apply with zero manual-entry code server-side. Round-trip
  tested (form → Cabrillo → `analyzeLog`) in `test/analyze/manual.test.js`.
- **Snapshot the live contest.** A "Live contest" toggle:
  `POST /api/analyze/from-live` (token-gated, no body) reads the realtime
  `qsos` table and stores it as an analysis. That data is already the full
  N1MM feed — points, multiplier flags, operator, run status, the parsed
  exchange — so `analyzeLiveQsos()` (`src/analyze/index.js`) just remaps the
  rows and runs `enrichGeo()` for anything an older logger left blank; no
  format detection or exchange grammar. `format` is `'live'`, and all the
  points/mults/operator/run breakdowns show. `test/analyze/live.test.js` +
  a route test cover it.

## Risks

- **Refactor regressions.** Extracting the core from the two just-shipped
  pages is the riskiest step. Mitigation: extract incrementally, keep the
  Alpine components as thin wrappers, land the `test/analysis` harness
  first.
- **Cabrillo `QSO:` column variance.** The worked-call heuristic will
  occasionally misfire on unusual exchanges. v1 accepts that for the
  fields it derives (call length, dupes, DXCC lookup); v2's per-contest
  maps remove the guesswork for known contests.
- **Storage growth / abuse.** Bounded by the token gate + size cap +
  retention policy; revisit only if the gate is ever removed.
