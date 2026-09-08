#!/bin/bash
# Assemble the ad-hoc signed TokenMeter.app menu-bar bundle.
#
# Produces .omo/build/TokenMeter.app with:
#   Contents/MacOS/TokenMeter            - swift build -c release executable
#   Contents/Resources/token-meter-bridge - bun --compile helper
#   Contents/Info.plist                   - Packaging/Info.plist (menu-bar-only)
#
# The bundle contract is scripts/verify-bundle.sh. The compiled helper is
# copied byte-for-byte and signed; build assembly never patches its contents.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_DIR="$ROOT/.omo/build/TokenMeter.app"
APP_BIN="$APP_DIR/Contents/MacOS/TokenMeter"
BRIDGE_BIN="$APP_DIR/Contents/Resources/token-meter-bridge"
REGISTRY_BUNDLE=".build/release/token-meter_TokenMeterCore.bundle"
QA_APP_DIR="$ROOT/.omo/build/TokenMeterQA.app"
QA_APP_BIN="$QA_APP_DIR/Contents/MacOS/TokenMeter"
QA_BUILD_PATH="$ROOT/.omo/qa-swift-build"
QA_REGISTRY_BUNDLE="$QA_BUILD_PATH/release/token-meter_TokenMeterCore.bundle"
BUNDLE_ID="dev.token-meter.TokenMeter"
TMP="$ROOT/.omo/build/build-all.tmp"

log() { printf '[build-all] %s\n' "$*"; }
die() { printf '[build-all] FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT
rm -rf "$TMP"
mkdir -p "$TMP"

# ---------------------------------------------------------------- bridge ---
log "building bridge helper (bun --compile)"
rm -f bridge/build/token-meter-bridge
(cd bridge && bun run build) >/dev/null
[[ -x bridge/build/token-meter-bridge ]] || die "bridge helper did not build"

# ----------------------------------------------------------------- swift ---
log "building Swift release executable"
swift build -c release >/dev/null
[[ -x .build/release/TokenMeterApp ]] || die "Swift release binary did not build"
[[ -d "$REGISTRY_BUNDLE" ]] || die "Swift registry resource bundle did not build: $REGISTRY_BUNDLE"
[[ -f "$REGISTRY_BUNDLE/provider-capabilities.json" ]] || die "registry resource provider-capabilities.json missing from $REGISTRY_BUNDLE"

log "building compile-time-isolated Swift QA executable"
rm -rf "$QA_BUILD_PATH"
swift build --build-path "$QA_BUILD_PATH" -c release -Xswiftc -DTOKEN_METER_QA >/dev/null
[[ -x "$QA_BUILD_PATH/release/TokenMeterApp" ]] || die "Swift QA binary did not build"
[[ -f "$QA_REGISTRY_BUNDLE/provider-capabilities.json" ]] || die "QA registry resource missing"

# ------------------------------------------------------------- assemble ----
log "assembling $APP_DIR"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp .build/release/TokenMeterApp "$APP_BIN"
cp bridge/build/token-meter-bridge "$BRIDGE_BIN"
# The packaged capability registry rides inside the Swift resource bundle;
# TokenMeterCore resolves it at runtime through Bundle.module.
cp -R "$REGISTRY_BUNDLE" "$APP_DIR/Contents/Resources/"
cp Packaging/Info.plist "$APP_DIR/Contents/Info.plist"

log "assembling compile-time-isolated $QA_APP_DIR"
rm -rf "$QA_APP_DIR"
mkdir -p "$QA_APP_DIR/Contents/MacOS" "$QA_APP_DIR/Contents/Resources"
cp "$QA_BUILD_PATH/release/TokenMeterApp" "$QA_APP_BIN"
cp bridge/build/token-meter-bridge "$QA_APP_DIR/Contents/Resources/token-meter-bridge"
cp -R "$QA_REGISTRY_BUNDLE" "$QA_APP_DIR/Contents/Resources/"
cp Packaging/Info.plist "$QA_APP_DIR/Contents/Info.plist"

# ----------------------------------------------------------------- sign ----
log "ad-hoc signing bundle"
codesign --force --sign - --identifier "$BUNDLE_ID.bridge" "$BRIDGE_BIN" >/dev/null 2>&1
codesign --force --sign - --identifier "$BUNDLE_ID.bin" "$APP_BIN" >/dev/null 2>&1
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP_DIR" >/dev/null 2>&1
codesign --verify --strict "$APP_DIR" || die "bundle code signature invalid"
codesign --force --sign - --identifier "$BUNDLE_ID.qa.bridge" "$QA_APP_DIR/Contents/Resources/token-meter-bridge" >/dev/null 2>&1
codesign --force --sign - --identifier "$BUNDLE_ID.qa.bin" "$QA_APP_BIN" >/dev/null 2>&1
codesign --force --sign - --identifier "$BUNDLE_ID.qa" "$QA_APP_DIR" >/dev/null 2>&1
codesign --verify --strict "$QA_APP_DIR" || die "QA bundle code signature invalid"

# ----------------------------------------------------------- smoke test ----
# Exercise the exact helper shipped in the bundle.
log "smoke testing bundled helper"
"$BRIDGE_BIN" providers --format json > "$TMP/providers.json"

REQ='{"schemaVersion":"1.3.0","requestId":"00000000-0000-4000-8000-000000000001","operation":"fetchUsage","providerId":"fixture","connectorId":"fixture","accountRef":"00000000-0000-4000-8000-000000000002","requestedAtMs":1787011200000,"deadlineAtMs":1787011210000,"credential":{"kind":"bearer","secret":"demo"}}'
printf '%s' "$REQ" | "$BRIDGE_BIN" usage --stdin --fixture bridge/fixtures/quota.json > "$TMP/usage.json"

python3 - "$TMP/providers.json" "$TMP/usage.json" "$APP_DIR" <<'PY' || die "helper smoke contract failed"
import glob, json, os, sys
providers = json.load(open(sys.argv[1]))
ids = [p['id'] for p in providers['providers']]
assert providers['schemaVersion'] == '1.2.0', providers['schemaVersion']
assert len(ids) == 17 and len(set(ids)) == 17, ids
usage = json.load(open(sys.argv[2]))
assert usage['schemaVersion'] == '1.3.0', usage['schemaVersion']
assert usage['requestId'] == '00000000-0000-4000-8000-000000000001'
assert usage['status'] == 'ok', usage.get('status')
# registry resource smoke contract: the packaged Swift resource ships inside
# the app bundle, carries the same registry version as the bridge listing,
# and agrees with it on every provider's auth methods.
resources = glob.glob(os.path.join(sys.argv[3], 'Contents/Resources/**/provider-capabilities.json'), recursive=True)
assert len(resources) == 1, resources
registry = json.load(open(resources[0]))
assert registry['schemaVersion'] == providers['schemaVersion'], registry['schemaVersion']
listing_methods = {p['id']: p['authMethods'] for p in providers['providers']}
registry_methods = {p['id']: p['authMethods'] for p in registry['providers']}
assert listing_methods == registry_methods, (listing_methods, registry_methods)
PY

log "assembled and signed:"
find "$APP_DIR" -type f -exec ls -l {} + | awk '{print "[build-all]   " $5 " " $NF}'

log "PASS: bundle assembled at $APP_DIR"
log "PASS: compile-time-isolated QA bundle assembled at $QA_APP_DIR"
