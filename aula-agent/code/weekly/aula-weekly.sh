#!/usr/bin/env bash
# Weekly Aula summary: asks Claude (read-only Aula MCP tools) what needs doing the coming week,
# posts it to Discord and sends a short push nudge through Home Assistant.
# Cron example: 0 18 * * 0  /path/to/aula-weekly.sh
#   aula-weekly.sh --dry-run   print the summary, send nothing
#
# Configuration comes from an env file (default: ~/.config/aula-agent/env, see .env.example).
# Secrets (bot token, webhook URL, HA token) live there with 600 perms, never in this script.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/aula-weekly.log"
mkdir -p "$LOG_DIR"

ENV_FILE="${AULA_AGENT_ENV:-$HOME/.config/aula-agent/env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

: "${HA_URL:?set HA_URL in $ENV_FILE}"                 # e.g. http://homeassistant.local:8123
: "${HA_NOTIFY_SERVICE:?set HA_NOTIFY_SERVICE}"        # e.g. notify/mobile_app_<your_phone>
: "${HA_TOKEN:=}"                                       # long-lived access token
: "${DISCORD_BOT_TOKEN:=}"                              # same bot that answers questions (code/bot)
: "${DISCORD_CHANNEL_ID:=}"                             # the private #aula channel
: "${DISCORD_WEBHOOK_URL:=}"                            # fallback if the bot post fails

# cron has a minimal PATH; claude and bun live in the home dir
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"; }

PROMPT='Brug Aula-værktøjerne (kun læsning) til at finde ud af hvad der skal gøres i den kommende uge.
Tjek beskeder, opslag, kalender og ugeplan for de næste 7 dage, samt ubesvarede beskeder.
Svar på dansk, kort og uden indledning, i præcis tre afsnit:
Skal gøres: ting der kræver handling eller svar, med frist.
Denne uge: begivenheder, ting der skal med, udflugter, møder.
Til info: kun hvis vigtigt.
Udelad afsnit uden indhold. Hold samlet svar under 1500 tegn. Brug fed til afsnitsoverskrifter og punktopstilling (Discord-markdown).'

discord() {  # $1 message; Discord caps a message at 2000 chars. Bot first, webhook as fallback.
  local body
  body="$(python3 -c 'import json,sys; print(json.dumps({"content": sys.argv[1][:1990]}))' "$1")"
  if [ -n "$DISCORD_BOT_TOKEN" ] && [ -n "$DISCORD_CHANNEL_ID" ] && \
     curl -sf -o /dev/null -X POST "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID/messages" \
      -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H "Content-Type: application/json" -d "$body"; then
    return 0
  fi
  log "WARN: bot post failed, trying webhook"
  [ -n "$DISCORD_WEBHOOK_URL" ] || { log "ERROR: no DISCORD_WEBHOOK_URL configured"; return 1; }
  curl -sf -o /dev/null -X POST "$DISCORD_WEBHOOK_URL" -H "Content-Type: application/json" -d "$body"
}

send() {  # $1 title, $2 message (HA push)
  [ -n "$HA_TOKEN" ] || { log "ERROR: no HA_TOKEN configured"; return 1; }
  local body
  body="$(python3 -c 'import json,sys; print(json.dumps({"title": sys.argv[1], "message": sys.argv[2]}))' "$1" "$2")"
  curl -sf -o /dev/null -X POST "$HA_URL/api/services/$HA_NOTIFY_SERVICE" \
    -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" -d "$body"
}

log "run start (dry_run=$DRY_RUN)"
summary="$(timeout 300 claude -p "$PROMPT" --allowedTools "mcp__aula__*" --output-format text 2>>"$LOG_FILE")"
rc=$?
# drop the org reminder line the CLI may print
summary="$(printf '%s\n' "$summary" | grep -v '^Org reminder:')"

if [ $rc -ne 0 ] || [ -z "${summary//[[:space:]]/}" ]; then
  log "ERROR: claude exit=$rc, empty or failed summary"
  [ $DRY_RUN -eq 1 ] && { echo "FAILED (exit=$rc)"; exit 1; }
  send "Aula-opsummering fejlede" "Kunne ikke hente ugens Aula-opsummering. Tjek login: pnpm aula status (se aula-weekly.log)." || log "ERROR: failure push also failed"
  exit 1
fi

if [ $DRY_RUN -eq 1 ]; then
  printf '%s\n' "$summary"
  exit 0
fi

if discord "$summary"; then
  log "summary sent to Discord (${#summary} chars)"   # status only, never content (children's data)
  send "Aula: ugen der kommer" "Opsummeringen er klar i Discord (#aula)." || log "ERROR: HA nudge failed"
else
  log "ERROR: Discord post failed"
  send "Aula-opsummering fejlede" "Kunne ikke sende til Discord. Se aula-weekly.log." || log "ERROR: failure push also failed"
  exit 1
fi
