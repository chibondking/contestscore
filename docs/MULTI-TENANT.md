# Multi-tenant hosting: scoreboards for several clubs on one server

> **Most stations don't need this.** One scoreboard for your own station is
> [docs/SETUP.md](SETUP.md), section A or B. This page is for running
> scoreboards for *several* clubs or callsigns on one VPS — say
> `k9ct-score.example.org`, `nw8s-score.example.org` and your own.

Everything here is done by hand with two command-line tools that ship in
this repo. (The author drives the same tools from a private ops dashboard;
nothing below depends on it.)

## How it fits together

```
                     ┌─────────────────────── one VPS ─────────────────────────┐
 club K9CT's bridge ─┼─▶ k9ct-score.example.org ─▶ contestscore@k9ct  :3201 ──┐ │
 club NW8S's bridge ─┼─▶ nw8s-score.example.org ─▶ contestscore@nw8s  :3202 ──┼─┼─▶ hamdata :3100 ─▶ hamqsl.com (solar)
 your own bridge ────┼─▶ wt2p-score.example.org ─▶ contestscore@wt2p  :3200 ──┘ │               └─▶ HamQTH (lookups)
                     └─────────────────────────────────────────────────────────┘
```

- **One instance per club** (a *tenant*): its own process
  (`contestscore@<id>.service`), its own database, its own port, its own
  token. Clubs can't see or touch each other's data, and one club's
  trouble doesn't take the others down.
- **One code checkout** (`/opt/contestscore/app`) shared by every instance,
  so one update upgrades everybody.
- **hamdata**, one shared helper: fetches space weather once for the whole
  box, and does every callsign lookup through *your* HamQTH account with
  one shared cache, so twenty clubs don't mean twenty times the traffic.
- **Tenant mode** (`CONTESTSCORE_TENANT=<id>`, set for you): the instance
  opens **no UDP ports** (data only arrives from that club's ContestPulse
  bridge over HTTPS), and it refuses to start without a token or without
  hamdata.

Each club still gets the full dashboard, including its own **Admin page**:
reset its contest data, switch its own lookups on/off, clear its own
callsign cache — all with its own token. Space-weather history is never
deleted by anything.

## What you need

- A Linux VPS with **systemd**, **Node.js 18+**, **git**, **curl**.
- A reverse proxy for HTTPS (Caddy, nginx, or a Cloudflare Tunnel) and
  one hostname per club pointing at the VPS.
