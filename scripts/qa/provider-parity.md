# Offline provider-parity desktop QA

Run from the repository root. No user auth store, browser profile, external
authenticated provider, or installed Bun runtime is needed by the assembled apps.
Build tools are needed only for the offline build/test commands below.

```sh
(cd bridge && bun run typecheck && bun x tsc --noEmit -p qa/tsconfig.json)
(cd bridge && bun test qa/provider-parity.test.ts test/build-script-contract.test.ts)
swift test -j 4 -Xswiftc -DTOKEN_METER_QA --filter ProviderParityQAIntegrationTests
swift test -j 4 --filter TokenMeterAppTests
./scripts/build-all.sh
bash scripts/qa/build-capture-helper.sh
.omo/build/TokenMeterAXDriver nekos-cleanup-test
./scripts/verify-bundle.sh
```

The QA bridge is compiled from `bridge/qa/provider-parity.ts`, separately from
`bridge/src/cli.ts`, and exists only in TokenMeterQA.app. Release exclusion is
checked both by the actual import graph and the assembled release bundle.

## Native execution (one desktop owner at a time)

```sh
.omo/build/TokenMeterAXDriver accessibility-check
bash scripts/qa/provider-management.sh
bash scripts/qa/quota-panel.sh
bash scripts/qa/provider-parity.sh
```

Missing Accessibility exits 2 before app launch. Enable permission for the exact
`.omo/build/TokenMeterAXDriver` executable in System Settings; this harness never
grants/resets TCC. No permission or screenshot means **BLOCKED**, not PASS.
Do not run the opt-in live scripts as a substitute.

`provider-management` and `quota-panel` now route to the same event-driven,
isolated implementation as parity. `provider-parity.sh` runs all of these:

| Scenario | Registration and expected native state |
| --- | --- |
| management | all17 IDs/actions over scroll positions; API-key/Alibaba extras/GitHub enterprise sheets; Alibaba duplex prompt input1; pending Anthropic, Kimi and both Codex methods; capture before and after cancel |
| empty | real menu-bar item press, empty quota panel, actual registration action |
| xai-80 / xai-87.5 / xai-89.9 / xai-95 / xai-99.9 | real device auth with injected upstream approval; four independent numeric boundary rows |
| xai-overage | credits HTTP500, real monthly fallback, monthly and on-demand120/100 ->120% |
| zai-mixed | real key validation, four independent credits/tokens/requests windows at80/79.99/94.99/99.99% |
| ag-remaining | real browser callback/state/token/project auth; remaining42.5 and0 with no fraction |
| ag-weekly | same actual auth; independent weekly99% without reset, daily10% |
| cursor-used | real key validation; used42.5 requests, no capacity or fraction |
| opencode-12 | actual paste-key auth, raw rolling12% with separate rate-limited label; isolated stable installation metadata |
| nekos | real key validation, five rows0/0/18.39/0/33.55%, native manual refresh |

One scenario can be repeated in a fresh process:

```sh
.omo/build/TokenMeterAXDriver provider-parity \
  "$PWD/.omo/build/TokenMeterQA.app/Contents/MacOS/TokenMeter" \
  ag-remaining "$PWD/.omo/evidence/omp-upgrade/catalog-qa/r1/ag-remaining.png"
```

Selectors are the production `provider-action-<id>` (Cursor key method uses
`provider-action-cursor-apiKey`), `provider-field-<id>-apiKey`, `provider-save-<id>`,
`provider-login-cancel-<id>`, `provider-prompt-<id>`, `provider-prompt-send-<id>`,
`provider-management-button`, `token-meter-menu-panel`, and `provider-refresh-nekos`.
Only `nekos-qa-refresh-count` is QA-owned: it observes actual model completions,
never inserts report data. Data inputs are fresh in-memory UUIDs assigned to the
secure field, then carried by BridgeClient over stdin, never argv/env/logs.
Data rows require the presentation producer's production `quota-row-<limitId>`
identifier. Numeric amount fields are matched exactly, so0% cannot pass as10%.

