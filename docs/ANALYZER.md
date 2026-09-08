# Log Analyzer — plan

Status: **planning, not built.** This document is the agreed shape for an
"Analyze" feature that takes an uploaded Cabrillo or ADIF log and renders it
through the same Stats and Charts breakdowns the realtime dashboard uses.

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
- **v3** — "your saved analyses" list with delete/expiry UI; export the
  result as a standalone static HTML report (SH5-style).

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
