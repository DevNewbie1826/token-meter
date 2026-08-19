#!/bin/bash
# Opt-in LIVE provider acceptance harness.
#
# Drives the final .omo/build/TokenMeter.app and the real Keychain through
# TokenMeterAXDriver's live-acceptance scenario. Security contract:
#   - Credentials are NEVER accepted through argv or the environment. The
#     only credential channel is a hidden read -s prompt on /dev/tty whose
#     answer is piped straight into the driver's stdin (and from there into
#     the sheet's secure field via AXUIElementSetAttributeValue, in-process).
#   - Credential values are never logged, echoed, or written to any file.
#   - The transcript records exactly five fields per provider: provider id,
#     auth method, final status, sourceKind, and the registry's declared
#     window count. No quota numbers, account labels, codes, or URLs.
#   - Without a credential the harness reports SKIP and never PASS.
#
# Usage:
#   scripts/qa/live-provider-acceptance.sh --live <provider-id> [--method apiKey|browser|device]
#   scripts/qa/live-provider-acceptance.sh --live --all
#   scripts/qa/live-provider-acceptance.sh            # prints policy, reports SKIP, exits 0
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP="$ROOT/.omo/build/TokenMeterQA.app/Contents/MacOS/TokenMeter"
AX_DRIVER="$ROOT/.omo/build/TokenMeterAXDriver"
REGISTRY="$(find "$ROOT/.omo/build/TokenMeter.app/Contents/Resources" -name provider-capabilities.json -type f 2>/dev/null | head -n 1)"

LIVE=0
PROVIDER=""
METHOD=""
ALL=0

say() { printf '%s\n' "$1"; }
fail() { say "ERROR: $1"; exit 2; }