Management-only auth progress is deliberately simulated and cannot establish
provider-auth correctness. Data scenarios use actual auth entry points. Every
usage response is raw upstream JSON parsed by the registered production adapter.
Unknown HTTP routes fail even if the adapter tolerates an optional probe failure.
Antigravity sends only the exact actual127.0.0.1 callback with its generated state;
all provider HTTP is injected. Only the QA model's openURL dependency suppresses
external browser opening. Opt-in live QA retains its original browser behavior.

Each scenario subscribes to session readiness and AX events before acting. Native
scroll events and AXScrollToVisible expose rows; screenshot each actual viewport.
After success or failure, kernel exit events confirm termination of owned helpers
and app, then only `TokenMeter-QA-<pid>-{menu,settings,credentials,installation}`
directories are removed. The full driver run logs these cleanup receipts.
QA stores are never deleted on model construction: lazy menu creation cannot
erase a registration already saved by the hosted model.

### Capture identity and dismissal coverage

Sheet states capture the visible attached NSWindow's entire content, explicitly
identified as `attached-sheet-content`, not a parent/sheet composite. Every
current field, save/cancel/prompt control and internal close button must fit
inside the captured content bounds. A missing/hidden sheet fails; parent-only
fallback is forbidden when a sheet is expected. Actual pixels, legibility and
complete drawn controls still require both native visual reviews.

`sheet-opencode-go-apiKey` is the preserved OPEN image. The distinct
`management-restored-opencode-go-apiKey` image is taken only after the subscribed
AX dismissal condition succeeds and maps to `api-key-close` in the acceptance
manifest. Alibaba and GitHub likewise have distinct restored-management images.
`cancelled-<provider>[-method]` means input restored BEFORE sheet close, not
dismissed. Codex browser/device cancellations have separate method identities.

Hosted captures emit `<image>.png.json` receipts with request UUID, process ID,
state, original temporary capture path, selected and parent window IDs, screen
content bounds, scale, decoded pixel dimensions and SHA256. The request's exact
PID/state/path/UUID/target must match, the PNG must have its real signature and
complete ImageIO decode, dimensions must match content bounds and scale, and
the file digest must match. The receipt's path intentionally retains the source
path before the driver moves both PNG and receipt to their final evidence paths.
STATE/CAPTURE logs bind that move; do not rewrite historical receipts.

Supplemental validation: `swift test --jobs 2 -Xswiftc -DTOKEN_METER_QA --filter QACaptureTests`.
These codec/identity/geometry and offscreen AppKit checks are NOT native GUI
proof. For r2 use direct driver invocations with r2 output paths; the existing
wrapper defaults below retain r1 history and must not be rerun over that history.

Output: `.omo/evidence/omp-upgrade/catalog-qa/r1/provider-parity-gui.log`, PNGs,
source/head and binary hashes. Existing wrapper scripts retain their established
evidence locations. Screenshot/value/viewport assertions are native acceptance;
absence of a drawn bar and CJK/layout legibility additionally require independent
visual inspection. Wire/domain checks use unit-independent bands0.8/0.95/1.
Actual QuotaRow display intentionally uses warning>=0.8 for percent units and
warning>=0.5 for every other unit; critical>=0.95/exhausted>=1 are unchanged.
Thus79.99% is wire ok, but displays warning for tokens/credits/USD/unknown and
ok for percent units.94.99% is warning and99.99% critical for every unit.
The compiled registration test and native AX labels assert this existing display
policy; bridge tests independently assert wire severity. Neither channel is a
production blocker or a reason to alter measurements. AG remaining-only stays42.5/0
unknown units with no fraction/bar; Nekos uses the normal current fixture, not
the1e308 stress case. Offline proof is not GUI color or visual proof.
