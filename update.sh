#!/bin/zsh
set -e
cd /Volumes/WorkDrive/andrewhouser/Developer/AgentSpine
echo "Pulling latest from origin..."
git pull origin
echo "Installing dependencies..."
npm install
echo "Building web client..."
npm run web:build
# The Calendar/Reminders helper. The Info.plist is linked into the binary because macOS
# refuses calendar access to a process with no usage description. A failure here only
# disables those actions (mac_control retries the build on first use), so it warns.
echo "Building EventKit helper..."
mkdir -p services/eventkit/.build
swiftc -O services/eventkit/ek.swift -o services/eventkit/.build/ek \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker services/eventkit/Info.plist \
  || echo "WARNING: could not build the EventKit helper; Calendar and Reminders actions will try again on first use."
# The dashboard runs as a LaunchAgent in your login session — the only place macOS lets a
# process drive Mail, Calendar, Messages and the rest, and show their permission prompts.
# See services/dashboard/local.agentspine.dashboard.plist for why.
LABEL=local.agentspine.dashboard
AGENT_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DAEMON_PLIST="/Library/LaunchDaemons/$LABEL.plist"

# One time only: retire the old LaunchDaemon. It must go before the agent loads, or the two
# fight over the port; and it must be removed, not just stopped, or it returns at boot. A
# copy is kept in ~/Library/Logs in case you ever want it back.
if [[ -f "$DAEMON_PLIST" ]]; then
  echo "Retiring the old LaunchDaemon (one-time, needs sudo)..."
  sudo launchctl bootout "system/$LABEL" 2>/dev/null || true
  cp "$DAEMON_PLIST" "$HOME/Library/Logs/$LABEL.daemon.plist.bak" 2>/dev/null || true
  sudo rm -f "$DAEMON_PLIST"
fi

echo "Restarting AgentSpine dashboard (LaunchAgent)..."
NODE_BIN=$(command -v node)
mkdir -p "$HOME/Library/LaunchAgents"
/usr/bin/sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" -e "s|__NODE__|$NODE_BIN|g" \
  "services/dashboard/$LABEL.plist" > "$AGENT_PLIST"
plutil -lint "$AGENT_PLIST" >/dev/null
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
# bootout returns before the job is gone; bootstrapping over it fails with "service already loaded".
for _ in {1..20}; do launchctl print "gui/$UID/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap "gui/$UID" "$AGENT_PLIST"

# HTTPS for the dashboard across the tailnet, so other machines get a secure context (the
# browser only allows the microphone over HTTPS or localhost). `serve`, not `funnel`: it is
# reachable from your tailnet only, never the public internet, and the dashboard token still
# applies. Tailscale persists this itself, so re-running it here is a no-op that just
# guarantees it is on. A Tailscale problem warns and never fails the update.
DASHBOARD_PORT=${DASHBOARD_PORT:-8787}
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
echo "Ensuring Tailscale HTTPS proxy..."
if [[ -x "$TS" ]] && "$TS" serve --bg --https=443 "http://127.0.0.1:${DASHBOARD_PORT}" >/dev/null 2>&1; then
  TS_HOST=$("$TS" status --self --json 2>/dev/null | /usr/bin/sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)
  echo "Dashboard on the tailnet: https://${TS_HOST:-<this machine>.ts.net}"
else
  echo "WARNING: could not configure tailscale serve (is Tailscale installed, running and logged in?). Skipping."
fi

echo "Done. Verifying service is running..."
sleep 3
launchctl print "gui/$UID/$LABEL" 2>&1 | grep -E "state =|pid =" | head -2
if curl -s -m 5 -o /dev/null "http://127.0.0.1:${DASHBOARD_PORT}/"; then
  echo "Dashboard answering on port ${DASHBOARD_PORT}."
else
  echo "WARNING: the dashboard is not answering yet. Check ~/Library/Logs/agentspine.err.log"
fi
