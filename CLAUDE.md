# contestscore

A real-time ham radio contesting dashboard. Inspired by the Node-RED-based
Node-Red-Contesting-Dashboard, rebuilt as a clean, maintainable Node.js
application.

## Prime Directive

Display realtime contest results -- radio state, QSOs, and score. That's
it. This is **not** a goal of feature-parity with the original Node-RED
dashboard, which also had DX cluster/RBN spot display with a map, a
streaming-overlay mode, Pi system monitoring, and several other panels
unrelated to contest results themselves. Those are out of scope on
purpose, not "not yet" -- don't add them just because the original had
them. If a feature request isn't about showing contest results in real
time, it needs its own explicit justification, not an appeal to matching
the original.

The **offline log analyzer** (`/analyze`, `docs/ANALYZER.md`) is the one
sanctioned exception, agreed with the maintainer. It shows the *same*
contest-results breakdowns for a whole log that's already finished --
uploaded, pasted, or snapshotted from the live DB -- and it does so by
reusing the Stats/Charts rendering, adding one nav link. It is contest
results, just post-hoc. It is **not** a licence to add non-results
features to the analyzer either (a scoring engine, spot overlays, etc.).

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
    routes/
      api.js                # REST endpoints for historical data
      ingest.js             # POST /api/ingest/* (ContestPulse HTTP transport)
      analyze.js            # POST/GET/DELETE /api/analyze* (the log analyzer)
    app.js                  # Express setup, mounts routes, serves /analyze + /compare shells
    server.js               # entry point: starts HTTP + UDP
  public/
    index.html              # dashboard shell
    charts.html             # trend charts + spec-driven "more charts" grid
    stats.html              # SH5/CBS-style post-contest breakdown tables
    analyze.html            # analyzer: upload / manual / live tabs + result landing
    compare.html            # two analyses side by side
    admin.html              # DB reset UI
    js/
      dashboard.js          # socket.io client, DOM updates
      charts.js             # Chart.js; ?log=<id> loads a saved analysis instead of the live feed
      stats.js              # stats tables; same ?log=<id> hook
      analyze.js            # analyzer page logic (upload/manual/live/compare/saved list)
      compare.js            # log-vs-log comparison
      manual.js             # buildManualCabrillo(): manual form -> Cabrillo string
      report.js             # renderReport() HTML + renderReportText() plain-text summary for a saved analysis
      chrome.js             # shared header/nav/footer; highlights Analyze when URL has ?log=
      admin.js
    css/
      dashboard.css         # shared by every page
  contestpulse/             # standalone Go relay (LAN UDP -> HTTPS ingest); see "ContestPulse Bridge"
  config/
    default.json            # ports, DB path, feature flags
  migrations/               # numbered SQL migration files, run on startup
  deploy/                   # DEPLOY.md + the production deploy script + nginx/systemd units
  docs/
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
`FocusRadioNr`, `ActiveRadioNr`. This is the one packet type whose casing and
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
- `radio_state` -- latest state per radio (upsert by RadioNr)
- `score_snapshots` -- one row per (band, mode) entry from each `Score`
  broadcast's `<breakdown>`, plus a `band='total' mode='ALL'` row per
  broadcast holding the contest grand total (`is_total = 1`). All rows from
  one broadcast share the same `captured_at`, since a single Score packet
  reports the whole contest snapshot, not just one band -- treating "most
  recently inserted row" as "the current score" (the original design) is
  wrong for any multi-band contest.
- `settings` -- key/value config (contest name, operator, etc.)
- `callsign_cache` -- lookup results to avoid re-querying QRZ/HamDB
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

Environment variables override config file. See `.env.example`.

## Socket.io Events (server -> client)

- `radio:update` -- RadioInfo payload for one radio
- `contact:new` -- new QSO logged
- `contact:delete` -- QSO deleted in N1MM+
- `score:update` -- current score snapshot
- `lookup:result` -- callsign lookup result
- `bridge:status` -- a ContestPulse (or other bridge) station's realtime/
  stale/offline status changed
- `db:cleared` -- database was wiped (pre-contest reset)

## REST API

- `GET /api/qsos` -- all QSOs, optional `?band=&mode=&operator=`
- `GET /api/features` -- optional-feature switches the dashboard reads before
  showing/hiding panels; currently `{ lookup: { provider, enabled } }`. Read
  live from env per request.
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
`INSERT OR IGNORE` is the fallback for loggers that never send an `ID`. See
`src/db/schema.sql`.

**Score data only from master station**: Only one N1MM station should send
Score broadcasts. The server accepts whatever arrives; the contest operator
is responsible for configuring N1MM correctly.

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
(`stripSuffix`), skips anything already in `callsign_cache` (any source) or
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

Results are cached in `callsign_cache` to avoid re-querying during a
contest; the cache is cleared on `DELETE /api/db`.

**Possible Busts panel** (`public/index.html` `#busts`): a dashboard card
listing logged QSOs whose call HamQTH didn't recognise -- a likely miscopy.
Server side it's just `GET /api/busts` joining `qsos` against the
not-found `callsign_cache` rows (`json_extract(data,'$.found') = 0`,
`source = 'hamqth'`) on the suffix-stripped call. Client side it's gated on
`features.lookup.enabled` AND a non-empty list, so it's invisible unless
lookup is on and something is actually flagged. Deliberately not a stored
flag table -- deriving it fresh means a correction in the logger clears it
with no extra bookkeeping, and it's wiped by `DELETE /api/db` for free
(the cache is). Dashboard only; the analyzer has no equivalent.

## What Is NOT in Scope

**Permanently out of scope** (see Prime Directive -- these aren't contest
*results*, so matching the original dashboard isn't a reason to add them):
- DX cluster / RBN spot display, with or without a map. contestscore does
  not parse, store, or relay N1MM's `<spot>` broadcasts -- `src/udp/
  contactListener.js` explicitly and silently ignores them (see its
  comment) rather than treating an unrecognized packet as a bug to fix.
  N1MM already has its own direct spot integrations (e.g. to FlexRadio);
  this app doesn't need to duplicate or sit in the middle of that.
- Streaming-overlay mode, Pi system monitoring, weather/lightning alerts,
  and the other original panels unrelated to contest results themselves.

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
