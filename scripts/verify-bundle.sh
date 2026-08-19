#!/bin/bash
set -u

# Verify the assembled app without requiring Bun, OMP, or any other build tool.
ROOT="${TOKEN_METER_BUNDLE_ROOT:-.omo/build/TokenMeter.app}"
APP_BINARY="$ROOT/Contents/MacOS/TokenMeter"
BRIDGE_BINARY="$ROOT/Contents/Resources/token-meter-bridge"
PLIST="$ROOT/Contents/Info.plist"
FAILURES=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

check_file() {
  local path="$1"
  local label="$2"
  if [[ ! -f "$path" ]]; then
    fail "$label is missing: $path"
  elif [[ ! -x "$path" ]]; then
    fail "$label is not executable: $path"
  else
    printf 'PASS: %s exists and is executable\n' "$label"
  fi
}

printf 'Verifying bundle: %s\n' "$ROOT"
check_file "$APP_BINARY" "TokenMeter app executable"
check_file "$BRIDGE_BINARY" "embedded token-meter-bridge"

if [[ ! -f "$PLIST" ]]; then
  fail "Info.plist is missing: $PLIST"
else
  if ! /usr/libexec/PlistBuddy -c 'Print :LSUIElement' "$PLIST" 2>/dev/null | grep -Eq '^(true|YES|1)$'; then
    fail "Info.plist must declare LSUIElement=true for menu-bar-only metadata"
  else
    printf 'PASS: Info.plist declares LSUIElement=true\n'
  fi
  if ! /usr/libexec/PlistBuddy -c 'Print :CFBundlePackageType' "$PLIST" 2>/dev/null | grep -Eq '^APPL$'; then
    fail "Info.plist must declare CFBundlePackageType=APPL"
  else
    printf 'PASS: Info.plist declares an application package\n'
  fi
fi

# Inspect actual linked dependencies. A self-contained compiled helper may
# contain implementation strings naming its compiler/runtime; those strings
# are not an external executable dependency.
for artifact in "$APP_BINARY" "$BRIDGE_BINARY"; do
  [[ -f "$artifact" ]] || continue
  if ! file "$artifact" | grep -q 'Mach-O'; then
    fail "shipped executable is not Mach-O: $artifact"
    continue
  fi
  if otool -L "$artifact" | tail -n +2 | grep -Eiq '(^|[/[:space:]])(bun|omp)([/[:space:]]|$)|node_modules/(bun|omp)|/opt/homebrew/(bin|lib)/(bun|omp)|/usr/local/(bin|lib)/(bun|omp)'; then
    fail "external OMP/Bun runtime linkage found in $artifact"
  fi
done
printf 'PASS: shipped executables have no external OMP/Bun runtime linkage\n'

if [[ -f "$APP_BINARY" ]] && strings "$APP_BINARY" | grep -Fq 'TOKEN_METER_QA_'; then
  fail "release app contains QA environment controls"
else
  printf 'PASS: release app contains no QA environment controls\n'
fi

# The packaged provider registry resource (provider-capabilities.json) must
# ship inside the Swift resource bundle, carry the locked registry version,
# and agree with the bundled bridge's own `providers --format json` listing
# on every provider id and auth-method surface.
REGISTRY_VERSION_EXPECTED="1.2.0"
REGISTRY_BUNDLE="$ROOT/Contents/Resources/token-meter_TokenMeterCore.bundle"
REGISTRY_RESOURCE=""
if [[ -d "$REGISTRY_BUNDLE" ]]; then
  REGISTRY_RESOURCE="$(find "$REGISTRY_BUNDLE" -name provider-capabilities.json -type f 2>/dev/null | head -n 1)"
fi
if [[ -z "$REGISTRY_RESOURCE" ]]; then
  fail "packaged provider registry resource (provider-capabilities.json) is missing from the bundle"
elif [[ ! -x "$BRIDGE_BINARY" ]]; then
  fail "cannot cross-check the registry resource: bundled bridge helper is unavailable"
else
  VERIFY_TMP="$(mktemp -d)"
  if python3 - "$BRIDGE_BINARY" "$REGISTRY_RESOURCE" "$REGISTRY_VERSION_EXPECTED" <<'PY'
import json, subprocess, sys
bridge_binary, resource_path, expected_version = sys.argv[1], sys.argv[2], sys.argv[3]
run = subprocess.run([bridge_binary, "providers", "--format", "json"], capture_output=True, text=True, check=False)
assert run.returncode == 0, run.stderr
listing = json.loads(run.stdout)
registry = json.load(open(resource_path))
assert listing["schemaVersion"] == expected_version, listing["schemaVersion"]
assert registry["schemaVersion"] == expected_version, registry["schemaVersion"]
ids = [p["id"] for p in listing["providers"]]
assert len(ids) == 16 and len(set(ids)) == 16, ids
listing_methods = {p["id"]: p["authMethods"] for p in listing["providers"]}
registry_methods = {p["id"]: p["authMethods"] for p in registry["providers"]}
assert listing_methods == registry_methods, (listing_methods, registry_methods)
PY
  then
    printf 'PASS: packaged provider-capabilities.json ships registry %s and agrees with the bridge listing\n' "$REGISTRY_VERSION_EXPECTED"
  else
    fail "packaged registry resource and bridge listing disagree (expected registry version $REGISTRY_VERSION_EXPECTED)"
  fi
  rm -rf "$VERIFY_TMP"
fi

# Evidence and process/log artifacts must never contain the known QA secret.
QA_SECRET="${TOKEN_METER_QA_SECRET:-token-meter-secret-sentinel-8e64f205}"
if [[ -n "$QA_SECRET" ]]; then
  while IFS= read -r -d '' artifact; do
    if grep -FIlq -- "$QA_SECRET" "$artifact" 2>/dev/null; then
      fail "QA secret found in evidence/process artifact: $artifact"
    fi
  done < <(find .omo/evidence -type f -print0 2>/dev/null)
fi
printf 'PASS: no known QA secret found in evidence/process artifacts\n'

if (( FAILURES > 0 )); then
  printf 'Bundle verification failed with %d issue(s).\n' "$FAILURES" >&2
  exit 1
fi
printf 'Bundle verification passed.\n'
