# Provider catalog synchronization

Token Meter ships **17 reviewed implementations**: 16 OMP-derived adapters plus
app-owned Nekos. Source discovery is pinned to OMP
`d720e81fb747132f0b6c6c0f44eafc887552ec7f`, not a moving branch. The scanner reads
TypeScript source and Git metadata only; it never imports or executes OMP.
The checkout must be clean at that exact revision, and missing any reviewed
OMP provider fails synchronization in either mode.

Run these as **separate invocations** from `bridge/`, with your absolute checkout:

```sh
bun scripts/sync-omp-registry.ts --checkout /absolute/path/to/oh-my-pi
bun scripts/sync-omp-registry.ts --checkout /absolute/path/to/oh-my-pi --discovery
cp generated/provider-capabilities.json ../Sources/TokenMeterCore/Resources/provider-capabilities.json
```

`OMP_CHECKOUT` can supply the checkout instead of `--checkout`. Each invocation
writes exactly one selected output; `--out /path/to/output.json` overrides it.
The explicit copy is separate: sync never silently updates the Core resource.

| Output | Purpose | Version |
| --- | --- | --- |
| `generated/provider-capabilities.json` (default) | Strict shipped capabilities, exactly 17 implementations | Registry 1.2.0 |
| `generated/provider-discovery.json` (`--discovery`) | Pending source discoveries, not shipped or registered | Discovery 1.0.0 |

Pending discovery currently contains `cline-pass`, `devin`, and `muse-code`.
Each entry has only `id`, `adapterSourcePath`, and
`reviewStatus: "pendingCapabilityReview"`. Unknown future discoveries stay in
that report, not the app, provider listing, or connector/auth registration.
No model catalog, credentials, authentication promises, or support tier is
inferred from discovery. The shipped manifest rejects pending-review fields.

The wire protocol remains independently versioned at **1.3.0**. Registry 1.2.0
has not been bumped for a source pin or metadata correction. Existing provider
port-history SHAs describe implementation origins, not current discovery
provenance, and are intentionally preserved. Support tiers, authorization bases,
polling labels, and the app's refresh of every registered provider are unchanged.

`declaredUnit` is one common unit, or `unknown` when amounts are mixed or
unspecified. Actual usage windows retain independent units and amounts:

- Anthropic: percent quotas and USD monthly extra usage.
- Cursor: USD, requests, or percent, including used-only amounts.
- Antigravity: percent or remaining-only amounts with unknown unit.
- Synthetic: request and USD windows.
- Z.ai: token, request, and genuine credit windows.

Declared windows are descriptive, not an exhaustive restriction on dynamic
provider windows. No aggregate or conversion is invented from this metadata.

## Verification

```sh
bun test test/registry-sync.test.ts test/registry-local.test.ts test/dispatch-registration.test.ts
bun run typecheck
bun run build
build/token-meter-bridge providers --format json
cmp generated/provider-capabilities.json ../Sources/TokenMeterCore/Resources/provider-capabilities.json
cd ..
swift test --filter 'ProviderManagementTests|NekosCatalogTests'
```

The registry tests cover published/pending separation, unknown future discovery,
source-only scanning, missing reviewed providers, schema closedness, deterministic
bytes, and the identical packaged resource. Neither discovery nor verification
needs user credentials or authenticated external services.
