#!/bin/bash
# Builds build/NotchEats.app. Usage: ./build.sh [--run]
set -euo pipefail
cd "$(dirname "$0")"
APP="build/NotchEats.app"
rm -rf build
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 -target arm64-apple-macos14.0 \
  app/NotchEats.swift -o "$APP/Contents/MacOS/NotchEats"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.notch-eats</string>
  <key>CFBundleName</key><string>NotchEats</string>
  <key>CFBundleExecutable</key><string>NotchEats</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP"
echo "Built $APP"
if [[ "${1:-}" == "--run" ]]; then pkill -x NotchEats 2>/dev/null || true; open "$APP"; fi
