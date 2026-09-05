# Deploying behind a reverse proxy (e.g. scoreboard.wt2p.us)

This is the shape used for a publicly reachable install fronted by nginx and
Cloudflare Tunnel, as opposed to the standalone Raspberry Pi install
described in the main README (which has no reverse proxy and is reached
directly by hostname on the LAN).

Going public changes the threat model from the LAN-only design: the REST API
has no user authentication (`DELETE /api/db` is the only write endpoint, and
it's destructive), so two things are non-negotiable here:

1. The app binds to `127.0.0.1` only (`HTTP_HOST=127.0.0.1`) -- nginx is the
   only thing the internet can talk to.
2. `DELETE /api/db` requires a bearer token (`CONTESTSCORE_API_TOKEN`) *and*
   is restricted at the nginx layer to trusted source IPs (Tailscale /
   ZeroTier ranges) -- see `nginx-scoreboard.wt2p.us.conf`. Cloudflare
   Tunnel traffic always arrives at nginx as `127.0.0.1`, which is
   deliberately not in that allow-list, so the public hostname can never
   trigger a reset.

## Redeploying after the initial setup

Every push to `main` that passes the test suite auto-deploys via
`.github/workflows/deploy.yml`: it SSHes in with a dedicated key and runs
`/usr/local/bin/contestscore-deploy.sh` (git pull --ff-only, npm install,
restart the service, write `deploy-info.json`). That key is restricted
server-side via a forced command in `wt2p`'s `~/.ssh/authorized_keys` --
even if it leaked, it could only ever run that one script, nothing else.

The installed script is `deploy/contestscore-deploy.sh` in this repo --
update it there and reinstall, don't hand-edit the copy on the server:

```bash
sudo install -o root -g root -m 755 deploy/contestscore-deploy.sh /usr/local/bin/contestscore-deploy.sh
```

To deploy manually from any other machine (your laptop, another shack
computer -- deploying isn't tied to CI or to one machine), run
`scripts/deploy.sh` from a clone of this repo, using your own normal SSH
access to the box:

```bash
scripts/deploy.sh              # defaults to wt2p@147.224.142.162
scripts/deploy.sh me@otherhost # or target a different box
```

Every deploy writes `deploy-info.json` (commit + UTC timestamp) next to the
app, which `GET /api/version` serves and the dashboard footer shows -- since
that timestamp only changes on a real deploy, it's a reliable way to tell a
cached/stale page apart from a fresh one.

Both paths run the exact same `/usr/local/bin/contestscore-deploy.sh` on the
server -- the only difference is which SSH key gets you there.

## Getting N1MM's data to a remote box: ContestPulse (recommended)

N1MM's UDP broadcasts don't route over the public internet -- broadcast
addressing is LAN-local. The recommended path is **ContestPulse**
(`contestpulse/`), a small standalone binary that runs on the shack LAN,
listens for N1MM's broadcasts, and forwards them to
`POST /api/ingest/{radio,contact,score}` over plain HTTPS with a bearer
token -- no VPN, no firewall changes, works over any internet connection
the shack computer already has. It also sends a heartbeat every 10s so the
dashboard can show the feed as realtime / stale / offline.

1. Download the current build from this repo's Releases page
   (`contestpulse-latest` tag -- Windows x86-64, Linux x86-64, Linux ARM64,
   Linux ARMv7; N1MM itself only runs on Windows, but ContestPulse can run
   on any machine that can see N1MM's LAN broadcasts, not necessarily the
   logging PC itself).
2. Copy `contestpulse/config.example.json` next to the binary as
   `config.json`, and fill in `station_id`, `server_url`
   (`https://scoreboard.wt2p.us`), and `api_token` (the same
   `CONTESTSCORE_API_TOKEN` set on the server -- see step 3 below).
3. Run it: `contestpulse-windows-amd64.exe config.json` (or the matching
   binary for whatever runs it). Nothing else to install.

## Alternative: raw UDP over Tailscale/ZeroTier

If you'd rather not run an extra process, the UDP listeners already bind to
all interfaces, so a logging PC joined to this VPS's Tailscale tailnet or
ZeroTier network can unicast (not broadcast) N1MM's traffic directly at the
VPS's overlay IP instead:

- Tailscale: this VPS's tailnet IP (`tailscale ip -4`)
- ZeroTier: this VPS's IP on the relevant network (`zerotier-cli listnetworks`)

This path has no heartbeat, so it won't show up in the realtime/stale/
offline indicator -- that's ContestPulse-specific.

## Steps

1. Create a dedicated service user:
   ```
   sudo useradd --system --create-home --home /opt/contestscore --shell /usr/sbin/nologin contestscore
   ```

2. Clone and install as that user (the app lives in an `app/` subdirectory of
   the service user's home, so its `.env`/`data/` sit alongside it but the
   git checkout itself stays a clean subtree):
   ```
   sudo -u contestscore git clone --branch main https://github.com/chibondking/contestscore.git /opt/contestscore/app
   sudo -u contestscore bash -c 'cd /opt/contestscore/app && npm install --omit=dev'
   sudo -u contestscore mkdir -p /opt/contestscore/app/data
   ```
   (npm 11's install-script allowlist may warn that better-sqlite3's
   postinstall didn't run -- check `node -e "require('better-sqlite3')"`
   from that directory; if it fails to load, run
   `npm install-scripts approve better-sqlite3 && npm install` and, if that
   still needs a from-source build, `sudo apt install build-essential`.)

3. Configure secrets -- copy `.env.example` to
   `/opt/contestscore/app/contestscore.env`, fill in real values, and lock
   it down:
   ```
   sudo -u contestscore cp .env.example /opt/contestscore/app/contestscore.env
   sudo -u contestscore nano /opt/contestscore/app/contestscore.env
   # set HTTP_HOST=127.0.0.1
   # set DB_PATH=/opt/contestscore/app/data/qsos.db
   # set CONTESTSCORE_API_TOKEN, e.g. `openssl rand -hex 32`
   sudo chmod 600 /opt/contestscore/app/contestscore.env
   ```

4. Install and start the service:
   ```
   sudo cp deploy/contestscore.service /etc/systemd/system/contestscore.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now contestscore
   ```

5. Install the nginx site:
   ```
   sudo cp deploy/nginx-scoreboard.wt2p.us.conf /etc/nginx/sites-available/scoreboard.wt2p.us
   sudo ln -s /etc/nginx/sites-available/scoreboard.wt2p.us /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

6. Add the hostname to the Cloudflare Tunnel ingress list in
   `/etc/cloudflared/config.yml` (before the catch-all `http_status:404`
   rule):
   ```yaml
     - hostname: scoreboard.wt2p.us
       service: http://localhost:80
   ```
   then `sudo systemctl restart cloudflared`, and add the matching Public
   Hostname entry in the Cloudflare dashboard for this tunnel.

7. Install the deploy script and set up CI auto-deploy (see
   "Redeploying after the initial setup" above for what this enables):
   ```bash
   sudo install -o root -g root -m 755 deploy/contestscore-deploy.sh /usr/local/bin/contestscore-deploy.sh
   ```
   Then generate a dedicated key for GitHub Actions and restrict it to only
   ever run that script:
   ```bash
   ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-actions-deploy"
   # append to the deploy target user's ~/.ssh/authorized_keys:
   echo 'command="/usr/local/bin/contestscore-deploy.sh",no-port-forwarding,no-x11-forwarding,no-agent-forwarding,no-pty '"$(cat deploy_key.pub)" >> ~/.ssh/authorized_keys
   ```
   Add `deploy_key`'s contents, the host, and the user as the
   `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER` secrets on the GitHub repo
   (`gh secret set NAME`), then delete the local private key copy.

8. Verify: `curl -I https://scoreboard.wt2p.us` should return the dashboard;
   `curl -X DELETE https://scoreboard.wt2p.us/api/db -H "X-Confirm: yes"`
   from off-tailnet should get a plain nginx 403, never reach the app;
   `curl https://scoreboard.wt2p.us/api/version` should return a recent
   `deployedAt`.
