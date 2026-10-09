# Setting up ContestPulse

ContestPulse is a live contest scoreboard: your logger's score, QSOs,
radios, rate and a world map, updating in the browser as you log. This
repo is **contestscore**, the dashboard server. The small **ContestPulse
bridge** program (`contestpulse`) is only needed when the scoreboard runs
somewhere other than your shack LAN.

Pick the setup that matches where the scoreboard will run:

| You want… | Setup | Time |
|---|---|---|
| A scoreboard for the people in the shack (or on your home network) | **[A. On your LAN](#a-on-your-lan)** — no internet, no accounts, no bridge | ~10 min |
| A public scoreboard anyone can open (club members, family, social media) | **[B. Public, on a VPS](#b-public-on-a-vps)** — the server on a VPS, the bridge in the shack | ~45 min |
| Scoreboards for **several** clubs on one server | **[Multi-tenant hosting](MULTI-TENANT.md)** — for the curious; most stations don't need it | longer |

Both A and B work with **N1MM+**, **DXLog.net**, **not1mm** and **TR4W**
(anything that sends N1MM-style UDP broadcasts).

---

## A. On your LAN

Everything stays in the building. The logging PCs broadcast to the machine
running contestscore; anyone on the network opens the dashboard.

**You need:** any always-on machine on the shack network (a Raspberry Pi is
perfect) with **Node.js 18 or newer** and **git**.

1. **Install and start it**

   ```bash
   git clone https://github.com/chibondking/contestscore.git
   cd contestscore
   npm install --omit=dev
   npm start
   ```

   Open `http://<that-machine>:3000` (for a Pi, usually
   `http://raspberrypi.local:3000`). The panels stay empty until a logger
   sends something.

2. **Point your logger at it** — the three standard N1MM ports:

   | Broadcast | Port |
   |---|---|
   | Radio | 12060 |
   | Contact / Lookup | 12061 |
   | Score | 12062 |

   - **N1MM+**: Config → *Configure Ports, Mode Control, Winkey, etc.* →
     **Broadcast Data** tab. Tick Radio, Contacts and Score, and set the
     destination to your LAN's broadcast address (e.g. `192.168.1.255`)
     or the machine's IP, with the ports above. Only **one** PC in a
     multi-op should send Score.
   - **not1mm**: Settings → **N1MM** tab → *Send N1MM packets*, then set
     each port to `<contestscore-ip>:12060` / `:12061` / `:12062`. Use the
     machine's IP — not a broadcast address (not1mm can't broadcast).
   - **DXLog.net**: turn on its N1MM-compatible UDP broadcast — see the
     README's [DXLog section](../README.md#dxlognet-configuration).

   Log a test QSO; it appears within a second.

3. **Start it at boot** (optional). Edit `contestscore.service` in the repo
   root so `User=` and `WorkingDirectory=` match where you cloned it
   (default: user `pi`, `/home/pi/contestscore`), then:

   ```bash
   sudo cp contestscore.service /etc/systemd/system/
   sudo systemctl enable --now contestscore
   ```

That's the whole LAN setup — no token, no HTTPS, no bridge.

**Optional extras**

- *Callsign lookups and the "Possible Busts" panel* — free
  [HamQTH](https://www.hamqth.com/) account, then create a `.env` file
  next to `package.json`:
  ```
  LOOKUP_PROVIDER=hamqth
  HAMQTH_USERNAME=yourcall
  HAMQTH_PASSWORD=yourpassword
  ```
  and restart. Lookups are cached for about six months.
- *Space weather* (SFI / A / K in the header, the Solar page) is on by
  default and needs internet access from the machine. Readings are kept
  forever.
- *Resetting before a contest*: the **Admin** page → Reset Contest
  Database. With no token configured (the LAN default) the server doesn't
  check one, but the page still wants the box filled in — type anything.
  QSOs and score history go; callsign lookups and space-weather history
  stay.

---

## B. Public, on a VPS

The scoreboard lives on an internet server with a hostname
(`scoreboard.example.org`). N1MM's broadcasts can't reach it on their own,
so the **ContestPulse bridge** runs in the shack and forwards them over
HTTPS with a secret token.

```
 shack LAN                                 internet
 ┌──────────┐  UDP   ┌──────────────┐  HTTPS + token  ┌──────────────┐   ┌──────────┐
 │ N1MM+    │ ─────▶ │ ContestPulse │ ──────────────▶ │ contestscore │ ◀─│ browsers │
 │ (logger) │        │ bridge       │                 │ (VPS)        │   └──────────┘
 └──────────┘        └──────────────┘                 └──────────────┘
```

**You need:** a Linux VPS with systemd (any small one is plenty), a
hostname pointing at it, **Node.js 18+** and **git** on it, and a way to
serve HTTPS (steps below cover Caddy, nginx, or a Cloudflare Tunnel).

### On the VPS

1. **A service user and the code**

   ```bash
   sudo useradd --system --create-home --home /opt/contestscore --shell /usr/sbin/nologin contestscore
   sudo -u contestscore git clone https://github.com/chibondking/contestscore.git /opt/contestscore/app
   sudo -u contestscore bash -c 'cd /opt/contestscore/app && npm install --omit=dev && mkdir -p data'
   ```

2. **Settings, with a token**

   ```bash
   cd /opt/contestscore/app
   sudo -u contestscore cp .env.example contestscore.env
   openssl rand -hex 32          # this is your token -- keep it
   sudo -u contestscore nano contestscore.env
   ```

   Set at least:
   ```
   HTTP_HOST=127.0.0.1
   DB_PATH=/opt/contestscore/app/data/qsos.db
   CONTESTSCORE_API_TOKEN=<the token you just generated>
   ```
   (plus the HamQTH lines from section A if you want lookups), then
   `sudo chmod 600 contestscore.env`.

   The token is what lets the bridge send data and guards the Admin page.
   `HTTP_HOST=127.0.0.1` means only your web server can reach the app.

3. **Run it as a service**

   ```bash
   sudo cp deploy/contestscore.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now contestscore
   curl -s http://127.0.0.1:3000/api/health      # {"status":"ok",...}
   ```

4. **Put HTTPS in front** — pick one:

   - **Caddy** (simplest; gets the certificate for you). In
     `/etc/caddy/Caddyfile`:
     ```
     scoreboard.example.org {
         reverse_proxy 127.0.0.1:3000
     }
     ```
     then `sudo systemctl reload caddy`.
   - **nginx** — copy `deploy/nginx-scoreboard.wt2p.us.conf`, change
     `server_name`, enable it, and add a certificate (e.g.
     `sudo certbot --nginx`). Keep the `Upgrade`/`Connection` lines: the
     live updates use WebSockets.
   - **Cloudflare Tunnel** — route the hostname to
     `http://localhost:3000`. No open ports or certificates needed.

   Check: `https://scoreboard.example.org` shows the dashboard.

### In the shack: the bridge

5. **Download the bridge** from the
   [Releases page](https://github.com/chibondking/contestscore/releases) —
   the latest **ContestPulse vX.Y.Z** release:

   | File | For |
   |---|---|
   | `contestpulse-windows-amd64.exe` | Windows (e.g. the N1MM PC itself) |
   | `contestpulse-linux-arm64` | Raspberry Pi 4/5, 64-bit OS |
   | `contestpulse-linux-armv7` | Raspberry Pi, 32-bit OS |
   | `contestpulse-linux-amd64` | Linux PC |

   It can run on the logging PC or on any machine that receives N1MM's
   broadcasts.

6. **Create `config.json`** next to it:

   ```json
   {
     "station_id": "shack1",
     "server_url": "https://scoreboard.example.org",
     "api_token": "<the same token as on the VPS>",
     "radio_port": 12060,
     "contact_port": 12061,
     "score_port": 12062,
     "heartbeat_interval_seconds": 10,
     "log_contact_packets": true
   }
   ```

7. **Run it**: `contestpulse-windows-amd64.exe config.json` (or the Linux
   file; `chmod +x` it first). Leave it running during the contest. Point
   N1MM at the bridge's machine exactly as in [section A, step 2](#a-on-your-lan).

   The dashboard shows the bridge as **realtime**, **stale** or
   **offline**, so you can tell a quiet band from a dead link. If the
   server is briefly unreachable (a restart, a network drop), the bridge
   holds your QSOs and sends them as soon as it's back — leave it running.

### Keeping it updated

```bash
cd /opt/contestscore/app
sudo -u contestscore git pull --ff-only
sudo -u contestscore npm install --omit=dev
sudo systemctl restart contestscore
```

(For automatic deploys on every push, see
[deploy/DEPLOY.md](../deploy/DEPLOY.md).)

---

## When something's not right

| Symptom | Check |
|---|---|
| Dashboard stays empty | The logger's broadcast ports/destination; on a VPS, that the bridge is running and its window shows packets arriving. |
| Bridge logs `401` | The token in `config.json` doesn't match `CONTESTSCORE_API_TOKEN` on the server. |
| Bridge logs `503` | The server has no `CONTESTSCORE_API_TOKEN` set — ingest refuses everything until it does. |
| "Port in use" on 12061 with FlexRadio / SmartSDR CAT | SmartSDR's Spots connection owns that port. Move N1MM's Contacts broadcast and the bridge's `contact_port` to e.g. 13061 — see [deploy/DEPLOY.md](../deploy/DEPLOY.md). |
| Score shows, QSOs don't (or the reverse) | Only one PC should send Score; every PC sends Radio and Contacts. |
| The page doesn't update live behind nginx | The `Upgrade` / `Connection "upgrade"` proxy headers are missing. |

More detail on every page, setting and API: the [README](../README.md).
