import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../src/protocol";
import {
  CONNECTOR_TRANSPORTS,
  LOCKED_PROVIDER_IDS,
  REGISTRY_AUTH_METHODS,
  REGISTRY_CREDENTIAL_KINDS,
  REGISTRY_VERSION,
  SUPPORT_TIERS,
  listProviderCapabilities,
} from "../src/registry";
import {
  OMP_PINNED_SHA,
  OmpSyncError,
  buildCapabilityManifest,
  buildPendingDiscoveryReport,
  syncOmpDiscovery,
  syncOmpRegistry,
} from "../scripts/sync-omp-registry";
import type { DiscoveredOmpProvider } from "../scripts/sync-omp-registry";
import { expectNoModelFields } from "./helpers";

const LOCKED_16 = [
  "alibaba-token-plan",
  "anthropic",
  "cursor",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
  "kimi-code",
  "minimax-code",
  "ollama",
  "ollama-cloud",
  "openai-codex",
  "opencode-go",
  "synthetic",
  "umans",
  "xai-oauth",
  "zai",
] as const;

const LOCKED_17 = [...LOCKED_16, "nekos" as const].sort();

const ALLOWED_CAPABILITY_KEYS = [
  "authMethods",
  "authorizationBasis",
  "connectorTransport",
  "credentialKinds",
  "declaredUnit",
  "declaredWindows",
  "id",
  "pollingPolicy",
  "productKind",
  "sourceKind",
  "supportTier",
];

function syncErrorFrom(action: () => unknown): OmpSyncError {
  try {
    action();
  } catch (error) {
    if (error instanceof OmpSyncError) {
      return error;
    }
    throw new Error(`expected OmpSyncError, got ${String(error)}`);
  }
  throw new Error("expected OmpSyncError but the action succeeded");
}

const DISCOVERED_LOCKED: readonly DiscoveredOmpProvider[] = LOCKED_16.map((id) => ({
  id,
  adapterSourcePath: `packages/ai/src/usage/${id}.ts`,
}));

const PENDING_IDS = ["cline-pass", "devin", "muse-code"] as const;
const DISCOVERED_PENDING = PENDING_IDS.map(id => ({
  id, adapterSourcePath: `packages/ai/src/usage/${id}.ts`,
}));

// Minimal JSON Schema (draft 2020-12 subset) checker: enough vocabulary for
// the registry/common schemas ($ref, const, enum, object closedness, array
// bounds) so tests can prove the shipped documents actually validate.
type JsonSchema = Record<string, unknown>;

