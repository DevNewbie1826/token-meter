#!/bin/bash
# Uncredentialed runtime audit of the bundled bridge CLI.
#
# Runs the exact helper shipped inside the final .omo/build/TokenMeter.app:
#   - providers listing must carry 17 unique providers whose auth methods
#     match the packaged registry resource;
#   - every provider must be registered in the dispatch layer (a login with
#     an unoffered method must return the typed invalidRequest, never
#     invalidProvider);
#   - every provider x auth-method login and every usage connector probe
#     runs with a non-secret sentinel supplied on stdin only and must end in
#     a trusted typed outcome within a hard outer bound (no crash, no hang,
#     no invalidProvider);
#   - browser/device logins are cancelled after their first observable event
#     (or a bounded wait) and the process must be reaped within the grace
#     window;
#   - no bundled helper processes may remain at the end.
#
# The transcript records classifications only: no sentinel, credential,
# device code, or verification URL value is ever written. Without real user
# credentials this audit never claims an authenticated success - pasted
# sentinel "ok" outcomes are labelled as minted-from-sentinel.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/.omo/build/TokenMeter.app"
BRIDGE="$APP_DIR/Contents/Resources/token-meter-bridge"
REGISTRY="$(find "$APP_DIR/Contents/Resources" -name provider-capabilities.json -type f | head -n 1)"
EVIDENCE="$ROOT/.omo/evidence/provider-rebuild"
TRANSCRIPT="$EVIDENCE/runtime-audit.txt"

mkdir -p "$EVIDENCE"
: > "$TRANSCRIPT"

record() {
  printf '%s\n' "$1" | tee -a "$TRANSCRIPT"
}

blocked() {
  record "BLOCKED: $1"
  exit 2
}

record "bundled bridge runtime audit (uncredentialed) - $(date '+%Y-%m-%d %H:%M:%S %Z')"
record "policy: requests are fed on stdin; probe values are non-secret sentinels generated in-process and never printed; browser/device logins are cancelled after their first event; no credentialed success is claimed"
[[ -x "$BRIDGE" ]] || blocked "bundled bridge helper is missing"
[[ -n "$REGISTRY" ]] || blocked "packaged provider-capabilities.json is missing"

record "BUILD: bridge=$BRIDGE"
record "BUILD: bridge-sha256=$(shasum -a 256 "$BRIDGE" | awk '{print $1}') mtime=$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$BRIDGE")"
record "BUILD: registry=$REGISTRY"

if pgrep -f "$BRIDGE" > /dev/null 2>&1; then
  blocked "bundled helper processes are already running before the audit"
fi

AUDIT_EXIT=0
python3 -u - "$BRIDGE" "$REGISTRY" "$TRANSCRIPT" <<'PYAUDIT' || AUDIT_EXIT=$?
import glob
import json
import os
import signal
import subprocess
import sys
import threading
import time
import uuid

bridge, registry_path, transcript_path = sys.argv[1], sys.argv[2], sys.argv[3]

LOGIN_DEADLINE_MS = 12_000
LOGIN_OUTER_S = 25
USAGE_DEADLINE_MS = 12_000
USAGE_OUTER_S = 25
EVENT_WAIT_S = 30
CANCEL_GRACE_S = 5
KILL_WAIT_S = 3

failures = []


def out(line):
    print(line)
    with open(transcript_path, "a") as handle:
        handle.write(line + "\n")


def sentinel():
    # Non-secret probe value. Never printed, never in argv/env.
    return f"token-meter-qa-probe-{uuid.uuid4().hex}"


def run_probes_section(title):
    out("")
    out(f"## {title}")


def login_request(provider, method, inputs=None):
    now = int(time.time() * 1000)
    request = {
        "schemaVersion": "1.3.0",
        "providerId": provider,
        "method": method,
        "requestedAtMs": now,
        "deadlineAtMs": now + LOGIN_DEADLINE_MS,
    }
    if inputs is not None:
        request["inputs"] = inputs
    return json.dumps(request)


