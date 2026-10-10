# contestscore

A real-time ham radio contesting dashboard. Inspired by the Node-RED-based
Node-Red-Contesting-Dashboard, rebuilt as a clean, maintainable Node.js
application.

## Scope

The heart of contestscore is **realtime contest results** -- radio state,
QSOs, and score, pushed live to the browser. That part is built and it
works; it must stay fast, legible across the room, and correct, and it's
what every design decision is weighed against first.

Around that core, **operating aids that genuinely help while a contest is
running** are in scope when each earns its place on its own merits -- not
by an appeal to feature-parity with the original Node-RED dashboard, which
is still not a goal. The test is: *does this help the person running the
contest, right now, without bloating or slowing the results view?* What's
passed that test so far:

- the **offline log analyzer** (`/analyze`, `docs/ANALYZER.md`) -- the
  same results breakdowns for a whole finished log (uploaded, pasted, or
  snapshotted from the live DB), reusing the Stats/Charts rendering. It is
  **not** a licence to pile non-results features onto the analyzer (a
  scoring engine, spot overlays);
- **callsign lookup** (`src/lookup/`, HamQTH) and the **Possible Busts**
  panel it feeds -- a live data-quality signal on the log;
- **space-weather indices** (SFI / A / K, `src/solar/`) in the header --
  propagation context for the operator;