function schemaDef(root: JsonSchema, ref: string): JsonSchema {
  const defs = root["$defs"] as Record<string, JsonSchema>;
  const name = ref.replace("#/$defs/", "");
  const def = defs[name];
  if (def === undefined) {
    throw new Error(`unknown schema $ref ${ref}`);
  }
  return def;
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  const [file, fragment] = ref.split("#/$defs/");
  if (file === undefined || fragment === undefined) {
    throw new Error(`unsupported schema $ref ${ref}`);
  }
  const owning = file === ""
    ? root
    : (JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8")) as JsonSchema);
  return schemaDef(owning, `#/$defs/${fragment}`);
}

function assertSchema(value: unknown, schema: JsonSchema, root: JsonSchema, path: string): void {
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    assertSchema(value, resolveRef(ref, root), root, path);
    return;
  }
  if ("const" in schema && value !== schema["const"]) {
    throw new Error(`${path}: expected const ${JSON.stringify(schema["const"])}, got ${JSON.stringify(value)}`);
  }
  const enumeration = schema["enum"];
  if (Array.isArray(enumeration) && !enumeration.includes(value)) {
    throw new Error(`${path}: ${JSON.stringify(value)} is not one of [${enumeration.map(String).join(", ")}]`);
  }
  const type = schema["type"];
  if (type === "object" || schema["properties"] !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path}: expected object, got ${JSON.stringify(value)}`);
    }
    const properties = (schema["properties"] ?? {}) as Record<string, JsonSchema>;
    for (const required of (schema["required"] ?? []) as string[]) {
      if (!(required in value)) {
        throw new Error(`${path}: missing required property "${required}"`);
      }
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${path}: unknown property "${key}"`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) {
        assertSchema((value as Record<string, unknown>)[key], child, root, `${path}.${key}`);
      }
    }
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${path}: expected array, got ${JSON.stringify(value)}`);
    }
    const items = schema["items"] as JsonSchema | undefined;
    if (items !== undefined) {
      value.forEach((entry, index) => assertSchema(entry, items, root, `${path}[${index}]`));
    }
    if (schema["uniqueItems"] === true && new Set(value.map(entry => JSON.stringify(entry))).size !== value.length) {
      throw new Error(`${path}: array items are not unique`);
    }
    const minItems = schema["minItems"];
    if (typeof minItems === "number" && value.length < minItems) {
      throw new Error(`${path}: expected at least ${minItems} items, got ${value.length}`);
    }
    const maxItems = schema["maxItems"];
    if (typeof maxItems === "number" && value.length > maxItems) {
      throw new Error(`${path}: expected at most ${maxItems} items, got ${value.length}`);
    }
    return;
  }
  if (type === "string" && typeof value !== "string") {
    throw new Error(`${path}: expected string, got ${JSON.stringify(value)}`);
  }
  if (typeof value === "string") {
    const minLength = schema["minLength"];
    const pattern = schema["pattern"];
    if (typeof minLength === "number" && value.length < minLength) {
      throw new Error(`${path}: string shorter than ${minLength}`);
    }
    if (typeof pattern === "string" && !new RegExp(pattern).test(value)) {
      throw new Error(`${path}: string does not match ${pattern}`);
    }
  }
  if (typeof type === "string" && (type === "integer" || type === "number") && typeof value !== "number") {
    throw new Error(`${path}: expected number, got ${JSON.stringify(value)}`);
  }
}

describe("OMP pinned source", () => {
  test("pins the research-locked OMP commit when sync runs", () => {
    expect(OMP_PINNED_SHA).toBe("d720e81fb747132f0b6c6c0f44eafc887552ec7f");
  });
});

describe("registry version pinning", () => {
  test("pins the registry version independently of the TokenMeter wire version", () => {
    expect(REGISTRY_VERSION).toBe("1.2.0");
    expect(PROTOCOL_VERSION).toBe("1.3.0");
  });

  test("providers --format json emits the registry version, not the wire version", async () => {
    const proc = Bun.spawn(["bun", "src/cli.ts", "providers", "--format", "json"], {
      cwd: import.meta.dir + "/..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const listing = JSON.parse(stdout) as { schemaVersion: string; providers: unknown[] };
    expect(listing.schemaVersion).toBe(REGISTRY_VERSION);
    expect(listing.providers).toEqual(listProviderCapabilities() as unknown[]);
  });
});

describe("locked capability registry", () => {
  test("exposes exactly the 17 locked provider IDs when the registry is listed", () => {
    expect(LOCKED_PROVIDER_IDS).toEqual(LOCKED_17);
    expect(new Set(LOCKED_PROVIDER_IDS).size).toBe(17);
  });

  test("labels every entry with only capability fields when entries are emitted", () => {
    const providers = listProviderCapabilities();
    expect(providers.map((provider) => provider.id)).toEqual([...LOCKED_17]);
    for (const provider of providers) {
      expect(Object.keys(provider).sort()).toEqual([...ALLOWED_CAPABILITY_KEYS]);
    }
    expectNoModelFields(providers);
  });

  test("dispatches every provider through a builtin transport with valid auth capabilities at 1.2.0", () => {
    for (const provider of listProviderCapabilities()) {
      const expectedTransport: string = provider.id === "github-copilot" ? "builtin-github-billing" : `builtin-${provider.id}`;
      expect(String(provider.connectorTransport)).toBe(expectedTransport);
      expect(provider.authMethods.length).toBeGreaterThan(0);
      for (const method of provider.authMethods) {
        expect(REGISTRY_AUTH_METHODS).toContain(method);
      }
      expect(new Set(provider.authMethods).size).toBe(provider.authMethods.length);
      expect(provider.credentialKinds.length).toBeGreaterThan(0);
      for (const kind of provider.credentialKinds) {
        expect(REGISTRY_CREDENTIAL_KINDS).toContain(kind);
      }
      expect(new Set(provider.credentialKinds).size).toBe(provider.credentialKinds.length);
    }
  });

  test("labels github-copilot as the documented billing connector when tiers are pinned", () => {
    const github = listProviderCapabilities().find((provider) => provider.id === "github-copilot");
    if (github === undefined) {
      throw new Error("github-copilot missing from registry");
    }
    expect(github.supportTier).toBe("supported");
    expect(github.connectorTransport).toBe("builtin-github-billing");
    expect(github.productKind).toBe("billingUsage");
    expect(github.sourceKind).toBe("documentedApi");
    expect(github.authorizationBasis).toBe("documentedUserBilling");
    expect(github.declaredUnit).toBe("requests");
    expect(github.declaredWindows).toEqual(["monthly"]);
    expect(github.pollingPolicy).toBe("authorizedDefault");
    expect(github.authMethods).toEqual(["apiKey", "device"]);
    expect(github.credentialKinds).toEqual(["bearer", "apiKey"]);
  });

  test("keeps excluded providers excluded when research verdicts are pinned", () => {
    const providers = listProviderCapabilities();
    for (const excludedId of ["alibaba-token-plan", "anthropic"]) {
      const entry = providers.find((provider) => provider.id === excludedId);
      if (entry === undefined) {
        throw new Error(`${excludedId} missing from registry`);
      }
      expect(entry.supportTier).toBe("excluded");
    }
    const opencodeGo = providers.find((provider) => provider.id === "opencode-go");
    if (opencodeGo === undefined) {
      throw new Error("opencode-go missing from registry");
    }
    expect(opencodeGo.supportTier).toBe("bestEffort");
    const ollama = providers.find((provider) => provider.id === "ollama");
    if (ollama === undefined) {
      throw new Error("ollama missing from registry");
    }
    expect(ollama.productKind).toBe("localActivity");
  });

  test("pins the final auth-method surface for the dual-method providers", () => {
    const byId = new Map(listProviderCapabilities().map((provider) => [provider.id, provider] as const));
    expect(byId.get("openai-codex")?.authMethods).toEqual(["browser", "device"]);
    expect(byId.get("github-copilot")?.authMethods).toEqual(["apiKey", "device"]);
    expect(byId.get("cursor")?.authMethods).toEqual(["browser", "apiKey"]);
    expect(byId.get("zai")?.authMethods).toEqual(["apiKey", "browser"]);
  });
});

describe("buildCapabilityManifest", () => {
  test("emits the deterministic sorted 17-entry manifest when the checkout matches the lock", () => {
    const first = buildCapabilityManifest({ discovered: DISCOVERED_LOCKED, headSha: OMP_PINNED_SHA });
    const second = buildCapabilityManifest({ discovered: DISCOVERED_LOCKED, headSha: OMP_PINNED_SHA });
    expect(first.schemaVersion).toBe("1.2.0");
    expect(first.syncedFromSha).toBe(OMP_PINNED_SHA);
    expect(first.providers.map((provider) => provider.id)).toEqual([...LOCKED_17]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expectNoModelFields(first);
    const github = first.providers.find((provider) => provider.id === "github-copilot");
    if (github === undefined) {
      throw new Error("github-copilot missing from manifest");
    }
    expect(github.supportTier).toBe("supported");
  });

  test("never publishes an unknown discovered provider when OMP adds one", () => {
    const discovered = [...DISCOVERED_LOCKED, { id: "newcomer-ai", adapterSourcePath: "src/x.ts" }];
    const manifest = buildCapabilityManifest({ discovered, headSha: OMP_PINNED_SHA });
    expect(manifest.providers.map((provider) => provider.id)).toEqual([...LOCKED_17]);
    expect(manifest.providers).toEqual(listProviderCapabilities());
    for (const provider of manifest.providers) {
      expect(Object.keys(provider).sort()).toEqual(ALLOWED_CAPABILITY_KEYS);
    }
  });

  test("fails loudly when a locked provider is missing from the checkout", () => {
    const discovered = DISCOVERED_LOCKED.filter((provider) => provider.id !== "zai");
    expect(
      syncErrorFrom(() => buildCapabilityManifest({ discovered, headSha: OMP_PINNED_SHA })).kind,
    ).toBe("lockedProviderMissing");
  });
});

describe("generated manifests", () => {
  const generatedPath = new URL("../generated/provider-capabilities.json", import.meta.url);
  const bundledPath = new URL("../../Sources/TokenMeterCore/Resources/provider-capabilities.json", import.meta.url);

  test("ships the generated manifest byte-identical to the Swift resource copy", () => {
    expect(Buffer.compare(readFileSync(generatedPath), readFileSync(bundledPath))).toBe(0);
  });

  test("matches a fresh deterministic build of the locked registry at the pinned SHA", () => {
    const fresh = buildCapabilityManifest({ discovered: DISCOVERED_LOCKED, headSha: OMP_PINNED_SHA });
    expect(JSON.parse(readFileSync(generatedPath, "utf8"))).toEqual(fresh);
  });

  test("carries the 1.2.0 sorted unique 17-provider listing with valid new fields", () => {
    const manifest = JSON.parse(readFileSync(generatedPath, "utf8")) as ReturnType<typeof buildCapabilityManifest>;
    expect(manifest.schemaVersion).toBe("1.2.0");
    expect(manifest.syncedFromSha).toBe(OMP_PINNED_SHA);
    const ids = manifest.providers.map((provider) => provider.id);
    expect(ids).toEqual([...LOCKED_17]);
    expect(new Set(ids).size).toBe(17);
    expect([...ids].sort()).toEqual(ids);
    for (const provider of manifest.providers) {
      expect(provider.authMethods.length).toBeGreaterThan(0);
      for (const method of provider.authMethods) {
        expect(REGISTRY_AUTH_METHODS).toContain(method);
      }
      expect(provider.credentialKinds.length).toBeGreaterThan(0);
      for (const kind of provider.credentialKinds) {
        expect(REGISTRY_CREDENTIAL_KINDS).toContain(kind);
      }
    }
    expectNoModelFields(manifest);
  });
});

describe("separate pending discovery", () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/discovery.schema.json", import.meta.url), "utf8")) as JsonSchema;
  const discovered = [...DISCOVERED_LOCKED, ...DISCOVERED_PENDING];
  const input = { discovered, headSha: OMP_PINNED_SHA };

  test("keeps three new IDs and source paths pending without capability claims", () => {
    const report = buildPendingDiscoveryReport(input);
    expect(report).toEqual({
      schemaVersion: "1.0.0", syncedFromSha: OMP_PINNED_SHA,
      pendingProviders: DISCOVERED_PENDING.map(provider => ({ ...provider, reviewStatus: "pendingCapabilityReview" })),
    });
    expect(buildCapabilityManifest(input).providers.map(provider => provider.id)).toEqual(LOCKED_17);
    expectNoModelFields(report);
    assertSchema(report, schema, schema, "$");
    expect(readFileSync(new URL("../generated/provider-discovery.json", import.meta.url), "utf8"))
      .toBe(`${JSON.stringify(report, null, "\t")}\n`);
  });

  test("keeps arbitrary future discoveries separate, sorted and deterministic", () => {
    const future = { id: "future-ai", adapterSourcePath: "packages/ai/src/usage/future-ai.ts" };
    const withFuture = [...discovered, future, ...DISCOVERED_PENDING,
      { id: "nekos", adapterSourcePath: "packages/ai/src/usage/nekos.ts" }];
    const report = buildPendingDiscoveryReport({ ...input, discovered: withFuture });
    expect(report.pendingProviders.map(provider => provider.id)).toEqual(["cline-pass", "devin", "future-ai", "muse-code"]);
    expect(JSON.stringify(report)).toBe(JSON.stringify(buildPendingDiscoveryReport({ ...input, discovered: withFuture.reverse() })));
    expect(buildCapabilityManifest({ ...input, discovered: withFuture }).providers).toEqual(listProviderCapabilities());
    assertSchema(report, schema, schema, "$");
  });

  test("requires all reviewed OMP providers even in discovery mode", () => {
    for (const missingId of LOCKED_16) {
      expect(syncErrorFrom(() => buildPendingDiscoveryReport({
        ...input, discovered: discovered.filter(provider => provider.id !== missingId),
      })).kind).toBe("lockedProviderMissing");
    }
    expect(buildPendingDiscoveryReport({ ...input, discovered: DISCOVERED_LOCKED }).pendingProviders).toEqual([]);
  });

  test("rejects capability claims, model fields, unknown fields, bad provenance and review status", () => {
    const report = buildPendingDiscoveryReport(input);
    const first = report.pendingProviders[0];
    if (first === undefined) throw new Error("pending fixture missing");
    for (const invalid of [
      { ...report, providers: [] },
      { ...report, syncedFromSha: "not-a-sha" },
      { ...report, schemaVersion: REGISTRY_VERSION },
      { ...report, pendingProviders: [{ ...first, supportTier: "excluded" }] },
      { ...report, pendingProviders: [{ ...first, authMethods: [] }] },
      { ...report, pendingProviders: [{ ...first, modelCatalog: [] }] },
      { ...report, pendingProviders: [{ ...first, id: "" }] },
      { ...report, pendingProviders: [{ ...first, reviewStatus: "supported" }] },
      { ...report, pendingProviders: [{ ...first, adapterSourcePath: "/tmp/provider.ts" }] },
      { ...report, pendingProviders: [{ id: first.id, reviewStatus: first.reviewStatus }] },
      { ...report, pendingProviders: [first, first] },
    ]) {
      expect(() => assertSchema(invalid, schema, schema, "$")).toThrow();
    }
  });

  test("scans source-only adapters through both sync entry points without importing them", () => {
    const scratch = mkdtempSync(join(tmpdir(), "token-meter-discovery-"));
    try {
      mkdirSync(join(scratch, "packages/ai/src/usage"), { recursive: true });
      const entries = [...discovered, { id: "future-ai", adapterSourcePath: "packages/ai/src/usage/future-ai.ts" }];
      const imports = entries.map((entry, i) => `import { provider${i} } from "./usage/${entry.id}";`).join("\n");
      writeFileSync(join(scratch, "packages/ai/src/auth-storage.ts"),
        `${imports}\nthrow new Error("upstream must never execute");\nconst DEFAULT_USAGE_PROVIDERS: UsageProvider[] = [${entries.map((_, i) => `provider${i}`).join(",")}];`);
      entries.forEach((entry, i) => writeFileSync(join(scratch, entry.adapterSourcePath),
        `throw new Error("adapter must never execute");\nconst ID = ${JSON.stringify(entry.id)};\nexport const provider${i}: UsageProvider = { nested: { id: "wrong" }, id: ID };`));
      const options = { checkoutPath: scratch, resolveHeadSha: () => OMP_PINNED_SHA, resolveCheckoutStatus: () => "" };
      expect(syncOmpRegistry(options).providers).toEqual(listProviderCapabilities());
      const report = syncOmpDiscovery(options);
      expect(report.pendingProviders.map(provider => provider.id)).toEqual(["cline-pass", "devin", "future-ai", "muse-code"]);
      expect(report.pendingProviders).toContainEqual({
        id: "future-ai", adapterSourcePath: "packages/ai/src/usage/future-ai.ts", reviewStatus: "pendingCapabilityReview",
      });
      expect(syncOmpDiscovery(options)).toEqual(report);
      assertSchema(report, schema, schema, "$");
      expect(syncErrorFrom(() => syncOmpDiscovery({ ...options, resolveCheckoutStatus: () => "?? new.ts" })).kind).toBe("dirtyCheckout");
    } finally {
      rmSync(scratch, { recursive: true });
    }
  });
});

describe("registry schema agreement", () => {
  const registrySchema = JSON.parse(
    readFileSync(new URL("../schemas/registry.schema.json", import.meta.url), "utf8"),
  ) as JsonSchema;
  const commonSchema = JSON.parse(
    readFileSync(new URL("../schemas/common.schema.json", import.meta.url), "utf8"),
  ) as JsonSchema;
  const generatedManifest = JSON.parse(
    readFileSync(new URL("../generated/provider-capabilities.json", import.meta.url), "utf8"),
  );

  test("pins the registry version consts separately from the wire version const", () => {
    const registryDefs = registrySchema["$defs"] as Record<string, JsonSchema>;
    expect(registryDefs["providersListing"]!["properties"])
      .toEqual(expect.objectContaining({ schemaVersion: { const: REGISTRY_VERSION } }));
    expect(registryDefs["capabilityManifest"]!["properties"])
      .toEqual(expect.objectContaining({ schemaVersion: { const: REGISTRY_VERSION } }));
    const commonDefs = commonSchema["$defs"] as Record<string, JsonSchema>;
    expect(commonDefs["schemaVersion"])
      .toEqual({ const: PROTOCOL_VERSION });
  });

  test("keeps the schema vocabularies in lockstep with the registry constants", () => {
    const defs = registrySchema["$defs"] as Record<string, JsonSchema>;
    expect(defs["registryAuthMethod"]!["enum"]).toEqual([...REGISTRY_AUTH_METHODS]);
    expect(defs["registryCredentialKind"]!["enum"]).toEqual([...REGISTRY_CREDENTIAL_KINDS]);
    expect(defs["connectorTransport"]!["enum"]).toEqual([...CONNECTOR_TRANSPORTS]);
    expect(defs["supportTier"]!["enum"]).toEqual([...SUPPORT_TIERS]);
  });

  test("validates the generated manifest against the capability manifest schema", () => {
    assertSchema(
      generatedManifest,
      (registrySchema["$defs"] as Record<string, JsonSchema>)["capabilityManifest"]!,
      registrySchema,
      "$",
    );
  });

  test("validates the providers listing against the listing schema", () => {
    assertSchema(
      { schemaVersion: REGISTRY_VERSION, providers: listProviderCapabilities() },
      (registrySchema["$defs"] as Record<string, JsonSchema>)["providersListing"]!,
      registrySchema,
      "$",
    );
  });

  test("rejects pending-review fields and non-17 manifest counts", () => {
    const schema = schemaDef(registrySchema, "#/$defs/capabilityManifest");
    const providers = listProviderCapabilities();
    expect(() => assertSchema({ ...generatedManifest, providers: providers.map(provider => ({
      ...provider, pendingCapabilityReview: true,
    })) }, schema, registrySchema, "$" )).toThrow();
    for (const entries of [providers.slice(1), [...providers, providers[0]]]) {
      expect(() => assertSchema({ ...generatedManifest, providers: entries }, schema, registrySchema, "$" )).toThrow();
    }
  });
});

describe("syncOmpRegistry checkout gate", () => {
  test("rejects a dirty checkout even when HEAD matches the pin", () => {
    const options = {
      checkoutPath: import.meta.dir,
      resolveHeadSha: () => OMP_PINNED_SHA,
      resolveCheckoutStatus: () => " M packages/ai/src/auth-storage.ts\n",
      discoverProviders: () => DISCOVERED_LOCKED,
    };
    expect(syncErrorFrom(() => syncOmpRegistry(options)).kind).toBe("dirtyCheckout");
  });

  test("rejects a relative checkout path when sync is configured", () => {
    expect(syncErrorFrom(() => syncOmpRegistry({ checkoutPath: "oh-my-pi" })).kind).toBe(
      "invalidCheckoutPath",
    );
  });

  test("fails with an explicit typed diagnostic when the configured checkout is absent", () => {
    const scratch = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
    try {
      const error = syncErrorFrom(() => syncOmpRegistry({ checkoutPath: join(scratch, "absent") }));
      expect(error.kind).toBe("checkoutMissing");
    } finally {
      rmSync(scratch, { recursive: true });
    }
  });

  test("fails with an explicit typed diagnostic when the checkout SHA differs from the pin", () => {
    const scratch = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
    try {
      const error = syncErrorFrom(() =>
        syncOmpRegistry({ checkoutPath: scratch, resolveHeadSha: () => "0".repeat(40) }),
      );
      expect(error.kind).toBe("shaMismatch");
    } finally {
      rmSync(scratch, { recursive: true });
    }
  });
});
