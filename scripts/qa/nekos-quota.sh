#!/bin/bash
# Usage: bash scripts/qa/nekos-quota.sh /absolute/evidence-directory
# Fixture-only authentication; no live key is read, requested, or transmitted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE="${1:?usage: bash scripts/qa/nekos-quota.sh /absolute/evidence-directory}"
mkdir -p "$EVIDENCE"
EVIDENCE="$(cd "$EVIDENCE" && pwd)"
SOURCE_APP="$ROOT/.omo/build/TokenMeterQA.app"
APP="$SOURCE_APP/Contents/MacOS/TokenMeter"
DRIVER="$ROOT/.omo/build/TokenMeterAXDriver"
[[ -x "$APP" && -x "$DRIVER" ]] || { echo "Build app and capture helpers first" >&2; exit 2; }
TRANSPORT_ROOT="$(mktemp -d "$ROOT/.omo/build/nekos-qa.XXXXXX")"
trap 'rm -rf "$TRANSPORT_ROOT"' EXIT
cp -R "$SOURCE_APP" "$TRANSPORT_ROOT/TokenMeterQA.app"
APP="$TRANSPORT_ROOT/TokenMeterQA.app/Contents/MacOS/TokenMeter"
TRANSPORT="$TRANSPORT_ROOT/TokenMeterQA.app/Contents/Resources/nekos-fixture-bridge"
cd "$ROOT"
bun scripts/qa/nekos-adapter.ts "$EVIDENCE"
bun build --compile scripts/qa/nekos-adapter.ts --outfile "$TRANSPORT" > "$EVIDENCE/nekos-qa-transport-build.log" 2>&1
codesign --force --sign - "$TRANSPORT" >> "$EVIDENCE/nekos-qa-transport-build.log" 2>&1
codesign --force --sign - "$TRANSPORT_ROOT/TokenMeterQA.app" >> "$EVIDENCE/nekos-qa-transport-build.log" 2>&1
set +e
TOKEN_METER_QA_NEKOS_BRIDGE="$TRANSPORT" "$DRIVER" nekos-quota "$APP" "$EVIDENCE/nekos-quota.png" \
    > "$EVIDENCE/nekos-quota-ax.log" 2>&1
result=$?
set -e
if [[ "$result" == 0 ]] && ! grep -x "NEKOS_QA_COMPLETE" "$EVIDENCE/nekos-quota-ax.log" > /dev/null; then
    printf "FAIL: driver exited without its completion token\n" >> "$EVIDENCE/nekos-quota-ax.log"
    result=2
fi
printf "RC=%s\n" "$result" | tee -a "$EVIDENCE/nekos-quota-ax.log"
exit "$result"
