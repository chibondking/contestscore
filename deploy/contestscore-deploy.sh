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

sudo systemctl restart contestscore
sleep 1
sudo systemctl is-active --quiet contestscore

echo "Deployed $(sudo -u contestscore git -C /opt/contestscore/app rev-parse --short HEAD)"
