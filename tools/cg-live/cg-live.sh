#!/bin/bash
# CG Live listener (Production app). Runs on a CG Mac beside ProPresenter 7 and passes on
# what ProPresenter says is on screen, the moment it changes. It only reads: it never
# controls ProPresenter, reads the screen, or touches the output.
#
# How: ProPresenter's own network API on this Mac (http://127.0.0.1:PORT/v1/...). Four
# requests are held open (?chunked=true): ProPresenter writes to them only when something
# changes, so this sits idle in between. Each complete answer goes, unchanged, to the app's
# cg-live function with this campus's key; the parsing is done there, not on this Mac.
# Once a minute it also asks the same four things plainly, so a missed change is put right,
# and says "still here" (only while ProPresenter is answering). On each slide change it also
# fetches ProPresenter's own small thumbnail of that slide and passes that on (a file named
# thumb beside this script holding 0 turns the pictures off).
#
# Needs only bash and curl, which every Mac has. Installed by install.sh as a launch
# agent (starts at login, restarts itself, background priority). Log: cg-live.log beside it.

DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="$(cat "$DIR/key" 2>/dev/null)"
PORT="$(cat "$DIR/port" 2>/dev/null)"; PORT="${PORT:-1025}"
THUMB="$(cat "$DIR/thumb" 2>/dev/null)"; THUMB="${THUMB:-400}"   # the picture's size (ProPresenter's "quality"); 0 = no pictures
FN="${CG_LIVE_FN:-https://khmqzrxfidwhchmkgdfn.supabase.co/functions/v1/cg-live}"
PP="http://127.0.0.1:$PORT/v1"
ST="$DIR/state"; LOG="$DIR/cg-live.log"
PATHS="presentation/active presentation/slide_index status/slide status/layers"
[ -n "$KEY" ] || { echo "no key in $DIR/key" >&2; exit 1; }
mkdir -p "$ST"; rm -f "$ST"/*; : > "$LOG"
log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
trap 'kill 0' EXIT

# The picture of the slide that's live: ProPresenter's own thumbnail of it (a small JPEG it
# makes itself; the screen is never read), fetched and passed on. Asked for by the app's
# function in its reply to a slide change, as "thumb <presentation id> <slide> <when>".
thumb() { # presentation uuid, slide (from 0), when it was asked for
  local u="$1" i="$2" at="$3" f="$ST/thumb.$$.$RANDOM.jpg" code
  case "$u" in ''|*[!A-Za-z0-9-]*) return 0;; esac
  case "$i" in ''|*[!0-9]*) return 0;; esac
  case "$at" in ''|*[!0-9]*) return 0;; esac
  code="$(curl -s -m 5 -o "$f" -w '%{http_code}' "$PP/presentation/$u/thumbnail/$i?quality=$THUMB" 2>/dev/null)"
  if [ "$code" = 200 ] && [ -s "$f" ]; then
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$FN?kind=thumb&uuid=$u&index=$i&at=$at" \
      -H "x-cg-key: $KEY" -H 'Content-Type: image/jpeg' --data-binary @"$f" 2>/dev/null)"
    log "thumb slide $((i + 1)) -> $code ($(wc -c < "$f" | tr -d ' ') bytes)"
  else
    log "thumb slide $((i + 1)): ProPresenter said $code"
  fi
  rm -f "$f"
}

# Send one answer on, unless it's the same as the last one sent for that question.
post() { # kind, json
  local k="${1//\//_}" sum resp code reply
  sum="$(printf '%s' "$2" | cksum)"
  [ "$sum" = "$(cat "$ST/$k" 2>/dev/null)" ] && return 0
  resp="$(printf '%s' "$2" | curl -s -m 8 -w '\n%{http_code}' -X POST "$FN?kind=$1" \
    -H "x-cg-key: $KEY" -H 'Content-Type: application/json' --data-binary @- 2>/dev/null)"
  code="${resp##*$'\n'}"; reply="${resp%$'\n'*}"
  [ "$code" = 200 ] && printf '%s' "$sum" > "$ST/$k"
  log "$1 -> $code (${#2} bytes)"
  if [ "$code" = 200 ] && [ "$THUMB" != 0 ]; then case "$reply" in "thumb "*) set -- $reply; thumb "$2" "$3" "$4" & ;; esac; fi
}

# One held-open request. The stream is cut into whole JSON objects by counting braces (so
# it doesn't matter how ProPresenter spaces them), and each is handed over the instant
# its last brace arrives. Plain bash: nothing here that a Mac doesn't run the same way.
follow() {
  local path="$1" part buf d o
  while true; do
    buf=""; d=0
    while IFS= read -r -d '}' part; do
      buf+="$part}"; o="${part//[^\{]/}"; d=$((d + ${#o} - 1))
      if [ "$d" -le 0 ]; then
        buf="${buf//$'\r'/ }"; buf="${buf//$'\n'/ }"; buf="${buf#"${buf%%[![:space:],]*}"}"
        [ "${buf:0:1}" = "{" ] && post "$path" "$buf"
        buf=""; d=0
      fi
    done < <(curl -sN "$PP/$path?chunked=true" 2>/dev/null)
    sleep 5   # ProPresenter closed or restarting: try again shortly
  done
}
for p in $PATHS; do follow "$p" & done

# Once a minute: ask plainly (puts right anything missed), and say "still here".
log "started, ProPresenter port $PORT"
while true; do
  up=0
  for p in $PATHS; do
    body="$(curl -s -m 3 -w '\n%{http_code}' "$PP/$p" 2>/dev/null)" || continue
    code="${body##*$'\n'}"; body="${body%$'\n'*}"
    [ -n "$code" ] && [ "$code" != 000 ] || continue
    up=1
    if [ "$code" = 200 ] && [ -n "${body//[[:space:]]/}" ]; then post "$p" "$(printf '%s' "$body" | tr '\r\n' '  ')"; else post "$p" '{}'; fi
  done
  [ "$up" = 1 ] && curl -s -m 8 -o /dev/null -X POST "$FN?kind=heartbeat" -H "x-cg-key: $KEY" -H 'Content-Type: application/json' -d '{}' 2>/dev/null
  [ "$(wc -l < "$LOG")" -gt 600 ] && { tail -n 300 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; }
  sleep 60
done