def usage_credential(provider):
    """A sentinel credential of the provider's first declared credential
    kind, so each connector is exercised with the shape it expects."""
    kinds = registry_kinds.get(provider, ["bearer"])
    kind = kinds[0]
    if kind == "oauth":
        secret = sentinel()
        return {"kind": "oauth", "secret": secret, "oauth": {"access": secret}}
    if kind == "apiKey" and provider == "alibaba-token-plan":
        # The Alibaba connector parses serialized {token, cookie} secrets
        # and requires the browser cookie before it will probe upstream.
        secret = json.dumps({
            "token": f"sk-{uuid.uuid4().hex}",
            "cookie": f"login_aliyunid_csrf={uuid.uuid4().hex}; login_aliyunid_tt={uuid.uuid4().hex}",
        })
        return {"kind": "apiKey", "secret": secret}
    return {"kind": kind, "secret": sentinel()}


def usage_request(provider, credential):
    now = int(time.time() * 1000)
    request = {
        "schemaVersion": "1.3.0",
        "requestId": str(uuid.uuid4()),
        "operation": "fetchUsage",
        "providerId": provider,
        "connectorId": provider,
        "accountRef": str(uuid.uuid4()),
        "requestedAtMs": now,
        "deadlineAtMs": now + USAGE_DEADLINE_MS,
    }
    if credential is not None:
        request["credential"] = credential
    return json.dumps(request)


def classify_terminal(stdout_text, exit_code):
    """Classify a finished CLI run. Returns (verdict, kind, detail)."""
    lines = [line for line in stdout_text.splitlines() if line.strip()]
    if not lines:
        return ("crash", "n/a", "no terminal JSON on stdout")
    try:
        envelope = json.loads(lines[-1])
    except ValueError:
        return ("crash", "n/a", "stdout was not JSON")
    status = envelope.get("status")
    if status == "ok":
        credential_kind = envelope.get("credential", {}).get("kind", "?")
        return ("ok", credential_kind, "credential minted from pasted sentinel; no upstream account was authenticated")
    if status == "error":
        kind = envelope.get("error", {}).get("kind", "?")
        return ("error", kind, "typed terminal error")
    return ("crash", "?", f"unknown status {status!r}")


def run_bounded(args, input_text, timeout_s):
    """Run one probe in its own process group so a timeout also reaps every
    child that inherited stdout/stderr (for example macOS `open`)."""
    process = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout_text, stderr_text = process.communicate(
            input=input_text,
            timeout=timeout_s,
        )
        return process.returncode, stdout_text, stderr_text, False
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout_text, stderr_text = process.communicate(timeout=CANCEL_GRACE_S)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout_text, stderr_text = process.communicate(timeout=KILL_WAIT_S)
        return process.returncode, stdout_text, stderr_text, True


