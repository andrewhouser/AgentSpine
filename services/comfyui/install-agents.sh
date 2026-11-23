#!/bin/zsh
# Installs the image services as LaunchAgents so they survive a reboot: ComfyUI ("best") on
# :8188 and MFLUX ("draft") on :8082, both loopback only. Paths come from this machine's $HOME,
# because the checked-in MFLUX plist names /Users/... and this Mini's home is on WorkDrive.
# Safe to re-run. COMFYUI_DIR overrides where ComfyUI lives.
set -eu
repo="${0:A:h:h:h}"
comfy="${COMFYUI_DIR:-$HOME/Developer/ComfyUI}"
agents="$HOME/Library/LaunchAgents"
domain="gui/$(id -u)"
[[ -x "$comfy/.venv/bin/python" ]] || { echo "no ComfyUI venv at $comfy/.venv" >&2; exit 1; }
[[ -x "$HOME/.venvs/mflux/bin/uvicorn" ]] || { echo "no MFLUX venv at $HOME/.venvs/mflux" >&2; exit 1; }
mkdir -p "$agents" "$HOME/Library/Logs"

sed -e "s#/Users/andrewhouser/Developer/AgentSpine#$repo#g" -e "s#/Users/andrewhouser#$HOME#g" \
  "$repo/services/mflux/com.local.mflux.plist" > "$agents/com.local.mflux.plist"

# --disable-auto-launch: without it every start opens a browser tab on a headless box.
cat > "$agents/com.local.comfyui.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.comfyui</string>
  <key>ProgramArguments</key><array>
    <string>$comfy/.venv/bin/python</string><string>main.py</string>
    <string>--listen</string><string>127.0.0.1</string>
    <string>--port</string><string>8188</string>
    <string>--disable-auto-launch</string>
  </array>
  <key>WorkingDirectory</key><string>$comfy</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/comfyui.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/comfyui.log</string>
</dict></plist>
PLIST

for label in com.local.mflux com.local.comfyui; do
  plutil -lint "$agents/$label.plist" >/dev/null
  launchctl bootout "$domain/$label" 2>/dev/null || true
  launchctl bootstrap "$domain" "$agents/$label.plist"
done
echo "installed com.local.mflux and com.local.comfyui"
