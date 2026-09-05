#!/bin/bash
# Deploys the latest main to this instance. Invoked over SSH by
# .github/workflows/deploy.yml's deploy job on every push to main that
# passes the test job first, and by scripts/deploy.sh for manual deploys
# from any other machine.
#
# Install to /usr/local/bin/contestscore-deploy.sh, owned root:root, mode
# 755 -- world-executable and world-traversable-to, deliberately NOT inside
# /opt/contestscore (which is 750 contestscore:contestscore, so anyone but
# that user can't even reach a script placed there).
#
#   sudo install -o root -g root -m 755 deploy/contestscore-deploy.sh /usr/local/bin/contestscore-deploy.sh
#
# For CI, this also needs to be the forced command on a dedicated SSH key in
# wt2p's ~/.ssh/authorized_keys -- see DEPLOY.md.
set -euo pipefail

sudo -u contestscore bash -c '
  set -euo pipefail
  cd /opt/contestscore/app
  git fetch origin
  git merge --ff-only origin/main
  npm install --omit=dev

  # For the dashboards deploy-time footer (GET /api/version) -- lets a
  # viewer tell a cached/stale page apart from a fresh one, since this only
  # changes on a real deploy, never on its own.
  commit=$(git rev-parse --short HEAD)
  deployed_at=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  printf "{\"commit\":\"%s\",\"deployedAt\":\"%s\"}\n" "$commit" "$deployed_at" > deploy-info.json
'

sudo systemctl restart contestscore
sleep 1
sudo systemctl is-active --quiet contestscore

echo "Deployed $(sudo -u contestscore git -C /opt/contestscore/app rev-parse --short HEAD)"
