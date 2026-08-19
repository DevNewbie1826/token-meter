#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/.omo/build/TokenMeterQACapture.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
AX_DRIVER="$ROOT/.omo/build/TokenMeterAXDriver"

rm -rf "$APP"
mkdir -p "$MACOS"

xcrun swiftc \
  -warnings-as-errors \
  -parse-as-library \
  "$ROOT/scripts/qa/TokenMeterQACapture.swift" \
  -framework CoreGraphics \
  -framework Foundation \
  -framework ImageIO \
  -framework ScreenCaptureKit \
  -framework UniformTypeIdentifiers \
  -o "$MACOS/TokenMeterQACapture"

cp "$ROOT/scripts/qa/TokenMeterQACapture-Info.plist" "$CONTENTS/Info.plist"
codesign --force --sign - "$APP"
xcrun swiftc \
  -warnings-as-errors \
  -parse-as-library \
  "$ROOT/scripts/qa/TokenMeterAXDriver.swift" \
  -framework AppKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework Foundation \
  -o "$AX_DRIVER"
echo "$APP"
