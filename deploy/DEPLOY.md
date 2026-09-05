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

## UDP ingestion from the shack

N1MM's UDP broadcasts don't route over the public internet -- broadcast
addressing is LAN-local. The logging PC needs to be joined to the same
Tailscale tailnet or ZeroTier network as this VPS, and N1MM's Broadcast Data
config should point at this box's overlay IP directly (unicast, not a
broadcast address):

- Tailscale: this VPS's tailnet IP (`tailscale ip -4`)
- ZeroTier: this VPS's IP on the relevant network (`zerotier-cli listnetworks`)

The UDP listeners bind to all interfaces by default, so no listener-side
change is needed once the logging PC can reach either overlay IP.

## Steps

1. Create a dedicated service user:
   ```
   sudo useradd --system --home /opt/contestscore --shell /usr/sbin/nologin contestscore
   sudo mkdir -p /opt/contestscore
   sudo chown contestscore:contestscore /opt/contestscore
   ```

2. Clone and install as that user:
   ```
   sudo -u contestscore git clone https://github.com/chibondking/contestscore.git /opt/contestscore
   cd /opt/contestscore
   sudo -u contestscore npm install --production
   sudo -u contestscore mkdir -p data
   ```

3. Configure secrets -- copy `.env.example` to `/opt/contestscore/contestscore.env`,
   fill in real values, and lock it down:
   ```
   sudo -u contestscore cp .env.example /opt/contestscore/contestscore.env
   sudo -u contestscore nano /opt/contestscore/contestscore.env
   # set HTTP_HOST=127.0.0.1
   # set CONTESTSCORE_API_TOKEN, e.g. `openssl rand -hex 32`
   sudo chmod 600 /opt/contestscore/contestscore.env
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

7. Verify: `curl -I https://scoreboard.wt2p.us` should return the dashboard;
   `curl -X DELETE https://scoreboard.wt2p.us/api/db -H "X-Confirm: yes"`
   from off-tailnet should get a plain nginx 403, never reach the app.