- Optionally a free [HamQTH](https://www.hamqth.com/) account for callsign
  lookups.

The tools use **fixed paths** — keep them:

| Path | What |
|---|---|
| `/opt/contestscore/app` | the code checkout (owned by user `contestscore`) |
| `/opt/contestscore/tenants/<id>/` | one club: `tenant.env` (settings + token) and `data/qsos.db` |
| `/opt/contestscore/hamdata/` | `hamdata.env` and `data/hamdata.db` |
| `/usr/local/sbin/contestscore-tenant` | create and manage clubs |
| `/usr/local/sbin/hamdata-ctl` | operator controls for hamdata |

## 1. Install the code and the tools

```bash
sudo useradd --system --create-home --home /opt/contestscore --shell /usr/sbin/nologin contestscore
sudo -u contestscore git clone https://github.com/chibondking/contestscore.git /opt/contestscore/app
sudo install -o root -g root -m 755 /opt/contestscore/app/deploy/contestscore-deploy.sh /usr/local/bin/
sudo /usr/local/bin/contestscore-deploy.sh
```

The deploy script runs `npm install`, installs `contestscore-tenant`,
`hamdata-ctl` and the `contestscore@.service` template, and (on later runs)
restarts hamdata and every running club. **Run it again whenever you want
to update**; it pulls the latest `main`.

## 2. Set up hamdata

```bash
sudo install -d -o contestscore -g contestscore -m 750 /opt/contestscore/hamdata /opt/contestscore/hamdata/data
sudo -u contestscore tee /opt/contestscore/hamdata/hamdata.env >/dev/null <<EOF
HAMDATA_DB_PATH=/opt/contestscore/hamdata/data/hamdata.db
HAMDATA_HOST=127.0.0.1
HAMDATA_PORT=3100
HAMDATA_TOKEN=$(openssl rand -hex 32)
SOLAR_ENABLED=true
LOOKUP_PROVIDER=hamqth
HAMQTH_USERNAME=yourcall
HAMQTH_PASSWORD=yourpassword
EOF
sudo chmod 600 /opt/contestscore/hamdata/hamdata.env
```

(Leave out the three lookup lines if you don't want callsign lookups.)

```bash
sudo cp /opt/contestscore/app/deploy/hamdata.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hamdata
sudo hamdata-ctl status          # "status": "ok", solar.updated filled in within a minute
```

## 3. Create a club

```bash
sudo TENANT_DOMAIN=example.org contestscore-tenant create k9ct --name "K9CT Contest Club"
```

```
tenant k9ct is up on 127.0.0.1:3200
  ContestPulse server_url: https://k9ct-score.example.org
  ContestPulse api_token:  4f1c…e9
  shown once -- it's only stored in /opt/contestscore/tenants/k9ct/tenant.env
```

- The id is 3–10 lower-case letters/digits, usually the callsign.
- The port comes from 3200–3299 automatically (`--port N` to choose).
- `TENANT_DOMAIN` only affects the URL it prints for you.
- Lost the token? `sudo contestscore-tenant token k9ct`.
- The new club backfills the whole space-weather history from hamdata on
  its first start.

## 4. Give the club a hostname

Route `k9ct-score.example.org` to `127.0.0.1:<its port>`. Keep the hostname
**first-level** (`k9ct-score.example.org`, not `k9ct.score.example.org`):
wildcard certificates (including Cloudflare's free one) only cover one
level.

- **Caddy** — one block per club in `/etc/caddy/Caddyfile`, then
  `sudo systemctl reload caddy`:
  ```
  k9ct-score.example.org {
      reverse_proxy 127.0.0.1:3200
  }
  ```
- **nginx** — copy `deploy/nginx-scoreboard.wt2p.us.conf` per club, change
  `server_name` and the `proxy_pass` port, keep the WebSocket
  `Upgrade`/`Connection` lines, and add a certificate.
- **Cloudflare Tunnel** — one public hostname per club →
  `http://localhost:3200`.

Check: `curl -s https://k9ct-score.example.org/api/features` shows
`"tenant":{"call":"K9CT",…}`.

## 5. Hand the club its bridge settings

Send them the two values from step 3. Their `config.json` for the
ContestPulse bridge (download and run it exactly as in
[SETUP.md section B](SETUP.md#in-the-shack-the-bridge)):

```json
{
  "station_id": "k9ct-run",
  "server_url": "https://k9ct-score.example.org",
  "api_token": "<their token>",
  "radio_port": 12060, "contact_port": 12061, "score_port": 12062,
  "heartbeat_interval_seconds": 10, "log_contact_packets": true
}
```

The same token opens their Admin page.

## Day to day

| Task | Command |
|---|---|
| See every club, its port and state | `sudo contestscore-tenant list` |
| Settings for one (token hidden) | `sudo contestscore-tenant show k9ct` |
| Restart one | `sudo contestscore-tenant restart k9ct` |
| Take one offline, keep its data | `sudo contestscore-tenant suspend k9ct` (`resume` to bring it back) |
| Copy one club's database | `sudo contestscore-tenant export k9ct /root/k9ct.db` |
| Remove one | `sudo contestscore-tenant delete k9ct --confirm k9ct` |
| Update everything | `sudo /usr/local/bin/contestscore-deploy.sh` |

**Delete** stops the club, disables it and moves its folder to
`/opt/contestscore/tenants/.deleted/<id>-<time>` — nothing is erased. Remove
that folder yourself when you're sure, and remove the club's hostname from
your reverse proxy.

### Your controls over lookups

Callsign lookups go out under **your** HamQTH account, so you can stop them
for every club at once:

```bash
sudo hamdata-ctl stop-lookups     # nothing goes to HamQTH; stays stopped across restarts
sudo hamdata-ctl start-lookups
sudo hamdata-ctl clear-cache      # forget the shared callsign cache
sudo hamdata-ctl status
```

While stopped, callsigns already in a cache still resolve, and every club's
Admin page says lookups were stopped by the server operator. Looked-up
callsigns are kept for about six months ("not found" for a day).

## Moving an existing single install into a club

Already running one public scoreboard (SETUP.md section B) and want it to
become one of the clubs, keeping its data, token and port (so its bridge
and hostname keep working)?

```bash
sudo systemctl disable --now contestscore
sudo contestscore-tenant create wt2p --name "WT2P" --port 3000 \
    --adopt-env /opt/contestscore/app/contestscore.env \
    --import-db /opt/contestscore/app/data/qsos.db
```

`--adopt-env` carries over the token and its tuning settings; `--import-db`
copies the database safely. Check the club's row counts and dashboard, then
move the old `data/` and `contestscore.env` aside. Optionally seed hamdata
with that install's space-weather history first:
`sudo -u contestscore env HAMDATA_DB_PATH=/opt/contestscore/hamdata/data/hamdata.db node /opt/contestscore/app/hamdata/import-solar.js /opt/contestscore/app/data/qsos.db`
(stop hamdata while it runs).

## Backups

What to keep, and how:

| What | How |
|---|---|
| Each club's database | `sudo contestscore-tenant export <id> <file>` (a safe online copy) |
| Each club's settings + token | `/opt/contestscore/tenants/<id>/tenant.env` |
| hamdata's database (solar history + shared cache) | `sudo sqlite3 /opt/contestscore/hamdata/data/hamdata.db ".backup /root/hamdata.db"` |
| hamdata's settings (HamQTH login, token) | `/opt/contestscore/hamdata/hamdata.env` |
| Units | `/etc/systemd/system/hamdata.service`, `/etc/systemd/system/contestscore@.service` |

Never copy a live `.db` file with plain `cp`/`tar`: its recent changes may
still be in the `-wal` file next to it. Use `export` / `.backup`. Encrypt
anything that leaves the box — the env files hold tokens and your HamQTH
password.

## Security notes

- Every club's ingest, analyzer uploads and Admin actions need **that
  club's** token; a club can never act on another's data.
- Clubs open no UDP ports. (A UDP port open on a VPS lets anyone inject
  fake QSOs.)
- Instances and hamdata listen on `127.0.0.1` only; only your reverse proxy
  is public.
- Automating this from another program? Don't give it sudo on
  `contestscore-tenant` — that tool takes file paths (`--import-db`,
  `--adopt-env`, `export`). Use `deploy/contestscore-tenant-agent`, a
  wrapper that only accepts fixed, validated arguments
  (`list | create <id> <name> | suspend | resume | restart | delete <id>`).

## Reference

| Thing | Value |
|---|---|
| Club instance | `contestscore@<id>.service`, listens on `127.0.0.1:<port>` (3200–3299) |
| Club settings | `/opt/contestscore/tenants/<id>/tenant.env` (`CONTESTSCORE_TENANT`, `CONTESTSCORE_TENANT_NAME`, `HTTP_PORT`, `DB_PATH`, `HAMDATA_URL`, `CONTESTSCORE_API_TOKEN`, plus any README setting) |
| hamdata | `hamdata.service`, `127.0.0.1:3100`, settings in `/opt/contestscore/hamdata/hamdata.env` |
| Health | `curl 127.0.0.1:<port>/api/health`, `sudo hamdata-ctl status` |
| Logs | `journalctl -u contestscore@<id>`, `journalctl -u hamdata` |

Implementation detail for developers: CLAUDE.md, sections "Tenant mode" and
"hamdata".
