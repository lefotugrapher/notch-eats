#!/bin/bash
# Installs Notch Eats to ~/Applications and starts it at every login. Re-run after rebuilding.
# Remove with: ./install.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")"
LABEL="local.notch-eats"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DEST="$HOME/Applications/NotchEats.app"
UID_=$(id -u)

launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
pkill -x NotchEats 2>/dev/null || true

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$PLIST"; rm -rf "$DEST"; echo "Uninstalled."; exit 0
fi

./build.sh
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
rm -rf "$DEST"; cp -R build/NotchEats.app "$DEST"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DEST/Contents/MacOS/NotchEats</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST

launchctl bootstrap "gui/$UID_" "$PLIST"
echo "Installed. Starts at login; menu-bar icon > Quit stops it until next login."
