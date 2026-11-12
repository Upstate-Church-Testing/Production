#!/bin/bash
# Installs the CG Live listener on a CG Mac (see cg-live.sh). Run in Terminal:
#   curl -fsSL https://upstate-church-testing.github.io/Production/tools/cg-live/install.sh | bash -s -- KEY [PORT]
# KEY is that campus's key (from Claude); PORT is ProPresenter's (Settings > Network), 1025 if left out.
# To remove it:  ... | bash -s -- remove
set -e
BASE="https://upstate-church-testing.github.io/Production/tools/cg-live"
DIR="$HOME/Library/Application Support/CG Live"
PLIST="$HOME/Library/LaunchAgents/org.upstatechurch.cg-live.plist"
launchctl unload "$PLIST" 2>/dev/null || true
if [ "$1" = remove ]; then rm -f "$PLIST"; rm -rf "$DIR"; echo "CG Live is removed."; exit 0; fi
KEY="$1"; PORT="${2:-1025}"
[ -n "$KEY" ] || { echo "Give the campus key:  ... | bash -s -- KEY [PORT]"; exit 1; }
case "$PORT" in ''|*[!0-9]*) echo "The port has to be a number (ProPresenter > Settings > Network)."; exit 1;; esac
mkdir -p "$DIR" "$HOME/Library/LaunchAgents"
curl -fsSL "$BASE/cg-live.sh?$(date +%s)" -o "$DIR/cg-live.sh"
chmod 700 "$DIR/cg-live.sh"
printf '%s' "$KEY" > "$DIR/key"; chmod 600 "$DIR/key"
printf '%s' "$PORT" > "$DIR/port"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.upstatechurch.cg-live</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/cg-live.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>ThrottleInterval</key><integer>15</integer>
</dict></plist>
PL
launchctl load "$PLIST"
sleep 4
echo "CG Live is installed and running. ProPresenter port: $PORT"
if curl -s -m 3 -o /dev/null "http://127.0.0.1:$PORT/v1/status/layers"; then echo "ProPresenter answered on port $PORT."
else echo "ProPresenter did NOT answer on port $PORT. Check Settings > Network > Enable Network and the port, then run this again with the right port."; fi
echo "Log: $DIR/cg-live.log"
tail -n 8 "$DIR/cg-live.log" 2>/dev/null || true
