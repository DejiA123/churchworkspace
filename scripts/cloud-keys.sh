#!/usr/bin/env bash
#
# THE STUDIO'S FREE AI KEYS — add one, change one, or just see which are set.
#
#   bash scripts/cloud-keys.sh            shows which keys the studio has, asks for a missing Gemini key
#   bash scripts/cloud-keys.sh gemini     asks for the Gemini key (again)
#   bash scripts/cloud-keys.sh groq       asks for the Groq key (again)
#
# What you paste is never shown on the screen or kept in the shell's history.
# It is checked with the service, saved in .env (readable only by you) and the
# studio is restarted with it. Then the studio ITSELF is asked which keys it
# can see — so "set" here means the captions really will use it.

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
ok()   { printf '%s  ok%s %s\n' "$GREEN" "$OFF" "$1"; }
warn() { printf '%s  !!%s %s\n' "$YELLOW" "$OFF" "$1"; }
ENV_FILE=.env
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

envget() { if [ -f "$ENV_FILE" ]; then grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; fi; }
envset() {
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  local tmp; tmp="$(mktemp)"
  grep -vE "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}

# Does the service accept this key? Prints the HTTP status (200 = yes).
check_key() {
  # curl prints its code (000 when it cannot connect) and fails: the code alone is the answer
  local code=''
  case "$1" in
    GEMINI_API_KEY) code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "x-goog-api-key: $2" 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1' 2>/dev/null)" || true ;;
    GROQ_API_KEY)   code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H "Authorization: Bearer $2" 'https://api.groq.com/openai/v1/models' 2>/dev/null)" || true ;;
    *) code=200 ;;
  esac
  case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
  printf '%s' "$code"
}

ask() {   # name, where to get it, what it looks like
  local name="$1" where="$2" looks="$3" val code
  printf '%s  ? %s%s\n    Paste it and press Enter (it will not show): ' "$BLUE" "$where" "$OFF"
  read -r -s val || val=""; echo
  val="$(printf '%s' "$val" | tr -d '[:space:]')"
  if [ -z "$val" ]; then warn "Nothing pasted — $name not changed."; return 1; fi
  case "$val" in "$looks"*) ;; *) warn "That does not look like a $name (it usually starts with \"$looks\") — checking it anyway." ;; esac
  code="$(check_key "$name" "$val")"
  if [ "$code" = "200" ]; then ok "the service accepts this key"
  elif [ "$code" = "000" ]; then warn "could not reach the service to check it — saving it anyway"
  else warn "the service REFUSED this key (answer $code) — not saved. Copy it again and re-run this."; return 1; fi
  envset "$name" "$val"; ok "$name saved"
}

WANT="${1:-}"
changed=0
if [ "$WANT" = "gemini" ] || { [ -z "$WANT" ] && [ -z "$(envget GEMINI_API_KEY)" ]; }; then
  ask GEMINI_API_KEY "A free Google Gemini key (aistudio.google.com → Get API key → Create API key)" "AIza" && changed=1 || true
fi
if [ "$WANT" = "groq" ]; then
  ask GROQ_API_KEY "A free Groq key (console.groq.com → API Keys)" "gsk_" && changed=1 || true
fi

if [ "$changed" = "1" ]; then
  # never in the middle of an export (the restart would break it): then the next update round does it
  if $DOCKER compose exec -T studio sh -c 'pgrep -x ffmpeg >/dev/null || pgrep -f "[w]hisper-cli" >/dev/null' 2>/dev/null; then
    warn "something is exporting right now — the studio will start using the new key at the next update round"
    warn "(or run this when the export is done:  FORCE=1 bash scripts/cloud-update.sh)"
  else
    echo "  restarting the studio with the new key…"
    $DOCKER compose up -d --remove-orphans >/dev/null 2>&1 || $DOCKER compose up -d --remove-orphans
  fi
fi

# What the running studio can actually see (names only — never the keys).
echo
echo "  The studio has:"
if ! $DOCKER compose exec -T studio sh -c '
  for k in GROQ_API_KEY GEMINI_API_KEY ANTHROPIC_API_KEY; do
    eval v=\${$k:-}
    case $k in GROQ_API_KEY) w="captions + scans (Whisper)";; GEMINI_API_KEY) w="the third ear that checks every caption";; *) w="Claude (paid, optional)";; esac
    if [ -n "$v" ]; then echo "    ✓ $k — $w"; else echo "    ✗ $k — not set ($w)"; fi
  done' 2>/dev/null; then
  warn "the studio is not running — start it with: FORCE=1 bash scripts/cloud-update.sh"
fi
