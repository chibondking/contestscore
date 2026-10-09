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
sudo install -o root -g root -m 755 \
  /opt/contestscore/app/deploy/contestscore-tenant-agent \
  /usr/local/sbin/contestscore-tenant-agent
if ! sudo cmp -s /opt/contestscore/app/deploy/contestscore@.service /etc/systemd/system/contestscore@.service; then
  sudo install -o root -g root -m 644 \
    /opt/contestscore/app/deploy/contestscore@.service \
    /etc/systemd/system/contestscore@.service
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
  sudo systemctl is-active --quiet hamdata
fi

# The single-install unit (a box that hasn't moved to tenants, or a Pi-style
# setup) -- only if it's still enabled.
if systemctl is-enabled --quiet contestscore 2>/dev/null; then
  sudo systemctl restart contestscore
  sleep 1
  sudo systemctl is-active --quiet contestscore
fi

# Every RUNNING tenant instance. Suspended ones (stopped + disabled by
# contestscore-tenant) stay down.
mapfile -t tenants < <(systemctl list-units 'contestscore@*.service' --state=active --plain --no-legend | awk '{print $1}')
for u in "${tenants[@]}"; do
  sudo systemctl restart "$u"
done
if ((${#tenants[@]})); then
  sleep 2
  for u in "${tenants[@]}"; do
    sudo systemctl is-active --quiet "$u" || { echo "deploy: $u failed to come back" >&2; exit 1; }
  done
  echo "Restarted ${#tenants[@]} tenant instance(s): ${tenants[*]}"
fi

echo "Deployed $(sudo -u contestscore git -C /opt/contestscore/app rev-parse --short HEAD)"
