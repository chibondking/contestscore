# contestscore

Real-time ham radio contesting dashboard. Listens for UDP broadcasts from
[N1MM+](https://n1mmwp.hamdocs.com/) (and compatible loggers like TR4W) and
displays a live score, radio state, and QSO log in the browser.

Designed to run on a Raspberry Pi on a shack LAN. No cloud, no auth, no build
step.

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
master/logging PC accordingly.

## Architecture

```
N1MM+ (UDP broadcast)
  :12060  RadioInfo      →  src/udp/radioListener.js
  :12061  ContactInfo       src/udp/contactListener.js  (also handles lookupinfo)
  :12062  Score          →  src/udp/scoreListener.js
              │
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
the same port.

## REST API

| Method | Path                 | Description                                         |
|--------|----------------------|-----------------------------------------------------|
| GET    | `/api/qsos`          | All QSOs. Filters: `?band=20&mode=CW&operator=W1OP` |
| GET    | `/api/score`         | Latest score snapshot                               |
| GET    | `/api/score/history` | Full score time series                              |
| GET    | `/api/radios`        | Current state of all radios                         |
| DELETE | `/api/db`            | Wipe all contest data (requires `X-Confirm: yes`)   |

Clear the database before a contest:

```bash
curl -X DELETE http://localhost:3000/api/db -H "X-Confirm: yes"
```

## Socket.io events (server → client)

| Event            | Payload                    |
|------------------|----------------------------|
| `radio:update`   | Latest state for one radio |
| `contact:new`    | New QSO logged             |
| `contact:delete` | QSO deleted in N1MM+       |
| `score:update`   | Current score snapshot     |
| `lookup:result`  | Callsign lookup result     |
| `db:cleared`     | Database wiped             |

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

| Environment variable | Default          |
|----------------------|------------------|
| `HTTP_PORT`          | `3000`           |
| `UDP_RADIO_PORT`     | `12060`          |
| `UDP_CONTACT_PORT`   | `12061`          |
| `UDP_SCORE_PORT`     | `12062`          |
| `DB_PATH`            | `./data/qsos.db` |
| `LOOKUP_PROVIDER`    | `none`           |
| `QRZ_USERNAME`       | —                |
| `QRZ_PASSWORD`       | —                |

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

| Table             | Contents                                     |
|-------------------|----------------------------------------------|
| `qsos`            | One row per logged QSO                       |
| `radio_state`     | Latest state per radio (upserted by RadioNr) |
| `score_snapshots` | Append-only score time series                |
| `settings`        | Key/value config (contest name, etc.)        |
| `callsign_cache`  | Lookup results, cleared on DB reset          |

`qsos` has a unique constraint on `(call, band, mode, contestname, mycall)`;
duplicates from networked PCs are silently ignored (`INSERT OR IGNORE`).

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

## Project layout

```
src/
  server.js               Entry point
  app.js                  Express setup
  udp/                    dgram listeners (radio, contact, score)
  parsers/                XML → JS (radio, contact, score, lookup)
  db/                     better-sqlite3: schema, migrations, queries
  socket/                 socket.io init and event wiring
  routes/api.js           REST endpoints
public/                   Static dashboard (no build step)
config/default.json       Default configuration
migrations/               Numbered SQL migration files
scripts/sendTestPacket.js UDP traffic simulator
test/
  parsers/                Parser unit tests
  db/                     DB integration tests (in-memory SQLite)
  udp/                    UDP pipeline integration tests
```

## Tech stack

- **Runtime**: Node.js 18+
- **HTTP / WebSocket**: Express 4 + socket.io 4
- **Database**: better-sqlite3 (synchronous, Pi-friendly)
- **XML parsing**: xml2js
- **Frontend**: Vanilla JS + Alpine.js (CDN)
- No TypeScript. No bundler. No framework.
