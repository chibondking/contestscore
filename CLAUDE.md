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

None of the three page scripts (`dashboard.js`/`admin.js`/`charts.js`) are
loaded as `type="module"` -- see the comment on each page's `<script>` tag.
A module's top-level declarations don't land on the global scope Alpine
evaluates `x-data="..."` against, so a module-loaded page silently fails to
initialize at all. This bit the dashboard once already (see git history);
don't reintroduce it on a new page.

## Project Structure

```
contestscore/
  src/
    udp/
      radioListener.js      # dgram socket on :12060
      contactListener.js    # dgram socket on :12061
      scoreListener.js      # dgram socket on :12062
      index.js              # starts all listeners, wires to emitter
    parsers/
      radio.js              # parses RadioInfo XML
      contact.js            # parses ContactInfo XML
      score.js              # parses Score XML
      lookup.js             # parses ExternalCallsignLookup XML
    db/
      index.js              # opens DB, runs migrations
      schema.sql            # table definitions
      queries.js            # all prepared statements
    socket/
      index.js              # socket.io setup, event->broadcast mapping
    routes/
      api.js                # REST endpoints for historical data
    app.js                  # Express setup, mounts routes
    server.js               # entry point: starts HTTP + UDP
  public/
    index.html              # dashboard shell
    charts.html             # rate-over-time / score-over-time trend charts
    admin.html              # DB reset UI
    js/
      dashboard.js          # socket.io client, DOM updates
      charts.js             # Chart.js line charts, polled not socket-driven
      admin.js
    css/
      dashboard.css         # shared by all three pages
  config/
    default.json            # ports, DB path, feature flags
  migrations/               # numbered SQL migration files
  test/
    parsers/                # unit tests for parser logic
    udp/                    # integration tests with mock UDP senders
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

Schema lives in `src/db/schema.sql`. Migrations are numbered files in
`migrations/` and run automatically on startup.

## Configuration

`config/default.json` controls:
- UDP ports (defaults: 12060, 12061, 12062)
- HTTP port (default: 3000)
- DB path (default: ./data/qsos.db)
- Callsign lookup provider: `qrz` | `hamdb` | `none`
- QRZ credentials (also via env vars)

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

Providers (configured in `config/default.json`):
- `hamdb` -- free, limited DXCC coverage, no credentials needed
- `qrz` -- requires XML subscription, credentials via env or config
- `none` -- disables lookup

Results are cached in the `callsign_cache` table to avoid re-querying during
a contest. Cache is cleared on DB reset.

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