- the **mult bell** (2026-10-09) -- an optional desk-bell ding on the
  dashboard when a new multiplier is logged (N1MM's `is_mult1/2/3`). Per
  viewer (localStorage `contestpulse_multbell`), **off by default**, with a
  "only after N mults" threshold so the early hours of a contest, when
  nearly every QSO is a mult, stay quiet. Synthesized with Web Audio (no
  sound file); edits, X-QSOs, QTCs and replayed backlogs (N1MM timestamp
  over 15 min old) don't ring, and a burst rings once (2s cooldown).
  Browsers block audio until a click on the page, so a reloaded wall
  display needs one click before it can ding -- the popover says so;
- the **TUI** (`tui/`, 2026-10-09) -- the same results core in a
  terminal, for watching a contest over SSH on the box itself with no
  browser in the way (`npm run tui`, defaults to `http://localhost:3000`;
  on a tenant box, `cstui [<tenant>]` -- `deploy/cstui`, installed to
  `/usr/local/bin` by the deploy script, runs it as the `contestscore` user
  and resolves the tenant's port from its `tenant.env`).
  A **client only**: it reads the public REST + socket.io surface the
  dashboard page already uses, so nothing in `src/` knows it exists and it
  adds exactly one dependency (`socket.io-client`). Its copies of the
  dashboard's derivations (`scoreStale`, `operatorStats`,
  `continentCounts`, `bandLabel`, the mult-bell rules) -- and of
  `stats.js`'s At a Glance tiles (`glanceStats`) -- are deliberate
  duplicates rather than shared code -- those live inside `dashboard()`'s
  closure in a classic non-module script, same reason `report.js`/
  `compare.js` keep their own `bandLabel`; **change one, change the
  other.** No Admin page (destructive and token-gated -- no business
  behind a keystroke), no world map, no busts panel. See `tui/README.md`;
- **hamdata** (`hamdata/`, 2026-10-08) -- not a feature, plumbing: one
  shared process doing solar + callsign lookup for several contestscore
  instances on one VPS (the multi-tenant plan lives in the ops repo's
  CLAUDE.md Section 23). Optional; a standalone install never runs it.

An earlier version of this section said "realtime results and nothing
else," with a long list of things "permanently out of scope." That was
deliberate scaffolding to get a focused, usable dashboard built first, and
it did its job. Scope now widens **feature by feature, with the
maintainer** -- it is not licence to port every panel the old dashboard
had. When you add something outside the results core, say so here.

## What This Does

Listens for UDP broadcast packets from contesting logging software (N1MM+,
TR4W, DXLog) and displays a live dashboard in the browser. Operators at
networked contest stations broadcast radio state, QSO data, and score data
over UDP; this server ingests those packets, stores them in SQLite, and pushes
updates to connected browsers in real time via WebSockets.

## Architecture

```
UDP :12060  (Radio broadcast)      --\
UDP :12061  (Contacts + Callsign)   |-> src/udp/dispatch.js (handleAnyBuffer)
UDP :12062  (Score broadcast)      --/         |
                                                v
POST /api/ingest/{radio,contact,score}  ------>+   (ContestPulse bridge)
                                                |
                                                v
                                    src/parsers/  (XML -> JS objects)
                                                |
                                                v
                                    src/db/       (better-sqlite3)
                                                |
                                                v
                                    src/socket/   (socket.io)
                                                |
                                                v
                                    public/       (dashboard, no build step)
```

Two transports feed the same pipeline: raw LAN UDP for a local install, and
authenticated HTTP for a deployment ContestPulse relays into (see
"ContestPulse Bridge" below).

**Every listener and every ingest route dispatches by the packet's own XML
root element (`src/udp/dispatch.js`), not by which port/route it arrived
on.** This isn't defensive theater -- port labels have already failed to
match content twice in real deployments: a FlexRadio/SmartSDR CAT setup
exclusively claiming N1MM's documented default Contacts port for its own
spot listener, and a live capture where a Score broadcast landed on
whatever port a deployment's own config called "radio_port". A
port-trusting listener silently drops real data in both cases; dispatching
by actual root element handles any such mismatch, from any of the three
local ports or any of the three ingest routes. `handleRadioBuffer`/
`handleContactBuffer`/`handleScoreBuffer` (exported from `src/udp/
*Listener.js`) still do the actual per-type parse/DB/emit work -- dispatch.js
just routes to the right one first.

HTTP server (Express) on port 3000 serves the dashboard and a REST API for
historical data. Socket.io runs on the same port.

### The offline log analyzer

`src/analyze/` + `src/routes/analyze.js` are a second, self-contained path
that shares nothing with the realtime pipeline except the browser
rendering. It takes a whole contest log -- an uploaded Cabrillo/ADIF file,
a pasted shorthand form, or a one-click snapshot of the live `qsos` table
-- parses it into the *same* per-QSO array the Stats and Charts pages
already consume, stores it in `analyzed_logs`, and serves it at a
shareable `/analyze/<id>`. `stats.js` / `charts.js` gained one hook, a
`?log=<id>` query param, that makes them fetch a stored analysis instead
of the live feed. No sockets, no `qsos` table, no separate analysis
engine. **Full detail in `docs/ANALYZER.md`** -- read it before touching
`src/analyze/`.

One piece is shared back into realtime: `src/analyze/geo.js`'s
`enrichGeo(qso)` fills a QSO's blank `continent` / `zone` / `countryprefix`
from the bundled country file, and `src/udp/index.js` calls it on every
incoming `contact:new` so the dashboard's by-continent breakdown works for
a logger (TR4W, older N1MM) that omits those fields. Fill-only, never
overrides the packet.

## ContestPulse Bridge

N1MM's UDP broadcasts are LAN-local (often literal broadcast addressing),
so they don't reach a contestscore instance that isn't on the same LAN --
a VPS, for instance. `contestpulse/` is a small standalone Go program that
runs on (or near) the shack LAN, listens for N1MM's broadcasts on the usual
three ports, and forwards each datagram byte-for-byte to
`POST /api/ingest/{radio,contact,score}` over HTTPS with a bearer token.
It never parses or understands N1MM's XML -- that still only happens
server-side, in `src/parsers/`, via the same functions the UDP listener path
uses. contestscore's ingest API never accepts unauthenticated UDP-shaped
traffic directly; the VPS never talks raw UDP to the internet.

The **contact relay holds** (`contestpulse/hold.go`, v1.8.0): every
contact-port packet goes into an in-memory FIFO and the oldest is retried
with backoff (1s doubling to 30s) until the server accepts it -- through
transport errors, 5xx (Cloudflare answers 502 while the origin restarts),
408/429 and 401/403 (a token mismatch mid-redeploy). Other 4xx (a packet
the server will never take) is dropped so it can't block the line. Order is
preserved, so an edit/delete never overtakes its QSO, and resending is safe
because the server upserts by N1MM's `<ID>`. Radio/score keep the old
16-deep drop-oldest queue (snapshots; replaying stale ones is noise).
Memory only; capped at 20,000 packets.

ContestPulse also sends a heartbeat (`POST /api/ingest/heartbeat`, default
every 10s, configurable) independent of whatever N1MM traffic is or isn't
flowing -- Contact/Score packets only happen when the contest produces
something, so they can't be trusted alone as a liveness signal during a
quiet stretch. `src/state/bridgeStatus.js` tracks the age of each station's
last heartbeat and derives realtime / stale / offline (defaults: realtime
within 15s, stale within 30s, offline beyond that -- override via
`BRIDGE_STALE_AFTER_MS` / `BRIDGE_OFFLINE_AFTER_MS` if a deployment changes
ContestPulse's own heartbeat interval from the 10s default). The dashboard
shows this per station_id via `GET /api/bridges` (initial load) and the
`bridge:status` socket event (live updates, including the transition into
stale/offline itself, which is caught by a periodic sweep since by
definition no event fires when a station just goes quiet).

Binaries are cross-compiled for Windows x86-64, Linux x86-64, Linux ARM64,
and Linux ARMv7 via `.github/workflows/contestpulse-build.yml` (same target
matrix as the sibling station-status project's agent) -- N1MM itself only
runs on Windows, but ContestPulse doesn't need to run on the same machine,
just somewhere that can see N1MM's LAN broadcasts.

## Tech Stack

- Runtime: Node.js 18+
- Web server: Express 4
- Real-time: socket.io 4
- Database: better-sqlite3 (synchronous, no async hell, Pi-friendly)
- XML parsing: xml2js
- UDP: Node built-in dgram module
- Frontend: Vanilla JS + Alpine.js + Chart.js (all CDN, no build step)
- TUI: plain Node + hand-rolled ANSI escapes, `socket.io-client` (`tui/`)
- No TypeScript, no bundler, no framework. This runs on a Raspberry Pi.

No page script (`dashboard.js` / `charts.js` / `stats.js` / `analyze.js` /
`compare.js` / `admin.js`, plus the shared `chrome.js` / `manual.js` /
`report.js`) is loaded as `type="module"` -- see the comment on each
page's `<script>` tag. A module's top-level declarations don't land on the
global scope Alpine evaluates `x-data="..."` against, so a module-loaded
page silently fails to initialize at all. This bit the dashboard once
already (see git history); don't reintroduce it on a new page. `manual.js`
and `report.js` guard a `module.exports` at the bottom so their pure
functions are also unit-testable under Node -- that's the only concession.

## Project Structure

```
contestscore/
  src/
    udp/
      radioListener.js      # dgram socket on :12060
      contactListener.js    # dgram socket on :12061
      scoreListener.js      # dgram socket on :12062
      index.js              # starts all listeners, wires to emitter (also calls analyze/geo enrichGeo)
    parsers/
      radio.js              # parses RadioInfo XML
      contact.js            # parses ContactInfo XML
      score.js              # parses Score XML
      lookup.js             # parses ExternalCallsignLookup XML
    analyze/                # offline log analyzer (see docs/ANALYZER.md)
      index.js              # analyzeLog(text) / analyzeLiveQsos(rows) orchestrator
      cabrillo.js           # Cabrillo text -> { meta, qsos, flags }
      adif.js               # ADIF text -> { meta, qsos, flags }
      contests.js           # per-contest exchange grammars + generic fallback
      cty.js                # country-file parser/resolver (callsign -> entity/continent/zone)
      geo.js                # enrichGeo(qso): fill blank continent/zone/prefix; shared with src/udp
      bands.js              # canonicalBand(mhz)
      cty.csv               # bundled "big CTY" data (refreshed by cty-refresh.yml)
    db/
      index.js              # opens DB, runs migrations
      schema.sql            # table definitions
      queries.js            # all prepared statements
    socket/
      index.js              # socket.io setup, event->broadcast mapping
    lookup/                 # live-dashboard callsign lookup (HamQTH). NOT used by src/analyze/
      index.js              # provider resolution, the paced/de-duped queue, prime()
      hamqth.js             # HamQTH XML API client (session token, <search> normalisation)
    solar/                  # space-weather poller (hamqsl.com -> solar_snapshots + solar:update)
      index.js              # fetch loop, XML parse, latest-reading accessor
    routes/
      api.js                # REST endpoints for historical data
      ingest.js             # POST /api/ingest/* (ContestPulse HTTP transport)
      analyze.js            # POST/GET/DELETE /api/analyze* (the log analyzer)
    app.js                  # Express setup, mounts routes, serves /analyze + /compare shells
    env.js                  # loads <root>/.env at startup (never overrides the real env)
    server.js               # entry point: starts HTTP + UDP
  public/
    index.html              # dashboard shell
    charts.html             # trend charts + spec-driven "more charts" grid
    stats.html              # SH5/CBS-style post-contest breakdown tables
    solar.html              # 30-day space-weather charts (SFI/SN/A/K) + current tiles
    analyze.html            # analyzer: upload / manual / live tabs + result landing
    compare.html            # two analyses side by side
    admin.html              # DB reset UI
    js/
      dashboard.js          # socket.io client, DOM updates
      charts.js             # Chart.js; ?log=<id> loads a saved analysis instead of the live feed
      stats.js              # stats tables; same ?log=<id> hook
      solar.js              # solar page: fixed 30-day window, plain JS (no Alpine), helpers tested in test/solar/
      analyze.js            # analyzer page logic (upload/manual/live/compare/saved list)
      compare.js            # log-vs-log comparison
      manual.js             # buildManualCabrillo(): manual form -> Cabrillo string
      report.js             # renderReport() HTML + renderReportText() plain-text summary for a saved analysis
      chrome.js             # shared header/nav/footer; highlights Analyze when URL has ?log=
      admin.js
    css/
      dashboard.css         # shared by every page
  contestpulse/             # standalone Go relay (LAN UDP -> HTTPS ingest); see "ContestPulse Bridge"
  tui/                      # terminal front end for the live dashboard (client-only); see tui/README.md
  config/
    default.json            # ports, DB path, feature flags
  migrations/               # numbered SQL migration files, run on startup
  deploy/                   # DEPLOY.md + the production deploy script + nginx/systemd units
  docs/
    SETUP.md                # user-facing install guide (LAN / single VPS)
    MULTI-TENANT.md         # user-facing guide: several clubs on one VPS, by hand
    ANALYZER.md             # the log analyzer, in full
  test/
    parsers/                # unit tests for parser logic
    analyze/                # analyzer unit tests (parsers, cty, contests, manual, live, report, ...)
    udp/                    # integration tests with mock UDP senders
    routes/                 # REST API integration tests (in-memory SQLite)
  CLAUDE.md                 # this file
  package.json
  .env.example
```


## UDP Packet Types

N1MM+ broadcasts XML over UDP. **Verified against the actual wire format** at
https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/ — earlier
notes here described an invented/idealized schema that doesn't match what
N1MM actually sends; do not trust field lists from memory, always check a
real captured packet or the docs above.

### RadioInfo (:12060) — root `<RadioInfo>`
Fields we care about: `StationName`, `RadioNr`, `Freq`, `TXFreq`, `Mode`,
`OpCall`, `IsRunning`, `IsTransmitting`, `FocusEntry`, `Antenna`, `Rotors`,
`FocusRadioNr`, `ActiveRadioNr`, `FunctionKeyCaption` (the label of the
F-key that started the current transmission, e.g. "F1: CQ" -- the dashboard
only shows it while `IsTransmitting` is true, since N1MM doesn't clear the
field back out between transmissions). This is the one packet type whose casing and
field names matched our original assumptions -- the *values* didn't,
though: `Freq`/`TXFreq` (and ContactInfo's `rxfreq`/`txfreq`, same issue) are
in **tens of Hz, not Hz**. Confirmed against N1MM's own documented example
(`<Freq>352211</Freq>` only makes sense as 3.52211 MHz, its own "CW-80m"
label, once multiplied by 10) and against a live report of the dashboard
showing 386.5 kHz while actually on 3865 kHz -- exactly a 10x error. See
`src/parsers/util.js`'s `tensOfHzToHz()`, shared by both parsers specifically
so fixing this in one field doesn't leave it sitting in another, which is
exactly how ContactInfo's copy of the same bug was first missed.

### Contact broadcasts (:12061) — three distinct packet types, disambiguated
by root element name (**lowercase**, unlike RadioInfo):

- **`<contactinfo>`** — a new QSO. Fields: `contestname`, `contestnr`,
  `timestamp`, `mycall`, `band` (MHz, e.g. `"14"`, `"3.5"`), `rxfreq`,
  `txfreq`, `operator`, `mode`, `call`, `countryprefix`, `wpxprefix`,
  `stationprefix`, `continent`, `snt`, `sntnr`, `rcv`, `rcvnr`, `gridsquare`,
  `exchange1`, `section`, `comment`, `name`, `power`, `misctext`, `zone`,
  `prec`, `ck`, `ismultiplier1`, `ismultiplier2`, `ismultiplier3`, `points`,
  `radionr`, `run1run2`, `RoverLocation`, `RadioInterfaced`,
  `NetworkedCompNr`, `IsOriginal`, `NetBiosName`, `IsRunQSO`, `StationName`,
  `ID` (a GUID — see below), `IsClaimedQso`, `SentExchange`, and (on an edit)
  `oldtimestamp`/`oldcall`.
- **`<contactreplace>`** — an edited-in-place QSO, same field set as
  `contactinfo`.
- **`<contactdelete>`** — a deleted QSO. **Not** a flag inside ContactInfo —
  it's its own packet, with a deliberately small field set: `mycall`, `band`,
  `call`, `contestnr`, `StationName`, `ID`. Notably no `mode` or
  `contestname`.

`ID` is a GUID that stays stable across `contactreplace` edits — it's the
right identity key for upsert/delete, not the `(call, band, mode, mycall)`
natural key (older loggers that omit `ID` fall back to that natural key, but
lose update-in-place / correct delete-targeting because of it).

### Score (:12062) — root `<dynamicresults>`, not `<Score>`
This is not a flat per-band record. One broadcast contains the *entire*
contest snapshot: header fields (`contest`, `call`, `ops`, a `<class>`
element with `power`/`assisted`/`transmitter`/`ops`/`bands`/`mode`/`overlay`
attributes, a `<qth>` element with `dxcccountry`/`cqzone`/`iaruzone`/
`arrlsection`/`stprvoth`/`grid6`), plus a `<breakdown>` block of repeated
`<qso band="20" mode="CW">156</qso>` / matching `<point ...>` element pairs —
one pair per band/mode the station has worked, **plus** a
`band="total" mode="ALL"` pair holding the contest grand total. The overall
point total is the top-level `<score>` element, not `<total>`.

**Confirmed by a live capture (2026-09, N1MM+, "CW-OPEN" contest):**
`<dynamicresults>` can arrive nested one level deeper than the docs show,
inside an outer `<rtc>` wrapper (`<rtc><dynamicresults>...</dynamicresults>
</rtc>`) rather than as the bare root. `parseScore()` accepts both shapes.
Which one a given N1MM installation sends may depend on its version, or
possibly on whether N1MM's separate "Report Real-Time Score to Server"
feature (Score Reporting tab -- an unrelated, HTTP-based integration with
third-party scoreboard aggregators, on its own update interval) is enabled;
not confirmed either way, but the two features appear to share the same
underlying XML serialization internally.

No `<mult>` breakdown has been observed in a live capture yet (the only
verified example, ARRL Field Day, doesn't score multipliers) — the parser
handles one defensively if a contest sends it, using the same band/mode-keyed
shape as `<qso>`/`<point>`, but treat multiplier data as unconfirmed until
checked against a real non-Field-Day contest.

### ExternalCallsignLookup (:12061, same port as contacts) — root `<lookupinfo>`
Field list beyond `mycall` has not been independently verified against the
docs (they truncate the example) — current fields (`name`, `country`, `grid`,
`state`, `county`, `cqzone`, `ituzone`, `dxcc`, `continent`) are a plausible
best guess, not a confirmed capture.

## Database Schema (SQLite)

Core tables:
- `qsos` -- one row per logged QSO. Identified primarily by N1MM's `ID` GUID
  (`ext_id`, upserted via `ON CONFLICT` so a `contactreplace` edit updates in
  place); a `(call, band, mode, contestnr, mycall)` natural key is the
  fallback dedupe path for loggers that never send an `ID`.
- `radio_state` -- latest state per radio (upsert by `(station_name,
  radio_nr)`). Wiped by `DELETE /api/db` -- a pre-contest reset should drop
  radios that were on last time but aren't now, so they stop showing as
  connected.
- `score_snapshots` -- one row per (band, mode) entry from each `Score`
  broadcast's `<breakdown>`, plus a `band='total' mode='ALL'` row per
  broadcast holding the contest grand total (`is_total = 1`). All rows from
  one broadcast share the same `captured_at`, since a single Score packet
  reports the whole contest snapshot, not just one band -- treating "most
  recently inserted row" as "the current score" (the original design) is
  wrong for any multi-band contest.
- `settings` -- key/value config (contest name, operator, etc.)
- `callsign_cache` -- lookup results (N1MM `<lookupinfo>` or HamQTH), keyed
  by the suffix-stripped call; `source` says which. Kept ~6 months
  (`src/lookup/ttl.js`); **not** wiped by `DELETE /api/db` -- cleared on its
  own by `DELETE /api/lookup/cache`.
- `solar_snapshots` -- one row per hamqsl.com fetch (~2-hourly): SFI / A /
  K / sunspots + `fetched_at`. Append-only, and **NOT** wiped by
  `DELETE /api/db` -- it's ambient data, and the history is what a future
  rate-vs-conditions view of a from-live analysis will join against.
  **Never deleted** -- no age prune, no reset (CJ, 2026-10-09; enforced by
  `test/db/solarNeverDeleted.test.js`). A brand-new table, so
  `schema.sql` alone covers fresh + existing DBs; no migration file.
- `analyzed_logs` -- one row per saved analysis (the offline log analyzer).
  The parsed QSO array lives in `parsed_json` as `{"qsos":[…],"excluded":[…]}`;
  `has_points`/`has_mults`/`has_operator`/`has_run_flag` tell the result
  page which sections the source could populate. **Deliberately separate
  from `qsos`** -- an analysis is a saved artifact and must survive
  `DELETE /api/db`. Retention (`ANALYZE_KEEP` / `ANALYZE_TTL_DAYS`) is
  enforced on every write. See `docs/ANALYZER.md`.

Schema lives in `src/db/schema.sql`. Migrations are numbered files in
`migrations/` and run automatically on startup.

## Configuration

`config/default.json` controls:
- UDP ports (defaults: 12060, 12061, 12062)
- HTTP port (default: 3000)
- DB path (default: ./data/qsos.db)
- Callsign lookup provider: `hamqth` | `none` (see "Callsign Lookup" below;
  `qrz`/`hamdb` are in the config shape but unimplemented)
- HamQTH / QRZ credentials (also via env vars)
- Space weather (`solar`): `enabled`, `refreshMinutes` (default 120),
  no retention setting: solar history is kept forever -- see `src/solar/`

Environment variables override config file. See `.env.example`. A `.env`
in the repo root is loaded at startup by `src/env.js` and never overrides
a variable that's already set (systemd `EnvironmentFile`s win).

**User docs**: `docs/SETUP.md` (LAN / single VPS) and `docs/MULTI-TENANT.md`
(several clubs, by hand) are the user-facing guides. When you change
setup, ports, paths or a tenant/hamdata command, update them too.

## Socket.io Events (server -> client)

- `radio:update` -- RadioInfo payload for one radio
- `contact:new` -- new QSO logged
- `contact:delete` -- QSO deleted in N1MM+
- `score:update` -- current score snapshot
- `lookup:result` -- callsign lookup result (N1MM `<lookupinfo>` or HamQTH);
  the dashboard also uses a `found === false` one to refresh the busts panel
- `solar:update` -- a fresh space-weather reading landed (`src/solar/`)
- `bridge:status` -- a ContestPulse (or other bridge) station's realtime/
  stale/offline status changed
- `db:cleared` -- database was wiped (pre-contest reset)

## REST API

- `GET /api/health` -- for an external monitor (the ops dashboard), not the
  frontend. `{ status: "ok"|"degraded", checks: { db, udp_listeners },
  bridges, lookup, solar }`, 200 on ok / 503 on degraded. `status` is
  strictly about contestscore's own liveness -- SQLite reachable, the three
  UDP sockets actually bound (each listener's own `.bound` flag, set only
  once `dgram`'s async `bind()` callback fires -- see `src/udp/*Listener.js`)
  -- never about whether a contest happens to be producing data right now,
  which isn't this server's fault either way. `bridges`/`lookup`/`solar` are
  informational diagnostics alongside that (same shapes as their own GET
  routes below), not inputs to `status`.
- `GET /api/qsos` -- all QSOs, optional `?band=&mode=&operator=`
- `GET /api/features` -- optional-feature switches the dashboard reads before
  showing/hiding panels: `{ lookup: { provider, enabled }, solar: { enabled } }`.
  Read live from env per request.
- `GET /api/solar` -- newest space-weather reading
  `{ sfi, a, k, sunspots, xray, geomag, updated }`, or `{ updated: null }`
  before the first fetch. Backed by `solar_snapshots`; live updates arrive
  on the `solar:update` socket event.
- `GET /api/busts` -- `{ enabled, busts: [{ call, band, mode, operator,
  logged_at }] }`: logged QSOs whose suffix-stripped call the HamQTH lookup
  marked not-found. `enabled: false` (empty list) when lookup is off, so the
  dashboard hides the panel. Derived fresh from `qsos` + `callsign_cache`
  each call -- a call corrected in the logger stops matching on the next
  fetch. No new socket event: the dashboard re-fetches this on any
  `lookup:result` with `found === false`, on `contact:delete`, and on a 60s
  safety poll.
- `GET /api/score` -- current score
- `GET /api/score/history` -- score time series
- `GET /api/radios` -- current state of all radios
- `GET /api/rate` -- N1MM-style rate meter: QSO count and extrapolated
  QSOs/hour for each of the trailing 10/30/60 minute windows. Purely a
  function of wall-clock time (not an event), so the dashboard polls this
  rather than only refreshing it on contact:new
- `GET /api/bridges` -- realtime/stale/offline status of every station that
  has sent a ContestPulse heartbeat
- `DELETE /api/db` -- clear all QSOs (pre-contest reset, requires `X-Confirm:
  yes`, plus a bearer token if `CONTESTSCORE_API_TOKEN` is set -- see
  `deploy/DEPLOY.md` for the public-deployment case). `public/admin.html` is
  a small UI for this: paste the token, confirm, reset. Deliberately no
  nginx-layer IP restriction on top of the token (see DEPLOY.md) -- the
  token alone is the security boundary.
- `POST /api/ingest/{radio,contact,score}` -- raw N1MM XML bytes from the
  ContestPulse bridge; requires `Authorization: Bearer <CONTESTSCORE_API_TOKEN>`
  and 503s if that env var isn't set (fails closed, no LAN-only fallback)
- `POST /api/ingest/heartbeat` -- `{ "station_id": "..." }` liveness ping
  from ContestPulse, same auth as above

Log analyzer (`src/routes/analyze.js`, see `docs/ANALYZER.md`). Writes need
the same bearer token as `DELETE /api/db`; reading a saved analysis is
public (it's a share link):
- `POST /api/analyze?filename=` -- raw Cabrillo/ADIF text -> a stored
  analysis; returns `{ id, meta }`
- `POST /api/analyze/from-live` -- snapshot the live `qsos` table into an
  analysis (no body)
- `GET /api/analyze` -- `{ items, retention }` saved-analyses index
- `GET /api/analyze/:id` -- **public** -- `{ meta, qsos, excluded }`
- `DELETE /api/analyze/:id` -- remove one

## Key Behaviors and Constraints

**Duplicate QSO handling**: QSOs are identified primarily by N1MM's own `<ID>`
GUID (`ext_id`), upserted so a `contactreplace` edit updates the existing row
in place. A `(call, band, mode, contestnr, mycall)` natural key with
`INSERT OR IGNORE` is the fallback for loggers that never send an `ID` --
that key is now a *partial* index, `WHERE ext_id IS NULL` (migrations/
003_qsos_natural_key_ext_id_only.sql), so it only ever applies to that
fallback case. It used to be a plain table-level UNIQUE(...) covering every
row regardless of ext_id, which meant a WAE QTC report -- a distinct record,
its own `<ID>`, often several in a row to the very same station+band+mode
as an existing QSO -- collided with the natural key despite having a
perfectly good ext_id of its own, and the INSERT just failed outright (a
different unique index than the one ON CONFLICT(ext_id) targets); caught
and logged by safely() in src/udp/index.js, invisible to any viewer. See
`src/db/schema.sql`.

**Score data only from master station**: Only one N1MM station should send
Score broadcasts. The server accepts whatever arrives; the contest operator
is responsible for configuring N1MM correctly.

**Score snapshot can lag the live QSO log**: `score.qsos` comes from N1MM's
own periodic `dynamicresults` broadcast (observed ~10s cadence), not an
event fired per QSO, while the dashboard's QSO list grows in real time off
`contact:new`. A rate fast enough, or a Score broadcast that just doesn't
land for a stretch, can leave `score.qsos` visibly behind the live count.
The dashboard flags this itself (`scoreStale()` in `dashboard.js`) rather
than silently showing a stale total as current -- it self-clears once a
broadcast catches back up. Worth checking first if a viewer ever reports
"the score looks wrong": this is expected eventual-consistency behavior,
not necessarily a dropped packet. **Not** a raw QSO-count comparison
(`qsos.length > score.qsos`) -- a genuine dupe (the same station worked
twice, its own real `contactinfo` packet and `ext_id` each time) legitimately
adds a row to the live log that N1MM's own running qso tally excludes,
which pinned that comparison "stale" forever the first time it shipped
(caught live on scoreboard.wt2p.us during CW-OPS 2026-09-16). Compares
timestamps instead: whether a QSO landed after the score's own
`captured_at`, and whether enough time has passed since then that a fresh
snapshot should have caught up by now.

**Multi-op radio identity**: `radio_state` is keyed by
`(station_name, radio_nr)`, not `radio_nr` alone. N1MM's RadioNr is only
unique within one PC's own config -- in a multi-op with separate physical
stations, each PC typically numbers its own radio starting at 1 too, and
radio_nr alone would let one station's "Radio 1" silently overwrite
another's. See `migrations/001_radio_state_composite_key.sql`.

**No ORM**: Use better-sqlite3 prepared statements directly. This is a
single-process app with predictable query patterns. An ORM is overkill and
adds startup latency on a Pi.

**Synchronous DB writes**: better-sqlite3 is synchronous. That is fine.
The UDP packet rate during a contest is not high enough to matter. Do not
introduce async DB abstractions.

**Parser errors must not crash the server**: Wrap all XML parsing in
try/catch. Log malformed packets with the raw buffer for debugging. Continue.

**Frontend has no build step**: All JS is ES modules loaded directly in the
browser via `<script type="module">`. Alpine.js via CDN. No webpack, no Vite,
no transpilation. This dashboard runs on a Pi on a local network, not in
production cloud infra.

**Dark mode by default**: The original dashboard had a dark theme. Match it.
Dashboard should be readable on a TV across the room.

## Testing Approach

- Parser unit tests: feed raw XML strings, assert output objects. Fast, no
  network, no DB.
- UDP integration tests: spin up a test UDP sender, verify the full
  listener -> parser -> DB -> socket.io pipeline. Use a temp DB file.
- REST integration tests (`test/routes/`): in-memory SQLite, a real
  `http.Server`, `fetch` against it.
- Analyzer tests (`test/analyze/`): the Cabrillo/ADIF parsers, the cty
  resolver, one fixture per contest exchange grammar, and round trips
  (manual form -> Cabrillo -> `analyzeLog`; live rows -> `analyzeLiveQsos`).
  The pure suites also run under Deno on a machine without Node
  (`deno test --allow-read --no-check --unstable-detect-cjs`).
- ContestPulse has its own Go tests (`contestpulse/*_test.go`, run in CI by
  `.github/workflows/contestpulse-build.yml`).
- No E2E browser tests for now; the frontend is thin enough to test manually.

Run tests: `npm test`

## Common Development Tasks

Start the server:
```
npm start
```

Start with auto-reload:
```
npm run dev
```
(uses nodemon)

Send a test UDP packet (simulate N1MM score broadcast):
```
npm run test:send-score
```
(scripts/sendTestPacket.js accepts --type radio|contact|score)

Replay a captured real contest as live traffic (club demo / presentation,
as opposed to sendTestPacket.js's synthetic data):
```
node tools/demo/snapshot.js
node tools/demo/replay.js --reset --duration 8
```
See tools/demo/README.md.

Clear the database:
```
curl -X DELETE http://localhost:3000/api/db -H "X-Confirm: yes"
```

## N1MM+ UDP Packet Format Reference

N1MM sends XML wrapped in a UDP datagram. The XML root element identifies
the packet type:

- `<RadioInfo>` -- radio state
- `<ContactInfo>` -- new or updated QSO
- `<Score>` -- score update
- `<lookupinfo>` -- external callsign lookup result

Full schema documentation: https://n1mmwp.hamdocs.com/appendices/external-udp-broadcasts/

TR4W uses compatible formats on the same ports.

## Deployment (Raspberry Pi)

Target: Raspberry Pi 4, Raspberry Pi OS (64-bit), Node 18+.

```
npm install --production
npm start
```

Dashboard available at `http://<pi-hostname>.local:3000`

To run as a service, use the provided `contestscore.service` systemd unit file.

## Callsign Lookup

`src/lookup/` -- a **live-dashboard-only** subsystem. `src/analyze/` must
never import it (a saved analysis has to be reproducible offline). Provider
via `config/default.json` `lookup.provider` or `LOOKUP_PROVIDER`:

- `hamqth` -- the only implemented provider. Free account; creds via
  `HAMQTH_USERNAME` / `HAMQTH_PASSWORD` (env, or `lookup.hamqth` in config).
  Session-token XML API (`src/lookup/hamqth.js`); token cached ~55 min,
  refreshed on expiry.
- `qrz`, `hamdb` -- present in the config shape and the docs' history, but
  not implemented. Don't claim they work.
- `none` (default) -- `createLookupService` returns an inert object;
  `enqueue()` is a no-op.

`src/udp/index.js` calls `lookup.enqueue(call)` on every `contact:new`
(covers `contactreplace` too). The service strips portable suffixes
(`stripSuffix`), skips anything with a *fresh* `callsign_cache` row (any
source; `src/lookup/ttl.js`: ~6 months found, a day not-found) or
already queued/in-flight, then works the queue **one request at a time**
with a ~350 ms gap and exponential backoff on error -- an upstream outage
only slows the queue, it can't touch the dashboard. Each result is emitted
as `lookup:result` (the same event N1MM's own `<lookupinfo>` uses); the
`udp/index.js` handler is the single writer to `callsign_cache`, tagging the
row with `data.source` (`'n1mm'` or `'hamqth'`). `prime()` runs once at
startup to back-fill lookups for QSOs already logged (restart mid-contest).

This is the first outbound HTTP the Node process makes (ContestPulse aside,
which is a separate Go program). Keep it that way by default: nothing here
blocks, and every failure path logs and continues.

Results are cached in `callsign_cache` for ~6 months (CJ, 2026-10-09:
callsigns rarely change) -- a "not found" for a day, so a new licensee
isn't a bust for half a year. The rules live in `src/lookup/ttl.js`, shared
with hamdata. **`DELETE /api/db` does NOT clear the cache** (a pre-contest
reset would otherwise re-look-up every call); `DELETE /api/lookup/cache`
(token + `X-Confirm`, the Admin page's "Clear Callsign Cache") does.

**Runtime pause/resume** (`public/admin.html` "Callsign Lookup" card):
`svc.pause()`/`svc.resume()` on the service returned by `createLookupService`
(exposed to routes via `getLookupService()` in `src/udp/index.js`) are a
mid-contest kill switch, separate from whether a provider was configured
at all. `GET /api/lookup/status`, `POST /api/lookup/pause` / `.../resume`
(same optional bearer-token gate as `DELETE /api/db`, but no `X-Confirm` --
this is instantly reversible) sit in `src/routes/api.js`. The paused state
is **persisted** (`settings.lookup_paused`), so it survives a restart or
deploy. With hamdata, `GET /api/lookup/status` also reports
`upstream_paused`: the box operator stopped outgoing lookups for everyone
(`hamdata-ctl stop-lookups`); the hamdata client raises `HAMDATA_PAUSED`
for those 503s and the queue logs it once instead of per call. Pausing doesn't
just stop new `enqueue()` calls; it drops whatever's already queued too
(clearing their `pending` entries as well, so they aren't stuck
"already queued" forever) -- an immediate stop for a multi-op that decides
the lookup traffic itself needs to go away, not a slow drain. Already-
cached results (and the busts panel built from them) are unaffected either
way; only *new* lookups stop.

**Possible Busts panel** (`public/index.html` `#busts`): a dashboard card
listing logged QSOs whose call HamQTH didn't recognise -- a likely miscopy.
Server side it's just `GET /api/busts` joining `qsos` against the
not-found `callsign_cache` rows (`json_extract(data,'$.found') = 0`,
`source = 'hamqth'`) on the suffix-stripped call. Client side it's gated on
`features.lookup.enabled` AND a non-empty list, so it's invisible unless
lookup is on and something is actually flagged. Deliberately not a stored
flag table -- deriving it fresh means a correction in the logger clears it
with no extra bookkeeping. It empties when the QSOs go (`DELETE /api/db`)
or the cache does. Dashboard only; the analyzer has no equivalent.

## Space Weather

`src/solar/` polls `hamqsl.com/solarxml.php` (N0NBH's feed) every
`refreshMinutes` (default 120 -- the data barely moves faster), parses out
SFI / A / K / sunspots with `xml2js`, appends each fetch to
`solar_snapshots`, and emits `solar:update`. `createSolarService({ io })`
is started from `server.js` alongside `startMonitor`; its timer is
`unref()`ed so it never holds the process open. A failed fetch logs and
leaves the last good reading in place -- like the lookup queue, an upstream
outage can't touch the core dashboard.

`GET /api/solar` reads the newest row straight from `solar_snapshots`
(`latestSolar()`), so the header chip survives a restart with no gap. The
persisted **history** is the real reason for the table: a later feature
will join `solar_snapshots.fetched_at` against a from-live analysis's time
span to chart QSO rate vs. conditions (noted in `docs/ANALYZER.md`'s "Not
done"). Manually-uploaded logs get nothing -- there's no captured solar for
an arbitrary past date.

Dashboard header only; `SOLAR_ENABLED=false` disables the poll and the
chip. The analyzer never triggers a fetch.

## Tenant mode (hosted club scoreboards)

`CONTESTSCORE_TENANT=<call>` (+ optional `CONTESTSCORE_TENANT_NAME`) marks
an instance as one club's scoreboard on a shared VPS -- see `src/tenant.js`.
Everything about it lives there and is read from env per request:
- The **Admin page stays available** (CJ, 2026-10-09): each club resets
  its own contest data, switches its own lookups on/off and clears its own
  callsign cache. Every one of those actions needs the club's token, and
  `server.js` refuses to start in tenant mode without
  `CONTESTSCORE_API_TOKEN` -- or without `HAMDATA_URL`, or with a
  malformed id -- so a hosted admin page can never be open.
- `GET /api/features` gains `tenant: { call, name }` (null standalone).
  The header and tab title stay "ContestPulse" (CJ, 2026-10-08): the
  station call already shows in the score panel.
- The analyzer and ingest are unchanged: both gated by this instance's own
  `CONTESTSCORE_API_TOKEN`, which in tenant mode is the club's token.
- **No UDP sockets** (`src/udp/index.js`): a tenant only receives
  ContestPulse's authenticated HTTPS ingest. The handlers are still wired,
  so ingest works; `getUdpListeners()` is null, which `/api/health` reads
  as nothing-to-check. (An open UDP port on a VPS is an unauthenticated
  way to inject QSOs, and tenants would collide on the same ports.)

`src/env.js` loads **no** `.env` in tenant mode -- every tenant shares the
checkout, so a stray `.env` would otherwise apply to all of them.

On the box, tenants are `contestscore@<id>.service` instances
(`deploy/contestscore@.service`) of the one code checkout, each with
`/opt/contestscore/tenants/<id>/{tenant.env,data/}`, managed only through
`deploy/contestscore-tenant` (create/list/show/suspend/resume/export/
delete; installed to `/usr/local/sbin` by the deploy script, which also
restarts every running instance).

**Suspending a tenant keeps its hostname answering** (2026-10-10): each
scoreboard hostname routes straight at `127.0.0.1:<tenant port>` (a
Cloudflare Tunnel ingress entry here), so a stopped instance leaves nothing
listening and the visitor gets Cloudflare's own "Bad Gateway / host error"
page -- as if the whole box were down. `suspend` now also starts
`contestscore-offline@<id>.service` (`deploy/offline-server.js`), which
binds the same port and answers everything with a styled
"temporarily offline" page in wt2p.us's amber-on-black; `resume`/`delete`
stop it, and the unit `Conflicts=` the real one so they can't fight over
the port. Deliberately dependency-free with the HTML inlined (it must start
mid-deploy, and it is not part of the app), enabled alongside the suspend so
a reboot still shows it, and **503, not 200** -- so monitors and
search engines don't take it for the scoreboard, and ContestPulse's contact
hold keeps retrying its QSOs instead of dropping them. Its colours are
wt2p.us's own `:root` tokens, the same set `dashboard.css`'s `wt2p` theme
copies -- change one, consider the other. The deploy script also *converges*
this: any tenant whose real unit is `disabled` gets the stand-in enabled and
restarted on every deploy, so tenants suspended before this existed are
covered without a manual step.

## hamdata (shared solar + lookup)

`hamdata/` is a small Express service for a box running **several**
contestscore instances (one per club/callsign). It polls hamqsl once and
holds the one set of HamQTH credentials; each instance sets `HAMDATA_URL`
and asks it instead of doing either itself. **Optional by design**: with
`HAMDATA_URL` unset (the default) nothing changes -- a Pi/LAN install never
runs or knows about hamdata.

It is built from this repo's own modules, never a copy, so the two paths
can't drift:
- `hamdata/server.js` -- `initDb()` on its own file (`HAMDATA_DB_PATH`,
  same schema; only `solar_snapshots` and `callsign_cache` are written),
  `createSolarService` exactly as an instance runs it, and a HamQTH client
  from `src/lookup/hamqth.js`. It forces `HAMDATA_URL` empty for itself.
- `hamdata/broker.js` -- answers one lookup at a time: shared cache (same
  TTLs as instances, `src/lookup/ttl.js`; only `source = 'hamqth'` rows),
  collapses
  duplicate in-flight calls, spaces upstream requests 350 ms apart across
  *all* instances. 503 when paused/unconfigured, 502 on upstream failure.
- `hamdata/app.js` -- `GET /health`, `/solar`, `/solar/since?after=`,
  `/lookup/status`, `/lookup/:call`; `POST /lookup/pause|resume` need
  `HAMDATA_TOKEN` (fail closed). Binds `127.0.0.1:3100` by default.
  `DELETE /lookup/cache` (token + `X-Confirm`) clears the shared cache.
- **Global stop** (CJ, 2026-10-09: HamQTH lookups use the operator's own
  account): `POST /lookup/pause` stops ALL outgoing lookups for every
  instance, persisted in hamdata's `settings`, so a restart never turns
  them back on. Cache hits are still answered; misses get
  `503 { code: 'paused' }`. Operator tool: `deploy/hamdata-ctl`
  (`status|stop-lookups|start-lookups|clear-cache`, installed to
  `/usr/local/sbin` by the deploy script).
- `hamdata/import-solar.js` -- one-time seed of hamdata's history from an
  existing instance's DB.

Instance side (`src/hamdata/client.js`), all switched on by `HAMDATA_URL`:
- **Lookup**: `resolveLookupConfig` returns provider `hamdata` (wins over
  HamQTH creds) -- unless the *environment* says `LOOKUP_PROVIDER=none`,
  which turns one tenant's lookups off (config/default.json's `none` is
  only a default and doesn't count). A hamdata with no HamQTH account
  answers misses `503 {code:'disabled'}` -> `HAMDATA_DISABLED`, logged
  once like `HAMDATA_PAUSED`; `/api/lookup/status` reports
  `upstream_enabled: false` and the Admin page shows Off. The client has the same `lookup(call)` shape as the HamQTH
  client, so the queue / pacing / backoff / pause in `src/lookup/index.js`
  is untouched. Results keep hamdata's `source: 'hamqth'`, so the
  instance's own `callsign_cache` and the busts panel behave identically.
- **Solar**: the poller copies rows from `/solar/since` into the
  instance's **own** `solar_snapshots` every 10 min, keeping hamdata's
  `fetched_at`. Every reader (`/api/solar`, `/api/solar/history`, the
  analyzer, `/api/health`) is unchanged, and a new instance back-fills the
  whole history on its first poll (paged, 1000 rows a request).

## What Is NOT in Scope

Two hard rules that don't move:
- The realtime results view stays the priority. An aid that slows it,
  clutters it, or fights it for attention on the main screen belongs on
  its own page or behind a toggle.
- The **offline analyzer makes no network calls** -- no lookup, no solar
  fetch. A saved analysis has to be reproducible offline.

**Still out, but "would need a concrete case" rather than "never":**
- DX cluster / RBN spot display, with or without a map. contestscore does
  not parse, store, or relay N1MM's `<spot>` broadcasts -- `src/udp/
  contactListener.js` explicitly and silently ignores them (see its
  comment) rather than treating an unrecognized packet as a bug to fix.
  N1MM already has its own direct spot integrations (e.g. to FlexRadio);
  sitting in the middle of that is a different product. This one has a
  standalone rationale beyond "not results," so it's the least likely to
  be revisited.
- Streaming-overlay mode, Pi system monitoring, weather/lightning alerts.
  Not results, and not something the operator reaches for mid-QSO. No
  plans -- bring a specific need.

**Not yet, but plausible later** (these ARE about contest results, just
not built):
- N3FJP support (protocol unknown, needs reverse engineering)
- RumLog / DXLog (spotty in the original; tackle after N1MM is solid)
- Multi-server aggregation (one dashboard aggregating multiple contestscore
  instances across sites)
- Authentication (local network tool, no auth planned)
- Log analyzer deferrals (a scoring engine for bare Cabrillo, in-browser
  "quick look", N-way compare) -- see the "Not done" list in
  `docs/ANALYZER.md`.
