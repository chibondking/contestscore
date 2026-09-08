# contestscore

Real-time ham radio contesting dashboard. Listens for UDP broadcasts from
[N1MM+](https://n1mmwp.hamdocs.com/) (and compatible loggers like TR4W) and
displays a live score, radio state, QSO log, and per-operator breakdown in
the browser.

Runs standalone on a Raspberry Pi on a shack LAN with no cloud and no auth,
or behind a reverse proxy as a public scoreboard (with a bearer-token-
protected ingest API and a small Go relay, **ContestPulse**, to get N1MM's
LAN-local broadcasts there — see below). No build step either way.

**Prime directive**: display realtime contest results — radio state, QSOs,
score — and nothing else. DX cluster/RBN spots, a streaming-overlay mode,
and the other non-score panels from the original Node-RED dashboard this
project was inspired by are permanently out of scope, not "not yet". See
`CLAUDE.md` for the full reasoning and the current N1MM wire-format notes.

## Requirements

- Node.js 18+
- N1MM+ (or TR4W) configured to broadcast UDP on the local network

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:3000` in a browser. The dashboard updates in real time
as packets arrive.

```bash
npm run dev        # auto-reload with nodemon
npm test           # run the test suite
```

## Simulating N1MM traffic (no radio required)

```bash
# Default: 5-QSO session — radio state, contacts, and score updates
node scripts/sendTestPacket.js

# Options
node scripts/sendTestPacket.js --count 20 --delay 500
node scripts/sendTestPacket.js --type radio
node scripts/sendTestPacket.js --type contact --count 3
node scripts/sendTestPacket.js --type score
node scripts/sendTestPacket.js --type lookup
node scripts/sendTestPacket.js --mycall K1TTT --contest CQWW-CW
node scripts/sendTestPacket.js --host 192.168.1.255  # broadcast to LAN
```

`--type session` (the default) sends two radio-state packets then `--count`
contacts, each followed by a score update.

## N1MM+ configuration

In N1MM+, go to **Config → Configure Ports, Mode Control, Winkey, etc.** and
enable UDP broadcasts on the **Broadcast Data** tab:

| Broadcast type | Port  |
|----------------|-------|
| Radio          | 12060 |
| Contact/Lookup | 12061 |
| Score          | 12062 |

Set the destination to the broadcast address of your shack LAN (e.g.
`192.168.1.255`) or `255.255.255.255`. All machines on the LAN, including the
Pi running contestscore, will receive the packets.

Only one station should send **Score** broadcasts; configure N1MM+ on the
master/logging PC accordingly. In a multi-op with separate physical
stations, each radio's `radio_state` row is keyed by `(station_name,
radio_nr)`, not `radio_nr` alone — N1MM's own RadioNr is only unique within
one PC's config, so two stations can each report "Radio 1" without one
overwriting the other.

Port labels aren't trusted, either: every UDP listener and every
`/api/ingest/*` route dispatches by the packet's own XML root element
(`src/udp/dispatch.js`), not by which port it arrived on. This has mattered
in practice — a live deployment had a third-party CAT program's own spot
listener claiming N1MM's documented Contacts port, and a separate capture
showed a Score broadcast landing on whatever port that station's config
called "radio port." Content-based dispatch handles either case
transparently instead of silently dropping real data.

## Architecture

```
N1MM+ (UDP broadcast, LAN-only)         ContestPulse (remote bridge)
  :12060  RadioInfo    ---\                    |
  :12061  ContactInfo   |-- src/udp/dispatch.js  POST /api/ingest/{radio,contact,score}
  :12062  Score        ---/    (routes by XML       + /api/ingest/heartbeat
                                 root element,             |
                                 not by port)               |
              │                                             │
              └──────────────────────┬──────────────────────┘
                                      ▼
                              src/parsers/          XML → plain JS objects
                                      │
                                      ▼
                              src/db/               better-sqlite3, synchronous writes
                                      │
                                      ▼
                              src/socket/           socket.io, broadcasts to browsers
                                      │
                                      ▼
                              public/               Alpine.js dashboard, no build step
```

Express (port 3000) serves the dashboard and a REST API. Socket.io runs on
the same port. Both the raw-UDP path (LAN-only install) and the
ContestPulse-relayed HTTP path (remote/public deployment) run every packet
through the exact same parser/DB/emit functions — the ingest routes are
just a second transport into `src/udp/dispatch.js`, not a separate code path.

## Dashboard pages

- **`/` (Dashboard)** — live Score and Rate cards (each with a small trend
  sparkline), Radios (band only — see Privacy below — plus a red/green
  TX/RX dot per radio from N1MM's own `IsTransmitting` flag), an Operators
  table (QSOs, points, peak rate in the last 60 and 10 minutes per
  operator), the last 20 QSOs, and a by-continent QSO breakdown. The header
  carries the connection status, the current ContestPulse feed status per
  station, and the contest's grid locator (from the Score broadcast's
  `<qth>` data). When a logger doesn't send `continent`/`zone`/
  `countryprefix` on a QSO (TR4W, older N1MM), the server fills them from
  the bundled country file — the same `enrichGeo` the log analyzer uses
  (`src/analyze/geo.js`), fill-only, never overriding the packet.
- **`/charts.html` (Charts)** — the visual counterpart to the Stats page.
  Top of page: QSO rate and score over time, plus a QSOs-by-operator bar
  chart. A **Detailed view** toggle (off by default, remembered per-browser)
  reveals three per-operator time series: rate, score contribution, and
  multiplier contribution. Below that, always shown once there's data, a
  "more charts" grid: cumulative QSOs / points / multipliers; QSOs by band,
  by continent, and run vs. S&P **over time** (stacked); band, mode, and
  continent share; multipliers by band; QSOs by hour of day; and
  points-per-QSO, callsign-length, and rate distributions. That grid is
  spec-driven — one `{ id, title, build() }` entry per chart in
  `EXTRA_CHART_SPECS`, rendered through a single generic `renderExtra()`.
  All bucketing is sized automatically from the span of logged QSOs so a
  2-hour club contest and a 48-hour DX contest both render a readable number
  of points. Charts update live via the same socket events the main
  dashboard uses; time is keyed off `logged_at` (not N1MM's QSO timestamp —
  that's the Stats page's choice).
- **`/stats.html` (Stats)** — a post-contest analysis report in the spirit
  of SH5 / CBS. Kept at the top: the band × mode / multiplier breakdown,
  one table per operator plus a combined "All Operators" table (columns are
  QSO and multiplier counts split into CW / PH / DG groups). Below that:
  **At a Glance** headline numbers; **Rate Records** (best sliding 60 / 30 /
  10 min, best clock hour, first/last QSO, longest gap); **Station Summary**
  by band & mode with points/QSO; **Operator Leaderboard** (Q, points,
  mults, run %, best 60′, bands, DXCC, pts/Q); an **Hourly Breakdown** with
  cumulative columns and the peak hour highlighted; **Run vs. S&P** by band;
  **Multipliers by Band**; **QSOs by Continent & Band**; **Top DXCC
  Entities**; **Points-per-QSO** and **Callsign Length** distributions; and
  **CQ Zones** / **Sections** worked. The header dropdown scopes every
  section (except the leaderboard) to one operator. All computed client-side
  from `/api/qsos` and live-refreshed via the same socket events the main
  dashboard uses; unlike the Charts page it keys time off N1MM's own QSO
  timestamp rather than server ingestion time (see `stats.js` `qsoTime()`).
- **`/analyze` (Analyze)** — upload a submitted Cabrillo (`.cbr`/`.log`) or
  ADIF (`.adi`) log and get the full Stats + Charts treatment for it, saved
  at a shareable `/analyze/<id>` link. The file is parsed server-side and
  each worked call is resolved against a bundled country file
  (`src/analyze/cty.csv`) to fill in continent / DXCC / CQ zone, so the
  geographic breakdowns work for any contest. For ~20 common contests
  (CQ WW/WPX/160, WAE, IARU, Stew Perry, ARRL SS/DX/FD/10/RTTY-RU, NAQP,
  NA Sprint, state QSO parties — see `src/analyze/contests.js`) the
  exchange itself is parsed too: real sections, serials and zones straight
  from the log rather than inferred. Removed (`X-QSO`) lines are surfaced
  but kept out of every count, and `/compare?a=<id>&b=<id>` puts two saved
  analyses side by side with per-metric and per-band deltas. An ADIF export
  from N1MM also
  carries points, multipliers, per-operator and run/S&P data; a bare
  Cabrillo doesn't, so those sections are hidden for it. Upload is gated by
  `CONTESTSCORE_API_TOKEN` (paste it on the page, same as Admin); viewing a
  saved analysis is public. Stored separately from the live `qsos` table —
  a pre-contest reset never touches it. Retention: newest `ANALYZE_KEEP`
  (200) and younger than `ANALYZE_TTL_DAYS` (365). See `docs/ANALYZER.md`.
- **`/admin.html` (Admin)** — reset the contest database before a contest
  starts. Shows the current QSO count and score total, requires the admin
  bearer token plus a confirmation checkbox, and is otherwise the only
  place in the app with anything resembling an authenticated action.

## Privacy: the exact running frequency never reaches a browser

For some contests, broadcasting the exact frequency to anyone with the
dashboard URL amounts to cheerleading or spotting your own run. `freq`/
`tx_freq` are stripped server-side — from both `GET /api/radios` and the
`radio:update` socket payload — and replaced with a derived `band` field
(`src/parsers/util.js`'s `freqToBand()`) before the response ever leaves
the server. This is enforced at the API/socket layer specifically because
UI-only hiding isn't enough: every connected dashboard receives
`radio:update` live, so anyone with browser devtools open could otherwise
read the precise frequency straight out of the WebSocket frames regardless
of what the page chooses to render. The exact value still lives in
`radio_state` server-side (useful for a future authenticated view); it just
never gets forwarded to a client.

## REST API

| Method | Path                    | Description                                          |
|--------|-------------------------|-------------------------------------------------------|
| GET    | `/api/version`          | Commit + deploy timestamp, for spotting a stale/cached page |
| GET    | `/api/qsos`             | All QSOs. Filters: `?band=20&mode=CW&operator=W1OP`  |
| GET    | `/api/score`            | Latest score snapshot (`total`/`score_total` both present) |
| GET    | `/api/score/history`    | Full score time series                               |
| GET    | `/api/radios`           | Current state of all radios (`band`, never the exact frequency) |
| GET    | `/api/rate`             | N1MM-style rate meter: QSOs/hr for trailing 10/30/60 min |
| GET    | `/api/bridges`          | Realtime/stale/offline status per ContestPulse station |
| DELETE | `/api/db`               | Wipe all contest data (requires `X-Confirm: yes`, plus a bearer token if `CONTESTSCORE_API_TOKEN` is set) |
| POST   | `/api/ingest/{radio,contact,score}` | Raw N1MM XML bytes from the ContestPulse bridge (bearer token required, dispatched by XML root element like the UDP listeners) |
| POST   | `/api/ingest/heartbeat` | `{ "station_id": "..." }` liveness ping from ContestPulse |
| POST   | `/api/analyze`          | Upload raw Cabrillo/ADIF text (`?filename=`), bearer token required. Returns `{ id, meta }` |
| GET    | `/api/analyze`          | List saved analyses (bearer token required) |
| GET    | `/api/analyze/:id`      | A saved analysis as `{ meta, qsos }` — **public** (shareable link) |
| DELETE | `/api/analyze/:id`      | Delete a saved analysis (bearer token required) |

Clear the database before a contest:

```bash
curl -X DELETE http://localhost:3000/api/db -H "X-Confirm: yes"
```

## Socket.io events (server → client)

| Event            | Payload                                          |
|------------------|---------------------------------------------------|
| `radio:update`   | Latest state for one radio (`band`, never the exact frequency) |
| `contact:new`    | New QSO logged (also fires on a `contactreplace` edit-in-place) |
| `contact:delete` | QSO deleted in N1MM+                             |
| `score:update`   | Current score snapshot, including `grid6`        |
| `lookup:result`  | Callsign lookup result                           |
| `bridge:status`  | A ContestPulse station's realtime/stale/offline status changed |
| `db:cleared`     | Database wiped                                   |

## Configuration

`config/default.json` — override with environment variables or a `.env` file:

```json
{
  "http":   { "port": 3000 },
  "udp":    { "radioPort": 12060, "contactPort": 12061, "scorePort": 12062 },
  "db":     { "path": "./data/qsos.db" },
  "lookup": { "provider": "none" }
}
```

| Environment variable      | Default          |
|----------------------------|------------------|
| `HTTP_PORT`                | `3000`           |
| `UDP_RADIO_PORT`           | `12060`          |
| `UDP_CONTACT_PORT`         | `12061`          |
| `UDP_SCORE_PORT`           | `12062`          |
| `DB_PATH`                  | `./data/qsos.db` |
| `LOOKUP_PROVIDER`          | `none`           |
| `QRZ_USERNAME`             | —                |
| `QRZ_PASSWORD`             | —                |
| `CONTESTSCORE_API_TOKEN`   | — (unset = no auth required; required for `/api/ingest/*`, optional but recommended for `DELETE /api/db`) |
| `BRIDGE_STALE_AFTER_MS`    | `30000` (ContestPulse heartbeat default is 10s) |
| `BRIDGE_OFFLINE_AFTER_MS`  | — (see `src/state/bridgeStatus.js`) |

Copy `.env.example` to `.env` and fill in any values you want to override.

## Callsign lookup

Set `lookup.provider` in `config/default.json` (or `LOOKUP_PROVIDER` env var):

- `none` — disabled (default)
- `hamdb` — free, no credentials needed, limited DXCC coverage
- `qrz` — requires an XML-data subscription; set `QRZ_USERNAME` / `QRZ_PASSWORD`

Lookup results are cached in SQLite for the duration of the contest and wiped
on `DELETE /api/db`.

## Database

SQLite file at `./data/qsos.db` (created on first start). Schema:

| Table             | Contents                                              |
|-------------------|--------------------------------------------------------|
| `qsos`            | One row per logged QSO, including N1MM's per-QSO multiplier flags (`is_mult1/2/3`) |
| `radio_state`     | Latest state per radio, keyed by `(station_name, radio_nr)` |
| `score_snapshots` | Per-band/mode score breakdown, one batch per broadcast, plus a `band='total' mode='ALL'` grand-total row |
| `settings`        | Key/value config (contest name, etc.)                 |
| `callsign_cache`  | Lookup results, cleared on DB reset                   |

`qsos` is identified primarily by N1MM's own `ID` GUID, so an edited-in-place
QSO (`contactreplace`) updates its existing row instead of duplicating it.
Loggers that don't send an `ID` fall back to a
`(call, band, mode, contestnr, mycall)` natural key with `INSERT OR IGNORE`
dedupe (and lose update-in-place as a result).

`score_snapshots` stores one row per (band, mode) entry from each Score
broadcast's breakdown, plus a `band='total' mode='ALL'` row holding the
contest grand total — a single Score packet reports the *whole* contest
snapshot, not one band, so "current score" means that total row, not
whichever row was inserted last. N1MM's real broadcast sometimes wraps this
in an outer `<rtc>` element rather than sending `<dynamicresults>` as the
bare root; the parser accepts both shapes.

Schema lives in `src/db/schema.sql`. Numbered `.sql` files in `migrations/`
are applied automatically on startup.

## Deployment on Raspberry Pi

```bash
npm install --production
npm start
```

Dashboard available at `http://<hostname>.local:3000`.

To run as a systemd service:

```bash
sudo cp contestscore.service /etc/systemd/system/
sudo systemctl enable --now contestscore
```

The service file assumes the app lives at `/home/pi/contestscore` and runs as
the `pi` user — edit if your setup differs.

## Deploying publicly behind a reverse proxy

For a deployment reachable outside your own LAN (e.g. a VPS fronted by
nginx/Cloudflare Tunnel rather than reached directly by hostname), see
[deploy/DEPLOY.md](deploy/DEPLOY.md) — it covers binding to localhost,
requiring `CONTESTSCORE_API_TOKEN` on the ingest routes and (recommended)
`DELETE /api/db`, and getting N1MM's data there via the **ContestPulse**
bridge (`contestpulse/` — a small standalone binary that relays N1MM's UDP
broadcasts over authenticated HTTPS, no VPN needed; Tailscale/ZeroTier is
documented as an alternative). `.github/workflows/deploy.yml` runs the test
suite on every push to `main` and, if it passes, deploys automatically via
a self-updating deploy script (`deploy/contestscore-deploy.sh`) — `git
push` to `main` is the entire release process for a deployment set up this
way; `scripts/deploy.sh` triggers the same script manually, for deploying
from a machine other than CI.

## Admin page

`public/admin.html` (linked from the dashboard footer) is a small UI for
`DELETE /api/db` — paste the admin token, tick the confirmation box, reset.
It shows the current QSO count and score total first so you can see what
you're about to delete. The token itself is the only thing protecting this
page's action; there's no separate login, and it's deliberately reachable
from the public URL rather than IP-restricted at the reverse-proxy layer —
behind a tunnel like Cloudflare, every request already arrives from
`127.0.0.1` as far as nginx is concerned, so an IP allow-list there
couldn't actually distinguish an admin's device from anyone else on the
internet.

## ContestPulse

N1MM's UDP broadcasts are LAN-local — they don't reach a remote instance on
their own. ContestPulse runs on (or near) the shack LAN, relays N1MM's
broadcasts byte-for-byte to `/api/ingest/{radio,contact,score}` over HTTPS
with a bearer token (it never parses N1MM's XML itself — that still only
happens server-side, in `src/parsers/`), and sends a heartbeat every 10s
(configurable) so the dashboard shows the feed as **realtime**, **stale**,
or **offline** (`bridge:status` socket event / `GET /api/bridges`) instead
of just silently going quiet during a lull in QSOs.

Pre-built binaries (Windows x86-64, Linux x86-64, Linux ARM64, Linux ARMv7 —
see `.github/workflows/contestpulse-build.yml`) are on this repo's Releases
page under the rolling `contestpulse-latest` tag. Configure
`contestpulse/config.example.json` (`station_id`, `server_url`, `api_token`)
and run `contestpulse-<platform> config.json` — nothing else to install.
See `contestpulse/` and `deploy/DEPLOY.md` for details.

## Project layout

```
src/
  server.js               Entry point
  app.js                  Express setup
  udp/                    dgram listeners + dispatch.js (routes by XML root element, not port)
  parsers/                XML → JS (radio, contact, score, lookup, util.js for shared conversions)
  analyze/                Cabrillo + ADIF parsers, per-contest exchange maps, cty.csv resolver + geo.js (shared with the realtime pipeline), orchestrator
  db/                     better-sqlite3: schema, migrations, queries
  socket/                 socket.io init and event wiring
  state/bridgeStatus.js   ContestPulse heartbeat freshness tracking
  routes/                 REST endpoints (api.js) + ingest.js (bridge) + analyze.js (log upload)
public/
  index.html, charts.html, stats.html, analyze.html, compare.html, admin.html   The pages
  js/
    dashboard.js, charts.js, stats.js, analyze.js, compare.js, admin.js   Per-page Alpine.js logic (not ES modules -- see CLAUDE.md)
    chrome.js                           Shared header/nav/footer, injected into every page
  css/dashboard.css        Shared styling, dark theme
config/default.json       Default configuration
migrations/               Numbered SQL migration files
scripts/
  sendTestPacket.js        UDP traffic simulator
  deploy.sh                Manual trigger for the production deploy script, from any machine
deploy/                    DEPLOY.md + the production deploy script
contestpulse/              Standalone Go relay binary (see above)
.github/workflows/         CI (test on every push) + auto-deploy + ContestPulse cross-compile/release
test/
  parsers/                Parser unit tests
  analyze/                Cabrillo/ADIF/cty parser + orchestrator unit tests
  db/                     DB integration tests (in-memory SQLite)
  udp/                    UDP pipeline integration tests
  routes/                 REST API integration tests (incl. /api/analyze)
```

## Tech stack

- **Runtime**: Node.js 18+
- **HTTP / WebSocket**: Express 4 + socket.io 4
- **Database**: better-sqlite3 (synchronous, Pi-friendly)
- **XML parsing**: xml2js
- **Frontend**: Vanilla JS + Alpine.js + Chart.js (all via CDN)
- **Relay**: ContestPulse, a dependency-free Go binary (`contestpulse/`)
- No TypeScript. No bundler. No framework.

None of the three page scripts are loaded as `type="module"` — a module's
top-level declarations don't land on the global scope Alpine evaluates
`x-data="..."` against, so a module-loaded page would silently fail to
initialize entirely. See `CLAUDE.md` for this and other gotchas hit along
the way (N1MM's frequency fields being in tens of Hz, not Hz; Chart.js
instances needing to live outside Alpine's reactive Proxy to keep working
past their first render).
