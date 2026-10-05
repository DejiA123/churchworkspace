#!/usr/bin/env bash
#
# THE CLOUD STUDIO ON A FRESH BOX, IN ONE COMMAND.
#
#   bash scripts/cloud-setup.sh
#
# Written for a brand-new Ubuntu or Debian machine — above all the free-forever
# ARM one Oracle Cloud gives away (4 cores, 24 GB, 200 GB), the only genuinely
# free host with enough disk and uptime to run this properly.
#
# It installs Docker, asks for the (optional) AI keys, builds the studio, gives
# it volumes so nothing is lost on a restart, puts it on an https address, and
# keeps it up to date by itself. Two kinds of address:
#
#   fixed  (default when the machine has a public IP — Oracle does)
#          https://<ip-with-dashes>.sslip.io, a free name for this machine's IP,
#          with a real certificate from Caddy. It NEVER changes, so the app on
#          everyone's home screen keeps working. Needs ports 80 and 443 open in
#          Oracle's console (the script opens the machine's own firewall).
#   tunnel (ADDRESS=tunnel)
#          a Cloudflare quick tunnel: no ports at all, but a random address that
#          changes whenever it restarts.
#
# Optional settings, as environment variables or answered when asked:
#   GROQ_API_KEY        free key (console.groq.com) — captions and scans heard by Whisper Large
#   ANTHROPIC_API_KEY   Claude key — directs montages and proof-reads captions (paid)
#   STUDIO_HOST         your own domain / DuckDNS name instead of the sslip.io one
#   ADDRESS=tunnel      use the tunnel instead of the fixed address
#   AUTO_UPDATE=off     do not pull and rebuild new versions by itself
#
# Run it again any time: it is idempotent, and it reuses the access code and
# keys it saved the first time rather than signing every phone out.

set -euo pipefail

BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$BLUE" "$OFF" "$1"; }
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s  !!%s %s\n' "$YELLOW" "$OFF" "$1"; }
die()  { printf '\n%s  ✗ %s%s\n' "$YELLOW" "$1" "$OFF" >&2; exit 1; }

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$REPO_DIR/.env"   # the file docker compose loads on its own
cd "$REPO_DIR"
[ -f docker-compose.free.yml ] && [ -f docker-compose.oracle.yml ] || die "Run this from inside the project (the docker-compose files were not found)."

