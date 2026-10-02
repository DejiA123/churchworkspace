#!/usr/bin/env bash
#
# THE CLOUD STUDIO ON A FRESH BOX, IN ONE COMMAND.
#
#   curl -fsSL <this file> | bash          (or: bash scripts/cloud-setup.sh)
#
# Written for a brand-new Ubuntu or Debian machine — including the free-forever
# ARM one Oracle Cloud gives away, which is the only genuinely free host with
# enough disk and uptime to run this properly.
#
# It installs Docker, builds the studio, gives it a volume so nothing is lost on
# a restart, starts a Cloudflare tunnel, and prints the https address and the
# access code. It opens no ports and needs no domain.
#
# Run it again any time: it is idempotent, and it will reuse the access code it
# generated the first time rather than signing every phone out.

set -euo pipefail

BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$BLUE" "$OFF" "$1"; }
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s  !!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n%s  ✗ %s%s\n' "$YELLOW" "$1" "$OFF" >&2; exit 1; }

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$REPO_DIR/.env"   # the file docker compose loads on its own
COMPOSE_FILE="$REPO_DIR/docker-compose.free.yml"
COMPOSE_SHORT="docker-compose.free.yml"   # what the banner tells you to type

[ -f "$COMPOSE_FILE" ] || die "Run this from inside the project (docker-compose.free.yml not found)."

# ── 0. what are we on ────────────────────────────────────────────────────────
say "Checking the machine"
ARCH="$(uname -m)"
CORES="$(nproc 2>/dev/null || echo 1)"
MEM_GB="$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)"
DISK_GB="$(df -BG --output=avail "$REPO_DIR" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
ok "$ARCH, ${CORES} core(s), ${MEM_GB} GB RAM, ${DISK_GB} GB free"

# Editing video on one core is not a slow experience, it is a broken one: a
# service-length export would run for hours. Better to say so now than after the
# first attempt.
# `if`, not `[ … ] && warn`: under `set -e` a test that is FALSE makes the whole
# line return non-zero, and the script would exit here on a perfectly good machine.
if [ "$CORES" -lt 2 ]; then warn "Only ${CORES} core. Exports will be very slow — 2+ cores is the realistic floor."; fi
if [ "$MEM_GB" -lt 2 ]; then warn "Only ${MEM_GB} GB RAM. Captions with a larger speech model may not fit."; fi
if [ "$DISK_GB" -lt 20 ]; then warn "Only ${DISK_GB} GB free. A service recording is often 2-4 GB."; fi

# ── 1. docker ────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker is already here"
else
  say "Installing Docker (a few minutes)"
  command -v curl >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y -qq curl; }
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
  sudo usermod -aG docker "$USER" || true
  ok "Docker installed"
  warn "You have been added to the 'docker' group — log out and back in to use docker without sudo."
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# ── 2. the access code ───────────────────────────────────────────────────────
# Kept in a file so a re-run does not roll the code and sign every phone out.
if [ -f "$ENV_FILE" ] && grep -q MW_CLOUD_CODE "$ENV_FILE"; then
  CODE="$(grep MW_CLOUD_CODE "$ENV_FILE" | cut -d= -f2-)"
  ok "Reusing the access code from $ENV_FILE"
else
  say "Making an access code"
  WORDS=(anchor beacon candle cedar chapel dawn ember falcon garden granite harbour harvest haven hearth hymn iris jasper juniper lantern laurel meadow mercy olive orchard parish pilgrim prairie psalm quarry refuge ridge river sabbath saffron sanctuary shelter shepherd silver sparrow spring steeple stream summer sunrise temple thicket thrive timber trellis trinity valley verse vessel vigil village vine willow window witness wonder)
  pick() { echo "${WORDS[$((RANDOM % ${#WORDS[@]}))]}"; }
  CODE="$(pick)-$(pick)-$(printf '%04d' $((RANDOM % 10000)))-$(pick)"
  printf 'MW_CLOUD_CODE=%s\n' "$CODE" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Written to $ENV_FILE (readable only by you)"
fi

# ── 3. build and start ───────────────────────────────────────────────────────
say "Building the studio — the first time compiles whisper.cpp, so 10-20 minutes"
MW_CLOUD_CODE="$CODE" $DOCKER compose -f "$COMPOSE_FILE" build
say "Starting it"
MW_CLOUD_CODE="$CODE" $DOCKER compose -f "$COMPOSE_FILE" up -d
ok "Containers are up"

# ── 4. wait for the address ──────────────────────────────────────────────────
say "Waiting for Cloudflare to hand back an address"
URL=""
for _ in $(seq 1 60); do
  URL="$($DOCKER compose -f "$COMPOSE_FILE" logs tunnel 2>/dev/null \
        | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
  [ -n "$URL" ] && break
  sleep 2
done

if [ -z "$URL" ]; then
  warn "No address yet. It is usually slow rather than broken — check with:"
  echo "    $DOCKER compose -f $COMPOSE_SHORT logs tunnel"
  exit 0
fi

# ── 5. prove it actually answers ─────────────────────────────────────────────
say "Checking it from the outside"
HELLO=""
for _ in $(seq 1 20); do
  HELLO="$(curl -fsS --max-time 10 "$URL/api/hello" 2>/dev/null || true)"
  [ -n "$HELLO" ] && break
  sleep 3
done
[ -n "$HELLO" ] && ok "It answers over the public internet" || warn "The address is up but not answering yet; give it a minute."

cat <<BANNER

  ${GREEN}The Cloud Studio is live.${OFF}

    address:      ${BLUE}${URL}${OFF}
    access code:  ${BLUE}${CODE}${OFF}

  On the phone: open the address, type the code, then use the browser menu to
  ${DIM}Add to Home Screen${OFF} — it opens full screen, like an app.

  ${YELLOW}That address is random and changes if the tunnel restarts.${OFF} For one that
  stays the same, put a Cloudflare tunnel token in docker-compose.free.yml.

  Your recordings are NOT here yet — this machine is empty. Send them up with
  ${DIM}📁 Files → ⬆ Send a video${OFF} in the studio, or copy them straight in:

    $DOCKER cp "a-service.mp4" "\$($DOCKER compose -f $COMPOSE_SHORT ps -q studio)":/media/

  Useful later:
    $DOCKER compose -f $COMPOSE_SHORT logs -f studio     # what it is doing
    $DOCKER compose -f $COMPOSE_SHORT restart            # new address
    $DOCKER compose -f $COMPOSE_SHORT down               # stop (your files stay)

BANNER
