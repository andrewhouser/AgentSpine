#!/bin/zsh
# Build the AgentSpine Mac app and put it in /Applications, replacing the old copy.
#
#   ./install-mac.sh              build, quit the running app, replace it, open the new one
#   ./install-mac.sh --no-open    same, but leave it closed
#
# INSTALL_DIR=~/Applications ./install-mac.sh   install somewhere other than /Applications
#
# Run it on the Mac you work at. It builds the Release configuration with your normal Xcode
# signing (team and bundle id come from ios/AgentSpine.xcodeproj and ios/Supporting/Local.xcconfig),
# so macOS keeps the permissions you already granted: they are tied to the team, not the file.
#
# The old app is only removed after the new one has built and been copied beside it, so a failed
# build leaves what you have installed untouched.
set -euo pipefail

cd "${0:A:h}"

APP_NAME="AgentSpine Mac"
INSTALL_DIR="${INSTALL_DIR:-/Applications}"
DERIVED="ios/build/mac"
BUILT="$DERIVED/Build/Products/Release/$APP_NAME.app"
TARGET="$INSTALL_DIR/$APP_NAME.app"
STAGING="$INSTALL_DIR/.$APP_NAME.new.app"

OPEN_AFTER=1
for arg in "$@"; do
  case "$arg" in
    --no-open) OPEN_AFTER=0 ;;
    -h|--help) /usr/bin/sed -n '2,10p' "$0" | /usr/bin/sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

echo "Building $APP_NAME (Release)..."
# -quiet prints only warnings and errors, so a failure is not buried in a thousand lines.
xcodebuild -project ios/AgentSpine.xcodeproj \
  -scheme "$APP_NAME" \
  -configuration Release \
  -destination "platform=macOS,arch=$(uname -m)" \
  -derivedDataPath "$DERIVED" \
  -quiet \
  build

if [[ ! -d "$BUILT" ]]; then
  echo "Build finished but $BUILT is missing." >&2
  exit 1
fi

# /Applications is writable by an admin user, so this normally needs no password. If it
# is not, fall back to sudo rather than failing after a ten-minute build.
SUDO=()
# Created first, so a folder that does not exist yet is not mistaken for one we cannot write to.
mkdir -p "$INSTALL_DIR" 2>/dev/null || true
if [[ ! -w "$INSTALL_DIR" ]]; then
  echo "$INSTALL_DIR is not writable by you; using sudo."
  SUDO=(sudo)
  "${SUDO[@]}" mkdir -p "$INSTALL_DIR"
fi

echo "Copying the new build next to the old one..."
"${SUDO[@]}" rm -rf "$STAGING"
# ditto keeps the code signature, extended attributes and symlinks intact; cp -R does not.
"${SUDO[@]}" ditto "$BUILT" "$STAGING"

# A running app would be left running from a bundle that is about to be deleted. Ask it to quit
# first, give it a few seconds to save, and only then force it.
if [[ -d "$TARGET" ]] && /usr/bin/pgrep -x "$APP_NAME" >/dev/null; then
  echo "Quitting the running $APP_NAME..."
  /usr/bin/osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  for _ in {1..10}; do
    /usr/bin/pgrep -x "$APP_NAME" >/dev/null || break
    sleep 0.5
  done
  /usr/bin/pkill -x "$APP_NAME" 2>/dev/null || true
fi

echo "Replacing $TARGET..."
"${SUDO[@]}" rm -rf "$TARGET"
"${SUDO[@]}" mv "$STAGING" "$TARGET"

echo "Installed: $TARGET"
if [[ "$OPEN_AFTER" == 1 ]]; then
  /usr/bin/open "$TARGET"
fi
