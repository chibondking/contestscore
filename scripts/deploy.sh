#!/bin/bash
# Manually deploy the current main to scoreboard.wt2p.us from any machine
# that already has your own SSH + sudo access to the VPS as wt2p -- this
# runs the exact same script GitHub Actions triggers
# (.github/workflows/deploy.yml uses a separate, forced-command-restricted
# key for CI; this uses whatever normal SSH key you already have). Nothing
# about deploying is exclusive to CI or to one machine: run this from as
# many machines as you like.
#
# Usage: scripts/deploy.sh [user@host]
#   Defaults to wt2p@147.224.142.162.
set -euo pipefail

TARGET="${1:-wt2p@147.224.142.162}"

echo "Deploying main to $TARGET ..."
# No leading sudo: the script itself is root-owned and world-executable,
# and calls sudo internally only for the specific privileged steps
# (restarting the service, writing as the contestscore user).
ssh "$TARGET" /usr/local/bin/contestscore-deploy.sh
