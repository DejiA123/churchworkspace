#!/usr/bin/env bash
#
# KEEP THE CLOUD STUDIO UP TO DATE — what Render's auto-deploy did, on your own box.
#
#   bash scripts/cloud-update.sh          (cloud-setup.sh runs it every 30 minutes)
#
# Pulls the newest version from GitHub and, if there is one, rebuilds and
# restarts the studio. It never restarts in the middle of an export: if an
# ffmpeg is running it waits for the next round. (A batch of shorts that was
# queued on the server picks up where it left off after a restart anyway.)
# FORCE=1 updates even while something is exporting.

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stamp() { date '+%Y-%m-%d %H:%M'; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

git remote get-url origin >/dev/null 2>&1 || { echo "$(stamp) not a git checkout — nothing to pull"; exit 0; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi

if [ "${FORCE:-0}" != "1" ] && $DOCKER compose exec -T studio sh -c 'pgrep -x ffmpeg >/dev/null || pgrep -f whisper-cli >/dev/null' 2>/dev/null; then
  echo "$(stamp) new version waiting — something is exporting, trying again next round"
  exit 0
fi

echo "$(stamp) updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
git pull -q --ff-only origin "$BRANCH"
$DOCKER compose up -d --build --remove-orphans
$DOCKER image prune -f >/dev/null 2>&1 || true   # old builds take disk the recordings need
echo "$(stamp) updated"
