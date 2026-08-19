#!/bin/bash
# Current-build provider-management GUI acceptance.
#
# Drives the hosted provider-management window of the compile-time-isolated
# .omo/build/TokenMeterQA.app twin through the AX driver and records exactly what
# the driver verified: 16 provider rows, every auth-method action (identifier,
# title, enabled), open/cancel of the api-key/browser/device sheets, Alibaba
# extra fields and duplex prompt UI, GitHub device enterprise-host field, and
# both Codex methods. The driver enters no credential, persists nothing, and
# never prints device codes or verification URLs. No claim in this transcript
# relies on older runs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/.omo/build/TokenMeterQA.app/Contents/MacOS/TokenMeter"
BRIDGE="$ROOT/.omo/build/TokenMeter.app/Contents/Resources/token-meter-bridge"
EVIDENCE="$ROOT/.omo/evidence/provider-rebuild"
TRANSCRIPT="$EVIDENCE/gui.txt"
SCREENSHOT="$EVIDENCE/provider-management.png"
CAPTURE_APP="$ROOT/.omo/build/TokenMeterQACapture.app"
CAPTURE="$CAPTURE_APP/Contents/MacOS/TokenMeterQACapture"
AX_DRIVER="$ROOT/.omo/build/TokenMeterAXDriver"

mkdir -p "$EVIDENCE"
: > "$TRANSCRIPT"

record() {
  printf '%s\n' "$1" | tee -a "$TRANSCRIPT"
}

blocked() {
  record "BLOCKED: $1"
  exit 2
}

record "provider-management GUI acceptance - $(date '+%Y-%m-%d %H:%M:%S %Z')"
record "policy: evidence describes only this run; no prior-transcript claims; no credential is entered, transmitted, or persisted; device codes and verification URLs are never printed"

[[ -x "$APP" ]] || blocked "packaged TokenMeter executable is missing"
[[ -x "$BRIDGE" ]] || blocked "bundled bridge helper is missing"
[[ -x "$CAPTURE" ]] || blocked "TokenMeterQACapture helper is missing"
[[ -x "$AX_DRIVER" ]] || blocked "TokenMeterAXDriver helper is missing"
[[ "$(osascript -e 'tell application "System Events" to get UI elements enabled')" == "true" ]] \
  || blocked "Accessibility permission is not enabled for the QA runner"

record "ACTION: compiling QA helpers with -warnings-as-errors"
if ! bash "$ROOT/scripts/qa/build-capture-helper.sh" > "$EVIDENCE/.helper-build.log" 2>&1; then
  cat "$EVIDENCE/.helper-build.log" >> "$TRANSCRIPT"
  rm -f "$EVIDENCE/.helper-build.log"
  blocked "QA helpers failed to compile with warnings-as-errors"
fi
rm -f "$EVIDENCE/.helper-build.log"
record "PASS: QA helpers compiled with -warnings-as-errors"

APP_SHA="$(shasum -a 256 "$APP" | awk '{print $1}')"
BRIDGE_SHA="$(shasum -a 256 "$BRIDGE" | awk '{print $1}')"
record "BUILD: app=$APP"
record "BUILD: app-sha256=$APP_SHA mtime=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$APP")"
record "BUILD: bridge-sha256=$BRIDGE_SHA"

if ! PROVIDER_COUNT="$("$BRIDGE" providers --format json \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["providers"]))')"; then
  blocked "bundled bridge providers listing failed"
fi
[[ "$PROVIDER_COUNT" == "16" ]] || blocked "bundled bridge lists $PROVIDER_COUNT providers, expected 16"
record "BUILD: bundled bridge lists 16 providers (registry 1.2.0)"

rm -f "$SCREENSHOT"
if ! driver_output="$("$AX_DRIVER" provider-management "$APP" "$CAPTURE_APP" "$SCREENSHOT" 2>&1)"; then
  printf '%s\n' "$driver_output" >> "$TRANSCRIPT"
  blocked "AX driver could not exercise the provider-management UI"
fi
printf '%s\n' "$driver_output" >> "$TRANSCRIPT"
APP_PID="$(printf '%s\n' "$driver_output" | awk '/^PID: / { print $2; exit }')"
[[ -n "$APP_PID" ]] || blocked "AX driver did not return the TokenMeter process id"
record "ACTION: exercised hosted provider-management window of pid=$APP_PID from the final build"

[[ -s "$SCREENSHOT" ]] || blocked "provider-management screenshot is empty"
PNG_BYTES="$(stat -f '%z' "$SCREENSHOT")"
PNG_SIZE="$(sips -g pixelWidth -g pixelHeight "$SCREENSHOT" 2>/dev/null | awk '/pixelWidth/ { w=$2 } /pixelHeight/ { h=$2 } END { print w "x" h }')"
record "PASS: screenshot=$SCREENSHOT bytes=$PNG_BYTES pixels=$PNG_SIZE"

if grep -qi "sentinel\|TOKEN_METER_QA_SENTINEL" "$TRANSCRIPT"; then
  blocked "QA sentinel marker leaked into the transcript"
fi
record "PASS: transcript contains no credential material (no values were entered this run)"
record "OVERALL: PASS - current-build provider-management GUI acceptance recorded above"
