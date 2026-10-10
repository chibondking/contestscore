#!/bin/bash
# Deploys the latest main to this instance. Invoked over SSH by
# .github/workflows/deploy.yml's deploy job on every push to main that
# passes the test job first, and by scripts/deploy.sh for manual deploys
# from any other machine.
#
# Self-updating: the first real step re-installs this exact file from the
# freshly-pulled repo, so editing deploy/contestscore-deploy.sh and pushing
# to main is enough on its own -- no separate manual `install` step, ever.
# (Safe to overwrite while running: the shell already holds this script's
# inode open for reading, so the in-flight run keeps executing the old
# content even after the path now points at the new one.)
#
# First-time install only (nothing here can do this for itself yet):
#   sudo install -o root -g root -m 755 deploy/contestscore-deploy.sh /usr/local/bin/contestscore-deploy.sh
# and the forced-command SSH key setup in DEPLOY.md.
#
# Install to /usr/local/bin/contestscore-deploy.sh, owned root:root, mode
# 755 -- world-executable and world-traversable-to, deliberately NOT inside
# /opt/contestscore (which is 750 contestscore:contestscore, so anyone but
# that user can't even reach a script placed there).
set -euo pipefail

sudo -u contestscore bash -c '
  set -euo pipefail
  cd /opt/contestscore/app
  git fetch origin
  # package-lock.json is tracked, but the npm install below rewrites it in
  # place on this box every deploy -- so the checkout carries a permanently
  # dirty lock file, and the moment a commit actually TOUCHES the lock file
  # (a new dependency), this ff-only merge aborts with "local changes would
  # be overwritten". It sat latent for as long as no commit changed the lock
  # file, then blocked the deploy of the one that did. The lock file is
  # generated and never hand-edited here, so dropping the local churn is
  # always safe. (npm ci would avoid the rewrite entirely, but it wipes
  # node_modules and so rebuilds better-sqlite3 from source on every single
  # deploy -- see DEPLOY.md on how much fun that is on this box.)
  git checkout -- package-lock.json
  git merge --ff-only origin/main
'

sudo install -o root -g root -m 755 \
  /opt/contestscore/app/deploy/contestscore-deploy.sh \
  /usr/local/bin/contestscore-deploy.sh

# Hosted tenants (ops CLAUDE.md Section 23): the instance template and the
# tool that manages them ship from the repo the same way this script does.
sudo install -o root -g root -m 755 \
  /opt/contestscore/app/deploy/contestscore-tenant \
  /usr/local/sbin/contestscore-tenant
sudo install -o root -g root -m 755 \
  /opt/contestscore/app/deploy/hamdata-ctl \
  /usr/local/sbin/hamdata-ctl
# The TUI launcher -- /usr/local/bin, not sbin: it's a read-only viewer a
# human runs, not an admin tool that changes anything.
sudo install -o root -g root -m 755 \
  /opt/contestscore/app/deploy/cstui \
  /usr/local/bin/cstui
sudo install -o root -g root -m 755 \
  /opt/contestscore/app/deploy/contestscore-tenant-agent \
  /usr/local/sbin/contestscore-tenant-agent
for u in contestscore@.service contestscore-offline@.service; do
  if ! sudo cmp -s "/opt/contestscore/app/deploy/$u" "/etc/systemd/system/$u"; then
    sudo install -o root -g root -m 644 \
      "/opt/contestscore/app/deploy/$u" \
      "/etc/systemd/system/$u"
    sudo systemctl daemon-reload
  fi
done
# Same for hamdata's unit -- but only once hamdata is installed at all: a
# box that never set it up must not suddenly grow one.
if [[ -f /etc/systemd/system/hamdata.service ]] \
   && ! sudo cmp -s /opt/contestscore/app/deploy/hamdata.service /etc/systemd/system/hamdata.service; then
  sudo install -o root -g root -m 644 \
    /opt/contestscore/app/deploy/hamdata.service \
    /etc/systemd/system/hamdata.service
  sudo systemctl daemon-reload
fi

sudo -u contestscore bash -c '
  set -euo pipefail
  cd /opt/contestscore/app
  npm install --omit=dev

  # For the dashboards deploy-time footer (GET /api/version) -- lets a
  # viewer tell a cached/stale page apart from a fresh one, since this only
  # changes on a real deploy, never on its own.
  commit=$(git rev-parse --short HEAD)
  deployed_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  printf "{\"commit\":\"%s\",\"deployedAt\":\"%s\"}\n" "$commit" "$deployed_at" > deploy-info.json
'

# hamdata (shared solar + lookup) runs from this same checkout. Restart it
# first so instances come back up against the new version -- but only once
# it's actually installed and enabled, so this script still works on a box
# that never set it up.
if systemctl is-enabled --quiet hamdata 2>/dev/null; then
  sudo systemctl restart hamdata
  sleep 1
  sudo systemctl is-active --quiet hamdata \
    || { echo "deploy: hamdata failed to come back -- see: journalctl -u hamdata -n 50" >&2; exit 1; }
fi

# The single-install unit (a box that hasn't moved to tenants, or a Pi-style
# setup) -- only if it's still enabled.
if systemctl is-enabled --quiet contestscore 2>/dev/null; then
  sudo systemctl restart contestscore
  sleep 1
  sudo systemctl is-active --quiet contestscore \
    || { echo "deploy: contestscore failed to come back -- see: journalctl -u contestscore -n 50" >&2; exit 1; }
fi

# Every RUNNING tenant instance. Suspended ones (stopped + disabled by
# contestscore-tenant) stay down.
mapfile -t tenants < <(systemctl list-units 'contestscore@*.service' --state=active --plain --no-legend | awk '{print $1}')
for u in "${tenants[@]}"; do
  sudo systemctl restart "$u"
done
# Every SUSPENDED tenant gets (or keeps) its "temporarily offline" stand-in
# on the tenant's own port -- deploy/contestscore-offline@.service, see
# deploy/offline-server.js. Suspended means: the directory is there and the
# real unit is disabled (contestscore-tenant suspend). A merely stopped-but-
# enabled instance is a failure to investigate, not a suspension, so it's
# left alone. Converging here rather than only in `suspend` means tenants
# suspended before this existed are covered too, and the page itself picks
# up changes on deploy like everything else.
# (The listing runs under sudo: /opt/contestscore/tenants is 750
# contestscore:contestscore, so this script's own user can't even traverse
# it -- without sudo the glob quietly matches nothing and the whole loop
# silently does nothing at all.)
while read -r id; do
  [[ -n "$id" ]] || continue
  if [[ "$(systemctl is-enabled "contestscore@$id.service" 2>/dev/null || true)" == disabled ]]; then
    sudo systemctl enable --now "contestscore-offline@$id.service" >/dev/null 2>&1 \
      || echo "deploy: offline page for suspended tenant $id did not start" >&2
    sudo systemctl restart "contestscore-offline@$id.service" >/dev/null 2>&1 || true
  fi
done < <(sudo bash -c 'for d in /opt/contestscore/tenants/*/; do [[ -f "$d/tenant.env" ]] && basename "$d"; done' 2>/dev/null || true)

if ((${#tenants[@]})); then
  sleep 2
  for u in "${tenants[@]}"; do
    sudo systemctl is-active --quiet "$u" || { echo "deploy: $u failed to come back" >&2; exit 1; }
  done
  echo "Restarted ${#tenants[@]} tenant instance(s): ${tenants[*]}"
fi

echo "Deployed $(sudo -u contestscore git -C /opt/contestscore/app rev-parse --short HEAD)"
