# contestscore

A real-time ham radio contesting dashboard. Replaces the Node-RED-based
Node-Red-Contesting-Dashboard with a clean, maintainable Node.js application
that does the same job without the visual flow editor overhead.

## What This Does

Listens for UDP broadcast packets from contesting logging software (N1MM+,
TR4W, DXLog) and displays a live dashboard in the browser. Operators at
networked contest stations broadcast radio state, QSO data, and score data
over UDP; this server ingests those packets, stores them in SQLite, and pushes
updates to connected browsers in real time via WebSockets.

## Architecture

```
UDP :12060  (Radio broadcast)      -->  src/udp/radioListener.js
UDP :12061  (Contacts + Callsign)  -->  src/udp/contactListener.js
UDP :12062  (Score broadcast)      -->  src/udp/scoreListener.js
                |
                v
        src/parsers/          (XML -> JS objects, one file per packet type)
                |
                v
        src/db/               (better-sqlite3, synchronous writes)
                |
                v
        src/socket/           (socket.io, broadcasts state to browsers)
                |
                v
        public/               (HTML/CSS/JS dashboard, no build step)
```

HTTP server (Express) on port 3000 serves the dashboard and a REST API for
historical data. Socket.io runs on the same port.

## Tech Stack

- Runtime: Node.js 18+
- Web server: Express 4
- Real-time: socket.io 4
- Database: better-sqlite3 (synchronous, no async hell, Pi-friendly)
- XML parsing: xml2js
- UDP: Node built-in dgram module
- Frontend: Vanilla JS + Alpine.js (CDN, no build step)
- No TypeScript, no bundler, no framework. This runs on a Raspberry Pi.

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
    js/
      dashboard.js          # socket.io client, DOM updates
    css/
      dashboard.css
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

N1MM+ broadcasts XML over UDP. Packet schemas (from N1MM documentation):

### RadioInfo (:12060)
Fields we care about: `StationName`, `Freq`, `TXFreq`, `Mode`, `OpCall`,
`IsRunning`, `FocusEntry`, `Antenna`, `Rotator`, `FocusRadioNr`, `RadioNr`

### ContactInfo (:12061)
Fields: `call`, `band`, `mode`, `operator`, `mycall`, `timestamp`,
`contestname`, `srx`, `stx`, `snt`, `rcv`, `mult1`, `mult2`, `IsMultiplier1`,
`IsMultiplier2`, `points`, `exchange1`, `section`, `RoverLocation`,
`RadioInterfaced`, `NetworkedCompNr`

### Score (:12062)
Fields: `contest`, `call`, `operators`, `power`, `assisted`, `transmitted`,
`band`, `mode`, `qsos`, `points`, `mults`, `mults2`, `total`, `timestamp`

### ExternalCallsignLookup (:12061, same port as contacts)
Disambiguate by XML root element name.

## Database Schema (SQLite)

Core tables:
- `qsos` -- one row per logged QSO
- `radio_state` -- latest state per radio (upsert by RadioNr)
- `score_snapshots` -- time-series score history
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
- `score:update` -- current score snapshot
- `lookup:result` -- callsign lookup result
- `db:cleared` -- database was wiped (pre-contest reset)

## REST API

- `GET /api/qsos` -- all QSOs, optional `?band=&mode=&operator=`
- `GET /api/score` -- current score
- `GET /api/score/history` -- score time series
- `GET /api/radios` -- current state of all radios
- `DELETE /api/db` -- clear all QSOs (pre-contest reset, requires confirm header)

## Key Behaviors and Constraints

**Duplicate QSO handling**: N1MM in network mode can send contacts from
multiple PCs. The `qsos` table has a unique constraint on
`(call, band, mode, contestname, mycall)` with INSERT OR IGNORE semantics.
The INSTALL notes explain the two valid N1MM configs; support both, handle
dupes gracefully at the DB layer.

**Score data only from master station**: Only one N1MM station should send
Score broadcasts. The server accepts whatever arrives; the contest operator
is responsible for configuring N1MM correctly.

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

## What Is NOT in Scope (Yet)

- N3FJP support (protocol unknown, needs reverse engineering)
- RumLog / DXLog (spotty in the original; tackle after N1MM is solid)
- Multi-server aggregation (future: one dashboard aggregating multiple
  contestscore instances across sites)
- Authentication (local network tool, no auth planned)
