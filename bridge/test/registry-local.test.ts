import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DECLARED_WINDOWS, listProviderCapabilities } from "../src/registry";
import { buildCapabilityManifest, OMP_PINNED_SHA, OmpSyncError } from "../scripts/sync-omp-registry";

const ompIds = [
  "alibaba-token-plan", "anthropic", "cursor", "github-copilot",
  "google-antigravity", "google-gemini-cli", "kimi-code", "minimax-code",
  "ollama", "ollama-cloud", "openai-codex", "opencode-go",
  "synthetic", "umans", "xai-oauth", "zai",
] as const;
const discovered = ompIds.map((id) => ({ id, adapterSourcePath: `src/providers/${id}.ts` }));
const expectedIds = [...ompIds, "nekos" as const].sort();

describe("app-owned provider union", () => {
  test("includes Nekos when discovery contains only the 16 OMP providers", () => {
    // Given: discovery has no app-owned provider.
    const input = { discovered, headSha: OMP_PINNED_SHA };
    // When
    const manifest = buildCapabilityManifest(input);
    // Then
    expect(manifest.providers.map(({ id }) => id)).toEqual(expectedIds);
    expect(manifest.providers.find(({ id }) => id === "nekos")).toEqual({
      id: "nekos", supportTier: "bestEffort", connectorTransport: "builtin-nekos",
      authMethods: ["apiKey"], credentialKinds: ["apiKey"], productKind: "quota",
      sourceKind: "firstPartyApi", authorizationBasis: "apiKey", declaredUnit: "percent",
      declaredWindows: ["3h", "daily", "weekly"], pollingPolicy: "notPolled",
    });
  });

  test("deduplicates and sorts Nekos when discovery also names it", () => {
    // Given
    const input = { discovered: [{ id: "nekos", adapterSourcePath: "src/nekos.ts" }, ...discovered].reverse(), headSha: OMP_PINNED_SHA };
    // When
    const manifest = buildCapabilityManifest(input);
    // Then
    expect(manifest.providers.map(({ id }) => id)).toEqual(expectedIds);
  });

  for (const missingId of ompIds) {
    test(`rejects discovery when existing OMP provider ${missingId} is absent`, () => {
      // Given
      const input = { discovered: discovered.filter(({ id }) => id !== missingId), headSha: OMP_PINNED_SHA };
      // When / Then
      expect(() => buildCapabilityManifest(input)).toThrow(new OmpSyncError(
        "lockedProviderMissing", `locked provider(s) missing from OMP checkout: ${missingId}`,
      ));
    });
  }

  test("declares three-hour windows when registry vocabulary is read", () => {
    // Given / When
    const windows = DECLARED_WINDOWS;
    // Then
    expect(windows).toEqual(["3h", "5h", "7d", "daily", "weekly", "monthly"]);
  });

  test("requires exactly 17 entries when the listing schema is read", () => {
    // Given
    const source = readFileSync(new URL("../schemas/registry.schema.json", import.meta.url), "utf8");
    // When
    const schema: unknown = JSON.parse(source);
    // Then
    expect(schema).toHaveProperty("$defs.providersListing.properties.providers.minItems", 17);
    expect(schema).toHaveProperty("$defs.providersListing.properties.providers.maxItems", 17);
    expect(schema).toHaveProperty("$defs.declaredWindow.enum", ["3h", "5h", "7d", "daily", "weekly", "monthly"]);
  });

  test("lists Nekos when the public catalog is requested", () => {
    // Given / When
    const providers = listProviderCapabilities();
    // Then
    expect(providers.map(({ id }) => id)).toEqual(expectedIds);
    expect(new Set(providers.map(({ id }) => id)).size).toBe(17);
  });
});
