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
# One at a time: a slow build can outlast the 30 minutes until cron's next round.
exec 9>"${TMPDIR:-/tmp}/church-cloud-update.lock"
flock -n 9 || { [ -t 1 ] && echo "an update is already running"; exit 0; }
stamp() { date '+%Y-%m-%d %H:%M'; }
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

git remote get-url origin >/dev/null 2>&1 || { echo "$(stamp) not a git checkout — nothing to pull"; exit 0; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse "origin/$BRANCH")"

# WHICH VERSION IS ACTUALLY RUNNING. Pulling and building are two steps, and a
# build can fail (a download, a full disk) after the pull has already moved the
# checkout on — so "the checkout is up to date" is not "the studio is". The
# last version that built is written down (.cloud-built) and a version that did
# not build is built again next round instead of being skipped forever. With
# no note yet (the first run of this script), the running image is compared
# with the checkout: an image older than the commit it should contain is one
# whose build never finished.
built_ok() {
  if [ -f .cloud-built ]; then [ "$(cat .cloud-built)" = "$1" ]; return; fi
  local img made
  img="$($DOCKER compose images -q studio 2>/dev/null | head -n1 || true)"
  [ -n "$img" ] || return 1
  made="$(date -d "$($DOCKER image inspect -f '{{.Created}}' "$img" 2>/dev/null)" +%s 2>/dev/null || echo 0)"
  [ "$made" -ge "$(git log -1 --format=%ct "$1")" ]
}
if [ "$LOCAL" = "$REMOTE" ] && built_ok "$LOCAL"; then
  # A key added to .env since the studio started (scripts/cloud-keys.sh does
  # this for you): restart it with the new settings — compose only recreates
  # the container when they really changed.
  if [ -f .env ] && [ -f .cloud-built ] && [ .env -nt .cloud-built ]; then
    $DOCKER compose up -d --remove-orphans >/dev/null 2>&1 || true
    touch .cloud-built
    echo "$(stamp) the settings in .env changed — the studio now runs with them"
  fi
  # Said only to a person at a terminal — cron runs this every 30 minutes into a log.
  if [ -t 1 ]; then
    echo "$(stamp) already up to date: $BRANCH is at ${LOCAL:0:7} here and on GitHub, and that is what is running."
    echo "             (Work still on another branch arrives once it is merged into $BRANCH.)"
  fi
  exit 0
fi

# Only when nobody is using it. A restart takes ~20 seconds, but in those
# seconds an upload would break and an open editor would lose its connection,
# so a new version waits until the studio has been quiet for a while (default
# 15 minutes: no uploads, no exports, nobody tapping anything) — at the latest
# that is the middle of the night. FORCE=1 skips the wait.
IDLE_MIN="${MW_UPDATE_IDLE_MIN:-15}"
if [ "${FORCE:-0}" != "1" ]; then
  # (the voice cleaner too: a long Studio-sound export spends minutes in it with no ffmpeg running)
  if $DOCKER compose exec -T studio sh -c 'pgrep -x ffmpeg >/dev/null || pgrep -x deep-filter >/dev/null || pgrep -f whisper-cli >/dev/null' 2>/dev/null; then
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

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "$(stamp) updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
  git pull -q --ff-only origin "$BRANCH"
else
  echo "$(stamp) ${REMOTE:0:7} is checked out but did not finish building last time — building it again"
fi
$DOCKER compose up -d --build --remove-orphans
echo "$REMOTE" > .cloud-built
$DOCKER image prune -f >/dev/null 2>&1 || true   # old builds take disk the recordings need
echo "$(stamp) updated"