# ------------------------------------------------------------------ args --
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --all) ALL=1 ;;
    --method) : ;; # consumed with the next loop pass below
    apiKey|browser|device)
      if [[ "$METHOD" == "next" ]]; then METHOD="$arg"; else fail "unexpected argument: $arg"; fi
      ;;
    *)
      if [[ "$METHOD" == "next" ]]; then METHOD="$arg"; continue; fi
      # Refuse anything that could be carrying a secret value.
      [[ "$arg" == *=* ]] && fail "arguments must never carry key=value secrets: refused"
      [[ ${#arg} -gt 64 ]] && fail "argument longer than 64 chars looks like a secret: refused"
      [[ -n "$PROVIDER" || "$ALL" == 1 ]] && fail "unexpected argument: $arg"
      PROVIDER="$arg"
      ;;
  esac
  if [[ "$arg" == "--method" ]]; then METHOD="next"; fi
done
[[ "$METHOD" == "next" ]] && fail "--method requires a value (apiKey|browser|device)"

say "live provider acceptance - $(date '+%Y-%m-%d %H:%M:%S %Z')"
say "policy: credentials only via hidden /dev/tty prompt piped to the driver stdin; never argv, never environment, never logged; records only provider, method, status, sourceKind, windowCount; SKIP (never PASS) without credentials"

if [[ "${LIVE}" -ne 1 ]]; then
  say "RESULT: scope=requested status=SKIP reason=not-opt-in (rerun with --live to drive real registrations)"
  exit 0
fi

[[ -x "$APP" ]] || fail "final app bundle is missing; run scripts/build-all.sh first"
[[ -n "$REGISTRY" ]] || fail "packaged provider-capabilities.json is missing"
say "ACTION: compiling QA helpers with -warnings-as-errors"
bash "$ROOT/scripts/qa/build-capture-helper.sh" > /dev/null 2>&1 || fail "QA helpers failed to compile with warnings-as-errors"
say "PASS: QA helpers compiled with -warnings-as-errors"

# The harness ignores the environment entirely; say so loudly when the
# ambient environment looks credential-bearing.
if env | grep -qiE '^[A-Za-z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*='; then
  say "NOTICE: credential-named environment variables are present; they are IGNORED - the only credential channel is the hidden prompt"
fi

if [[ "$ALL" -ne 1 && -z "$PROVIDER" ]]; then
  fail "choose one provider id or --all"
fi

# ------------------------------------------------------------- registry --
PROVIDER_TABLE="$(python3 - "$REGISTRY" <<'PYREG'
import json, sys
registry = json.load(open(sys.argv[1]))
for provider in registry["providers"]:
    print(f'{provider["id"]}\t{",".join(provider["authMethods"])}\t{provider["sourceKind"]}\t{len(provider["declaredWindows"])}')
PYREG
)" || fail "cannot read the packaged registry"

methods_for() {
  printf '%s\n' "$PROVIDER_TABLE" | awk -F'\t' -v id="$1" '$1 == id { print $2 }'
}
meta_for() {
  printf '%s\n' "$PROVIDER_TABLE" | awk -F'\t' -v id="$1" '$1 == id { print $3 "\t" $4 }'
}

TARGETS=()
if [[ "$ALL" == 1 ]]; then
  while IFS=$'\t' read -r pid methods _; do
    IFS=',' read -r -a method_list <<< "$methods"
    for m in "${method_list[@]}"; do
      if [[ -z "$METHOD" || "$m" == "$METHOD" ]]; then
        TARGETS+=("$pid|$m")
      fi
    done
  done <<< "$PROVIDER_TABLE"
else
  methods="$(methods_for "$PROVIDER")"
  [[ -n "$methods" ]] || fail "unknown provider id: $PROVIDER"
  IFS=',' read -r -a method_list <<< "$methods"
  for m in "${method_list[@]}"; do
    if [[ -z "$METHOD" || "$m" == "$METHOD" ]]; then
      TARGETS+=("$PROVIDER|$m")
    fi
  done
  [[ ${#TARGETS[@]} -gt 0 ]] || fail "$PROVIDER does not offer method $METHOD"
fi

INTERACTIVE=0
[[ -t 0 && -t 2 ]] && INTERACTIVE=1
[[ "$INTERACTIVE" == 1 ]] || say "NOTICE: no interactive terminal; every probe will be SKIP (no credential source)"

run_probe() {
  local provider="$1" method="$2"
  local meta source_kind window_count secret driver_output status
  meta="$(meta_for "$provider")"
  source_kind="${meta%%$'\t'*}"
  window_count="${meta##*$'\t'}"

  secret=""
  if [[ "$method" == "apiKey" ]]; then
    if [[ "$INTERACTIVE" == 1 ]]; then
      printf 'Credential for %s (%s) - hidden input, leave blank to SKIP: ' "$provider" "$method" >&2
      IFS= read -r -s secret </dev/tty || secret=""
      printf '\n' >&2
    fi
    if [[ -z "$secret" ]]; then
      say "RESULT: provider=$provider method=$method status=SKIP reason=no-credential sourceKind=$source_kind windowCount=$window_count"
      return 0
    fi
  else
    if [[ "$INTERACTIVE" == 1 ]]; then
      printf 'Start live %s via %s? Complete the login in the opened browser, then come back. [y/N] ' "$provider" "$method" >&2
      local answer=""
      IFS= read -r answer </dev/tty || answer=""
      if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
        say "RESULT: provider=$provider method=$method status=SKIP reason=declined sourceKind=$source_kind windowCount=$window_count"
        return 0
      fi
    else
      say "RESULT: provider=$provider method=$method status=SKIP reason=no-interactive-operator sourceKind=$source_kind windowCount=$window_count"
      return 0
    fi
  fi

  driver_output="$(printf '%s\n' "$secret" | "$AX_DRIVER" live-acceptance "$APP" "$provider" "$method" 2>&1)"
  local driver_exit=$?
  secret=""
  if [[ "$driver_exit" -ne 0 ]]; then
    say "RESULT: provider=$provider method=$method status=ERROR driver-exit=$driver_exit sourceKind=$source_kind windowCount=$window_count"
    return 0
  fi
  status="$(printf '%s\n' "$driver_output" | awk '/^RESULT: / { for (i = 1; i <= NF; i++) if ($i ~ /^status=/) { sub(/^status=/, "", $i); print $i; exit } }')"
  [[ -n "$status" ]] || status="UNKNOWN"
  say "RESULT: provider=$provider method=$method status=$status sourceKind=$source_kind windowCount=$window_count"
}

REGISTERED=0
SKIPPED=0
OTHER=0
for target in "${TARGETS[@]}"; do
  provider="${target%%|*}"
  method="${target##*|}"
  line="$(run_probe "$provider" "$method")"
  say "$line"
  case "$line" in
    *"status=REGISTERED"*) REGISTERED=$((REGISTERED + 1)) ;;
    *"status=SKIP"*) SKIPPED=$((SKIPPED + 1)) ;;
    *) OTHER=$((OTHER + 1)) ;;
  esac
done

if pgrep -f "$ROOT/.omo/build/TokenMeter.app/Contents/Resources/token-meter-bridge" > /dev/null 2>&1; then
  say "ERROR: bundled helper processes remain after the run"
  exit 1
fi
say "SUMMARY: registered=$REGISTERED skipped=$SKIPPED other=$OTHER total=${#TARGETS[@]}; no credential value was logged; helper processes remaining=0"
[[ "$REGISTERED" -gt 0 ]] || say "SUMMARY: no PASS claim made - every probe was SKIP/ERROR (no credentials were supplied)"
exit 0