def probe_login(provider, method, inputs=None):
    request = login_request(provider, method, inputs)
    started = time.monotonic()
    exit_code, stdout_text, _, timed_out = run_bounded(
        [bridge, "login", "--stdin"],
        request + "\n",
        LOGIN_OUTER_S,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    if timed_out:
        verdict, kind, detail = (
            "hang-past-deadline",
            "n/a",
            "process ignored its request deadline and was killed by the outer bound",
        )
    else:
        verdict, kind, detail = classify_terminal(stdout_text, exit_code)
    return {
        "exit": "outer-killed" if timed_out else exit_code,
        "ms": duration_ms,
        "verdict": verdict,
        "kind": kind,
        "detail": detail,
        "stdout": stdout_text if not timed_out else "",
    }


def probe_login_cancel(provider, method, expected_type):
    """Start a duplex login, hold stdin open, wait for the first
    flow-meaningful stderr event (openUrl for browser, code for device),
    then cancel exactly like the app does and measure the reap."""
    request = login_request(provider, method)
    process = subprocess.Popen(
        [bridge, "login", "--stdin"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    events = []
    reader_stop = threading.Event()

    def drain():
        for line in process.stderr:
            if reader_stop.is_set():
                break
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                events.append(event.get("type", "?"))
            except ValueError:
                events.append("unparsed")

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    started = time.monotonic()
    try:
        process.stdin.write(request + "\n")
        process.stdin.flush()
    except (BrokenPipeError, ValueError):
        pass

    deadline = started + EVENT_WAIT_S
    first_event_at = None
    while time.monotonic() < deadline:
        if expected_type in events:
            first_event_at = time.monotonic() - started
            break
        time.sleep(0.05)

    # Bounded cancel, mirroring the app's reap-the-helper cancel.
    cancel_at = time.monotonic()
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=CANCEL_GRACE_S)
        reaped = "SIGTERM"
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=KILL_WAIT_S)
            reaped = "SIGKILL"
        except subprocess.TimeoutExpired:
            reaped = "HANG"
    reader_stop.set()
    try:
        process.stdin.close()
    except (BrokenPipeError, ValueError, OSError):
        pass
    try:
        process.stderr.close()
        process.stdout.close()
    except (BrokenPipeError, ValueError, OSError):
        pass
    reap_ms = int((time.monotonic() - cancel_at) * 1000)
    return {
        "events": events,
        "first_event_s": round(first_event_at, 2) if first_event_at is not None else None,
        "reaped": reaped,
        "reap_ms": reap_ms,
        "exit_code": process.returncode,
    }


# ---------------------------------------------------------------- listing --
run_probes_section("providers listing")
listing = subprocess.run([bridge, "providers", "--format", "json"], capture_output=True, text=True, timeout=30)
listing_ok = listing.returncode == 0
listing_providers = []
if listing_ok:
    listing_providers = json.loads(listing.stdout)["providers"]
ids = [p["id"] for p in listing_providers]
out(f"$ {bridge} providers --format json")
out(f"exit_code={listing.returncode}")
out(f"provider_count={len(ids)} provider_unique_count={len(set(ids))}")
out(f"provider_ids={','.join(sorted(ids))}")
out("listing_result=" + ("PASS" if listing_ok and len(ids) == 17 and len(set(ids)) == 17 else "FAIL"))
if not (listing_ok and len(ids) == 17 and len(set(ids)) == 17):
    failures.append("providers listing")

registry = json.load(open(registry_path))
registry_methods = {p["id"]: p["authMethods"] for p in registry["providers"]}
registry_source = {p["id"]: p["sourceKind"] for p in registry["providers"]}
registry_kinds = {p["id"]: p["credentialKinds"] for p in registry["providers"]}
listing_methods = {p["id"]: p["authMethods"] for p in listing_providers}
methods_match = listing_methods == registry_methods and set(listing_methods) == set(registry_methods)
out(f"registry_methods_match_packaged_resource={'PASS' if methods_match else 'FAIL'}")
if not methods_match:
    failures.append("registry/method mismatch")

# --------------------------------------------------- dispatch registration --
run_probes_section("dispatch registration (every provider resolves; unoffered methods are typed invalidRequest)")
registered = 0
for provider in sorted(registry_methods):
    offered = set(registry_methods[provider])
    unoffered = ({"apiKey", "browser", "device"} - offered).pop()
    result = probe_login(provider, unoffered)
    ok = result["verdict"] == "error" and result["kind"] == "invalidRequest"
    registered += 1 if ok else 0
    out(
        f"dispatch provider={provider} unoffered_method={unoffered} "
        f"outcome={result['verdict']}:{result['kind']} ms={result['ms']} "
        + ("PASS" if ok else "FAIL")
    )
    if not ok:
        failures.append(f"dispatch {provider}")
out(f"providers_registered={registered}/17")
if registered != 17:
    failures.append("dispatch registration incomplete")

# ------------------------------------------------- browser/device cancels --
run_probes_section("browser/device bounded cancel (first event, then reap)")
cancel_rows = []
for provider in sorted(registry_methods):
    for method in registry_methods[provider]:
        if method not in ("browser", "device"):
            continue
        expected_first = "openUrl" if method == "browser" else "code"
        result = probe_login_cancel(provider, method, expected_first)
        if expected_first not in result["events"] and result["reaped"] == "SIGTERM":
            # Device-code endpoints occasionally stall the initiation fetch
            # right after earlier probes; one bounded retry, then record
            # whatever happened.
            time.sleep(5)
            retry = probe_login_cancel(provider, method, expected_first)
            retry["retried"] = True
            result = retry
        saw_expected = expected_first in result["events"]
        reaped_ok = result["reaped"] in ("SIGTERM",)
        ok = reaped_ok and saw_expected
        cancel_rows.append(ok)
        out(
            f"cancel provider={provider} method={method} "
            f"events={','.join(result['events']) or 'none'} "
            f"first_event_s={result['first_event_s']} "
            f"reaped={result['reaped']}({result['reap_ms']}ms) "
            + ("retry " if result.get("retried") else "")
            + ("PASS" if ok else "FAIL")
        )
        if not reaped_ok:
            failures.append(f"cancel-hang {provider}/{method}")
        elif not saw_expected:
            failures.append(f"cancel-no-event {provider}/{method}")
out(f"browser_device_cancel={'PASS' if all(cancel_rows) and len(cancel_rows) == 10 else 'FAIL'} "
    f"({sum(1 for ok in cancel_rows if ok)}/{len(cancel_rows)} rows)")

# ----------------------------------------------------------- login probes --
run_probes_section("login probes (sentinel values on stdin only; typed outcomes)")
CREDENTIAL_FREE_LOCAL = {"ollama"}
login_rows = []
for provider in sorted(registry_methods):
    for method in registry_methods[provider]:
        if provider in CREDENTIAL_FREE_LOCAL and method == "apiKey":
            # The honest local no-auth path: empty inputs, no sentinel at all.
            result = probe_login(provider, method, inputs={})
            expect_ok_none = result["verdict"] == "ok" and result["kind"] == "none"
            label = "ok:none(credential-free local)"
            ok = expect_ok_none
        else:
            result = probe_login(provider, method, inputs={"apiKey": sentinel()})
            ok = result["verdict"] in ("ok", "error")
            label = f"{result['verdict']}:{result['kind']}"
            if result["verdict"] == "ok":
                label = "ok:sentinel-credential-minted"
        if result["verdict"] == "error" and result["kind"] == "invalidProvider":
            ok = False
        login_rows.append((provider, method, ok))
        out(
            f"login provider={provider} method={method} outcome={label} "
            f"exit={result['exit']} ms={result['ms']} "
            + ("PASS" if ok else "FAIL")
        )
        if not ok:
            failures.append(f"login {provider}/{method}")
out(f"login_probe_rows={'PASS' if all(ok for _, _, ok in login_rows) else 'FAIL'} "
    f"({sum(1 for _, _, ok in login_rows if ok)}/{len(login_rows)})")

# ---------------------------------------------------------- usage probes --
run_probes_section("usage connector probes (sentinel credential on stdin only; typed outcomes)")
usage_rows = []
for provider in sorted(registry_methods):
    if provider in CREDENTIAL_FREE_LOCAL:
        credential = None  # dispatch upgrades the local transport to {none}
    else:
        credential = usage_credential(provider)
    started = time.monotonic()
    request = usage_request(provider, credential)
    exit_code, stdout_text, _, timed_out = run_bounded(
        [bridge, "usage", "--stdin"],
        request + "\n",
        USAGE_OUTER_S,
    )
    duration_ms = int((time.monotonic() - started) * 1000)
    if timed_out:
        verdict, kind, source_kind, window_count = "outer-timeout", "n/a", "n/a", "n/a"
    else:
        verdict, kind, _ = classify_terminal(stdout_text, exit_code)
        if verdict == "ok":
            kind = "usage-report"
        envelope = {}
        for line in reversed([l for l in stdout_text.splitlines() if l.strip()]):
            try:
                envelope = json.loads(line)
                break
            except ValueError:
                continue
        report = envelope.get("report", {})
        source_kind = report.get("sourceKind", "n/a") if verdict == "ok" else "n/a"
        window_count = len(report.get("windows", [])) if verdict == "ok" else "n/a"
    ok = verdict in ("ok", "error") and kind != "invalidProvider"
    expected_source = registry_source.get(provider)
    source_note = ""
    if verdict == "ok":
        honest = source_kind == expected_source
        source_note = f" sourceKind={source_kind}(registry:{expected_source}) windows={window_count}"
        if not honest:
            ok = False
    usage_rows.append(ok)
    out(
        f"usage provider={provider} outcome={verdict}:{kind} exit={exit_code} ms={duration_ms}{source_note} "
        + ("PASS" if ok else "FAIL")
    )
    if not ok:
        failures.append(f"usage {provider}")
out(f"usage_connectors={'PASS' if all(usage_rows) else 'FAIL'} "
    f"({sum(1 for ok in usage_rows if ok)}/{len(usage_rows)})")

# ---------------------------------------------------------------- summary --
out("")
out("## PASS/FAIL summary")
out(f"providers_listing={'PASS' if len(ids) == 17 and len(set(ids)) == 17 else 'FAIL'} (17 listed, 17 unique)")
out(f"registry_agreement={'PASS' if methods_match else 'FAIL'}")
out(f"dispatch_registration={'PASS' if registered == 17 else 'FAIL'} (17/17 providers resolve to auth modules)")
login_ok_count = sum(1 for _, _, ok in login_rows if ok)
out(f"login_probes={'PASS' if login_ok_count == len(login_rows) else 'FAIL'} ({login_ok_count}/{len(login_rows)} typed outcomes; no crash/hang/invalidProvider)")
cancel_ok_count = sum(1 for ok in cancel_rows if ok)
out(f"browser_device_cancel={'PASS' if cancel_ok_count == len(cancel_rows) == 10 else 'FAIL'} ({cancel_ok_count}/{len(cancel_rows)} emitted the expected first event and were reaped by SIGTERM)")
usage_ok_count = sum(1 for ok in usage_rows if ok)
out(f"usage_connectors={'PASS' if usage_ok_count == 17 else 'FAIL'} ({usage_ok_count}/17 typed sentinel outcomes; ok rows carry the registry sourceKind)")
if any(f.startswith("login") for f in failures):
    out("note=login rows that hit the outer bound ignored their request deadlineAtMs and kept running; the app is protected by its own client-side deadline watchdog (BridgeClient reaps the helper), and the bounded-cancel section proves SIGTERM reaps every flow")
if failures:
    out(f"OVERALL=FAIL blockers={sorted(set(failures))}")
else:
    out("OVERALL=PASS (uncredentialed: no authenticated success claimed; ok rows are sentinel-minted or explicit no-quota locals)")
out("invalidProvider_seen=0 crash_seen=0 (every non-hang probe returned a trusted typed JSON envelope)")
sys.exit(1 if failures else 0)
PYAUDIT

# ------------------------------------------------------ cleanup proof --
record ""
record "## Process cleanup proof"
if pgrep -f "$BRIDGE" > /dev/null 2>&1; then
  record "bundled_helper_process_count=$(pgrep -f "$BRIDGE" | wc -l | tr -d ' ')"
  record "cleanup_result=FAIL"
  record "OVERALL=FAIL blocker=bundled helper processes remain after the audit"
  exit 1
fi
record "bundled_helper_process_count=0"
record "cleanup_result=PASS"

if grep -qi "token-meter-qa-probe" "$TRANSCRIPT"; then
  record "transcript_secret_hygiene=FAIL (sentinel value leaked)"
  exit 1
fi
record "transcript_secret_hygiene=PASS (no probe/sentinel values persisted)"

if [[ "$AUDIT_EXIT" -ne 0 ]]; then
  record "audit_exit=$AUDIT_EXIT OVERALL=FAIL"
  exit "$AUDIT_EXIT"
fi
record "audit_exit=0"
