#!/bin/bash
# Offline actual-provider desktop acceptance; no live provider calls.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
EVIDENCE="$ROOT/.omo/evidence/omp-upgrade/catalog-qa/r1"
APP="$ROOT/.omo/build/TokenMeterQA.app/Contents/MacOS/TokenMeter"
BRIDGE="$ROOT/.omo/build/TokenMeterQA.app/Contents/Resources/token-meter-qa-bridge"
DRIVER="$ROOT/.omo/build/TokenMeterAXDriver"
mkdir -p "$EVIDENCE"
LOG="$EVIDENCE/provider-parity-gui.log"
exec > >(tee "$LOG") 2>&1
for executable in "$APP" "$BRIDGE" "$DRIVER"; do
  [[ -x "$executable" ]] || { echo "BLOCKED: missing $executable"; exit 2; }
done
if ! "$DRIVER" accessibility-check; then
  echo "BLOCKED: enable Accessibility for this exact TokenMeterAXDriver in System Settings; no TCC/profile changes performed"
  exit 2
fi
echo 'POLICY: offline fixture HTTP, actual auth/adapter/BridgeClient/store; not live upstream'
git rev-parse HEAD
git diff --stat
shasum -a 256 "$APP" "$BRIDGE" "$DRIVER"
for scenario in management empty xai-80 xai-87.5 xai-89.9 xai-95 xai-99.9 xai-overage zai-mixed ag-remaining ag-weekly cursor-used opencode-12 nekos; do
  printf 'COMMAND: %q provider-parity %q %q %q\n' "$DRIVER" "$APP" "$scenario" "$EVIDENCE/$scenario.png"
  "$DRIVER" provider-parity "$APP" "$scenario" "$EVIDENCE/$scenario.png"
done
echo 'PASS: all offline native scenarios and paired cleanup completed; captures require independent visual review'