# .env helpers: read a value, set a value (the file stays readable only by you)
envget() { if [ -f "$ENV_FILE" ]; then grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; fi; }
envset() {
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  local tmp; tmp="$(mktemp)"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
interactive() { [ -t 0 ] && [ -t 1 ]; }

# ── 0. what are we on ────────────────────────────────────────────────────────
say "Checking the machine"
ARCH="$(uname -m)"
CORES="$(nproc 2>/dev/null || echo 1)"
MEM_GB="$(awk '/MemTotal/ {printf "%.0f", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)"
DISK_GB="$(df -BG --output=avail "$REPO_DIR" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)"
ok "$ARCH, ${CORES} core(s), ${MEM_GB} GB RAM, ${DISK_GB} GB free"
# `if`, not `[ … ] && warn`: under `set -e` a FALSE test would end the script.
if [ "$CORES" -lt 2 ]; then warn "Only ${CORES} core. Exports will be very slow — 2+ cores is the realistic floor."; fi
if [ "$MEM_GB" -lt 2 ]; then warn "Only ${MEM_GB} GB RAM. Captions with a larger speech model may not fit."; fi
if [ "$DISK_GB" -lt 20 ]; then warn "Only ${DISK_GB} GB free. A service recording is often 2-4 GB — give the boot volume 200 GB."; fi

# ── 1. docker ────────────────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker is already here"
else
  say "Installing Docker (a few minutes)"
  command -v curl >/dev/null 2>&1 || { sudo apt-get update -qq && sudo apt-get install -y -qq curl; }
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
  sudo usermod -aG docker "$USER" || true
  ok "Docker installed"
fi
DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# ── 2. the access code ───────────────────────────────────────────────────────
CODE="$(envget MW_CLOUD_CODE)"
if [ -n "$CODE" ]; then
  ok "Reusing the access code from .env"
else
  WORDS=(anchor beacon candle cedar chapel dawn ember falcon garden granite harbour harvest haven hearth hymn iris jasper juniper lantern laurel meadow mercy olive orchard parish pilgrim prairie psalm quarry refuge ridge river sabbath saffron sanctuary shelter shepherd silver sparrow spring steeple stream summer sunrise temple thicket thrive timber trellis trinity valley verse vessel vigil village vine willow window witness wonder)
  pick() { echo "${WORDS[$((RANDOM % ${#WORDS[@]}))]}"; }
  CODE="$(pick)-$(pick)-$(printf '%04d' $((RANDOM % 10000)))-$(pick)"
  envset MW_CLOUD_CODE "$CODE"
  ok "Made an access code (saved in .env, readable only by you)"
fi

# ── 3. the AI keys (optional) ────────────────────────────────────────────────
ask_key() {   # name, what it is for
  local name="$1" what="$2" have val
  have="$(envget "$name")"
  val="${!name:-}"
  if [ -n "$val" ]; then envset "$name" "$val"; ok "$name saved"; return; fi
  if [ -n "$have" ]; then ok "$name already set"; return; fi
  if interactive; then
    printf '%s  ? %s%s\n    Paste it and press Enter (or just Enter to skip): ' "$BLUE" "$what" "$OFF"
    read -r -s val || val=""; echo
    if [ -n "$val" ]; then envset "$name" "$val"; ok "$name saved"; else warn "No $name — run this again later to add it."; fi
  fi
}
ask_key GROQ_API_KEY "A free Groq key (console.groq.com → API Keys): captions and sermon scans heard by Whisper Large — strongly recommended"
ask_key ANTHROPIC_API_KEY "A Claude API key (console.anthropic.com), optional and paid: Claude directs AI montages and proof-reads captions"

# ── 4. which address ─────────────────────────────────────────────────────────
public_ip() { curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true; }
MODE="${ADDRESS:-$(envget ADDRESS)}"
HOST="${STUDIO_HOST:-$(envget STUDIO_HOST)}"
if [ "$MODE" != "tunnel" ] && [ -z "$HOST" ]; then
  IP="$(public_ip)"
  if [[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then HOST="${IP//./-}.sslip.io"; MODE=fixed
  elif [ "$MODE" = "fixed" ]; then die "Could not find this machine's public IP. Set STUDIO_HOST=your.name or ADDRESS=tunnel and run again."
  else MODE=tunnel; fi
fi
[ -n "$MODE" ] || MODE=fixed
envset ADDRESS "$MODE"
if [ "$MODE" = "fixed" ]; then
  envset STUDIO_HOST "$HOST"
  envset COMPOSE_FILE docker-compose.oracle.yml   # plain `docker compose …` now means this setup
  ok "Fixed address: https://$HOST"
  # The machine's own firewall. Oracle's Ubuntu image rejects everything but SSH
  # in iptables; ports 80/443 must ALSO be opened in Oracle's console (CLOUD.md).
  say "Opening ports 80 and 443 on this machine's firewall"
  if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
    sudo ufw allow 80/tcp >/dev/null; sudo ufw allow 443/tcp >/dev/null
  fi
  if command -v iptables >/dev/null 2>&1; then
    for p in 80 443; do
      sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
    done
    if command -v netfilter-persistent >/dev/null 2>&1; then sudo netfilter-persistent save >/dev/null 2>&1 || true
    else sudo sh -c 'mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4' 2>/dev/null || true; fi
  fi
  ok "Firewall open here (Oracle's Security List must allow 80 and 443 too)"
else
  envset COMPOSE_FILE docker-compose.free.yml
  ok "Tunnel address (random, changes on restart)"
fi

# ── 5. build and start ───────────────────────────────────────────────────────
say "Building the studio — the first time compiles whisper.cpp, so 10-20 minutes"
$DOCKER compose build
say "Starting it"
# the other setup's containers, if this machine ran it before, are stopped first (the volumes stay)
if [ "$MODE" = "fixed" ]; then $DOCKER compose -f docker-compose.free.yml down --remove-orphans >/dev/null 2>&1 || true
else $DOCKER compose -f docker-compose.oracle.yml down --remove-orphans >/dev/null 2>&1 || true; fi
$DOCKER compose up -d --remove-orphans
ok "Containers are up"

# ── 6. keep itself up to date ────────────────────────────────────────────────
if [ "${AUTO_UPDATE:-on}" != "off" ] && git -C "$REPO_DIR" remote get-url origin >/dev/null 2>&1; then
  LINE="*/30 * * * * cd '$REPO_DIR' && bash scripts/cloud-update.sh >> '$HOME/studio-update.log' 2>&1"
  ( crontab -l 2>/dev/null | grep -v 'scripts/cloud-update.sh' || true ; echo "$LINE" ) | crontab -
  ok "Updates itself: checks every 30 minutes, never in the middle of an export"
fi

# ── 7. the address, and proof it answers ─────────────────────────────────────
URL=""
if [ "$MODE" = "fixed" ]; then
  URL="https://$HOST"
  say "Getting the certificate and checking it from outside (up to 3 minutes)"
  HELLO=""
  for _ in $(seq 1 36); do
    HELLO="$(curl -fsS --max-time 8 "$URL/api/hello" 2>/dev/null || true)"
    [ -n "$HELLO" ] && break
    sleep 5
  done
  if [ -n "$HELLO" ]; then ok "It answers over the public internet"
  else
    warn "Not reachable yet. Almost always: ports 80/443 are not open in Oracle's console."
    echo "    Oracle console → Networking → Virtual cloud networks → your VCN → Security Lists"
    echo "    → Default Security List → Add Ingress Rules: source 0.0.0.0/0, TCP, port 80; and again for 443."
    echo "    Then wait a minute and open $URL — or run this again."
  fi
else
  say "Waiting for Cloudflare to hand back an address"
  for _ in $(seq 1 60); do
    URL="$($DOCKER compose logs tunnel 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)"
    [ -n "$URL" ] && break
    sleep 2
  done
  [ -n "$URL" ] || { warn "No address yet — check: $DOCKER compose logs tunnel"; exit 0; }
fi

cat <<BANNER

  ${GREEN}The Cloud Studio is live.${OFF}

    address:      ${BLUE}${URL}${OFF}
    access code:  ${BLUE}${CODE}${OFF}

  On the iPhone: open the address in Safari, make your space with the code,
  then Share → ${DIM}Add to Home Screen${OFF} — it opens full screen, like an app.
BANNER
if [ "$MODE" = "fixed" ]; then
  echo "  This address stays the same. (Reserve the public IP in Oracle's console so it is permanent.)"
else
  echo "  ${YELLOW}This address is random and changes if the tunnel restarts.${OFF}"
fi
cat <<BANNER

  Useful later (from $REPO_DIR):
    $DOCKER compose logs -f studio        # what it is doing
    bash scripts/cloud-update.sh          # update now
    bash scripts/cloud-setup.sh           # add a key / change the address
    $DOCKER compose down                  # stop (your files stay)

BANNER
