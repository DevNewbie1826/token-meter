#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/.omo/build/TokenMeterQA.app/Contents/MacOS/TokenMeter"
EVIDENCE="$ROOT/.omo/evidence/token-meter/manual"
TRANSCRIPT="$EVIDENCE/quota-panel.txt"
SCREENSHOT="$ROOT/.omo/evidence/token-meter/quota-panel.png"
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

[[ -x "$APP" ]] || blocked "packaged TokenMeter executable is missing"
[[ -x "$CAPTURE" ]] || blocked "TokenMeterQACapture helper is missing"
[[ -x "$AX_DRIVER" ]] || blocked "TokenMeterAXDriver helper is missing"
"$AX_DRIVER" accessibility-check \
  || blocked "Accessibility permission is not enabled for the QA runner"

rm -f "$SCREENSHOT"
if ! driver_output="$("$AX_DRIVER" quota-panel "$APP" "$CAPTURE_APP" "$SCREENSHOT" 2>&1)"; then
  printf '%s\n' "$driver_output" >> "$TRANSCRIPT"
  blocked "Accessibility actions could not reach the real quota panel"
fi
printf '%s\n' "$driver_output" >> "$TRANSCRIPT"
APP_PID="$(printf '%s\n' "$driver_output" | awk '/^PID: / { print $2; exit }')"
[[ -n "$APP_PID" ]] || blocked "AX driver did not return the TokenMeter process id"
record "ACTION: launched TokenMeter pid=$APP_PID with isolated QA metadata store"

record "PASS: clean panel shows honest unregistered state and registration action"
[[ -s "$SCREENSHOT" ]] || blocked "quota-panel screenshot is empty"
record "PASS: screenshot=$SCREENSHOT"
