#!/usr/bin/env bash
#
# KEEP THE CLOUD STUDIO UP TO DATE — what Render's auto-deploy did, on your own box.
#
#   bash scripts/cloud-update.sh          (cloud-setup.sh runs it every 30 minutes)
#
# Pulls the newest version from GitHub and, if there is one, rebuilds and
# restarts the studio. It never restarts while anyone is using it: during an
# export, an upload, or within 15 minutes of anyone's last tap it waits for the
# next round. (A batch of shorts queued on the server picks up where it left
# off after a restart anyway.) FORCE=1 updates straight away.

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
stamp() { date '+%Y-%m-%d %H:%M'; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

git remote get-url origin >/dev/null 2>&1 || { echo "$(stamp) not a git checkout — nothing to pull"; exit 0; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi

# Only when nobody is using it. A restart takes ~20 seconds, but in those
# seconds an upload would break and an open editor would lose its connection,
# so a new version waits until the studio has been quiet for a while (default
# 15 minutes: no uploads, no exports, nobody tapping anything) — at the latest
# that is the middle of the night. FORCE=1 skips the wait.
IDLE_MIN="${MW_UPDATE_IDLE_MIN:-15}"
if [ "${FORCE:-0}" != "1" ]; then
  if $DOCKER compose exec -T studio sh -c 'pgrep -x ffmpeg >/dev/null || pgrep -f whisper-cli >/dev/null' 2>/dev/null; then
    echo "$(stamp) new version waiting — something is exporting, trying again next round"
    exit 0
  fi
  IDLE="$($DOCKER compose exec -T studio node -e "require('http').get('http://127.0.0.1:'+(process.env.MW_CLOUD_PORT||7390)+'/api/idle',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{const j=JSON.parse(b);console.log(j.uploads>0?0:j.idleSec)}catch(e){console.log(-1)}})}).on('error',()=>console.log(-1))" 2>/dev/null | tr -dc '0-9-' || true)"
  # (-1 / nothing = an older studio without /api/idle, or not running: update)
  if [ -n "$IDLE" ] && [ "$IDLE" -ge 0 ] && [ "$IDLE" -lt $((IDLE_MIN * 60)) ]; then
    echo "$(stamp) new version waiting — someone is using the studio, trying again next round"
    exit 0
  fi
fi

echo "$(stamp) updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
git pull -q --ff-only origin "$BRANCH"
$DOCKER compose up -d --build --remove-orphans
$DOCKER image prune -f >/dev/null 2>&1 || true   # old builds take disk the recordings need
echo "$(stamp) updated"
