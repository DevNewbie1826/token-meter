import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const IDS_WITH_NEWCOMER = [
  "alibaba-token-plan",
  "anthropic",
  "cursor",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
  "kimi-code",
  "minimax-code",
  "nekos",
  "newcomer-ai",
  "ollama",
  "ollama-cloud",
  "openai-codex",
  "opencode-go",
  "synthetic",
  "umans",
  "xai-oauth",
  "zai",
] as const;

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
  adapterSourcePath: `src/providers/${id}.ts`,
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
  if (typeof type === "string" && (type === "integer" || type === "number") && typeof value !== "number") {
    throw new Error(`${path}: expected number, got ${JSON.stringify(value)}`);
  }
}

describe("OMP pinned source", () => {
  test("pins the research-locked OMP commit when sync runs", () => {
    expect(OMP_PINNED_SHA).toBe("8500092296621a6826b7136e840f8a59ea338958");
  });
});

describe("registry version pinning", () => {
  test("pins the registry version independently of the TokenMeter wire version", () => {
    expect(REGISTRY_VERSION).toBe("1.2.0");
    expect(PROTOCOL_VERSION).toBe("1.2.0");
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

  test("flags an unknown discovered provider as excluded and pending review when OMP adds one", () => {
    const discovered = [...DISCOVERED_LOCKED, { id: "newcomer-ai", adapterSourcePath: "src/x.ts" }];
    const manifest = buildCapabilityManifest({ discovered, headSha: OMP_PINNED_SHA });
    expect(manifest.providers.map((provider) => provider.id)).toEqual([...IDS_WITH_NEWCOMER]);
    const newcomer = manifest.providers.find((provider) => provider.id === "newcomer-ai");
    if (newcomer === undefined) {
      throw new Error("newcomer-ai missing from manifest");
    }
    expect(newcomer.supportTier).toBe("excluded");
    expect(newcomer.connectorTransport).toBe("external");
    expect(newcomer.authMethods).toEqual([]);
    expect(newcomer.credentialKinds).toEqual([]);
    expect(newcomer.pendingCapabilityReview).toBe(true);
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
});

describe("syncOmpRegistry checkout gate", () => {
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
