/**
 * OMP registry sync.
 *
 * Reads exactly one configured absolute OMP checkout, verifies the pinned
 * research SHA, extracts the DEFAULT_USAGE_PROVIDERS provider ids from
 * packages/ai/src/auth-storage.ts (scanner-based; OMP code is never imported
 * or executed), and emits a deterministic sorted capability manifest.
 *
 * An OMP-derived locked provider missing from the checkout fails loudly. A newly
 * discovered provider is emitted excluded/external pending capability review —
 * sync never promotes support tier, authorization basis or polling policy.
 * App-owned providers are merged independently of OMP discovery.
 *
 * Usage:
 *   bun scripts/sync-omp-registry.ts --checkout <absolute-path> [--out <path>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { APP_OWNED_PROVIDER_IDS, OMP_PROVIDER_IDS, REGISTRY_VERSION, listProviderCapabilities } from "../src/registry";
import type { ProviderCapability } from "../src/registry";
import { extractIdentifierArray, extractNamedImports, extractObjectPropertyString } from "./omp-source-reader";

export const OMP_PINNED_SHA = "8500092296621a6826b7136e840f8a59ea338958";

export const OMP_SYNC_ERROR_KINDS = [
  "invalidCheckoutPath",
  "checkoutMissing",
  "headUnresolved",
  "shaMismatch",
  "registrySourceMissing",
  "providerUnresolved",
  "lockedProviderMissing",
] as const;
export type OmpSyncErrorKind = (typeof OMP_SYNC_ERROR_KINDS)[number];

export class OmpSyncError extends Error {
  readonly name = "OmpSyncError";
  readonly kind: OmpSyncErrorKind;

  constructor(kind: OmpSyncErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type DiscoveredOmpProvider = {
  readonly id: string;
  readonly adapterSourcePath: string;
};

export type ManifestProvider = Omit<ProviderCapability, "id"> & {
  readonly id: string;
  readonly pendingCapabilityReview?: true;
};

export type CapabilityManifest = {
  readonly schemaVersion: typeof REGISTRY_VERSION;
  readonly syncedFromSha: string;
  readonly providers: readonly ManifestProvider[];
};

export type SyncOmpRegistryOptions = {
  readonly checkoutPath: string;
  readonly resolveHeadSha?: (checkoutPath: string) => string;
  readonly discoverProviders?: (checkoutPath: string) => readonly DiscoveredOmpProvider[];
};

export function buildCapabilityManifest(input: {
  readonly discovered: readonly DiscoveredOmpProvider[];
  readonly headSha: string;
}): CapabilityManifest {
  const locked = new Map<string, ProviderCapability>(
    listProviderCapabilities().map((capability) => [capability.id, capability]),
  );
  const discoveredIds = new Set(input.discovered.map((provider) => provider.id));
  const missing = OMP_PROVIDER_IDS.filter((id) => !discoveredIds.has(id));
  if (missing.length > 0) {
    throw new OmpSyncError("lockedProviderMissing", `locked provider(s) missing from OMP checkout: ${missing.join(", ")}`);
  }
  const sorted = [...new Set([...discoveredIds, ...APP_OWNED_PROVIDER_IDS])].sort(compareIds);
  const providers: ManifestProvider[] = sorted.map((id) => {
    const capability = locked.get(id);
    return capability === undefined ? pendingEntry(id) : capability;
  });
  return { schemaVersion: REGISTRY_VERSION, syncedFromSha: input.headSha, providers };
}

export function syncOmpRegistry(options: SyncOmpRegistryOptions): CapabilityManifest {
  if (!isAbsolute(options.checkoutPath)) {
    throw new OmpSyncError(
      "invalidCheckoutPath",
      `checkout path must be absolute; pass --checkout <absolute-path> or OMP_CHECKOUT (got: ${options.checkoutPath})`,
    );
  }
  if (!existsSync(options.checkoutPath)) {
    throw new OmpSyncError("checkoutMissing", `OMP checkout not found at ${options.checkoutPath}`);
  }
  const resolveHeadSha = options.resolveHeadSha ?? gitHeadSha;
  const headSha = resolveHeadSha(options.checkoutPath);
  if (headSha !== OMP_PINNED_SHA) {
    throw new OmpSyncError("shaMismatch", `OMP checkout HEAD ${headSha} does not match the pinned ${OMP_PINNED_SHA}`);
  }
  const discoverProviders = options.discoverProviders ?? discoverOmpProviders;
  const discovered = discoverProviders(options.checkoutPath);
  return buildCapabilityManifest({ discovered, headSha });
}

function pendingEntry(id: string): ManifestProvider {
  return {
    id,
    supportTier: "excluded",
    connectorTransport: "external",
    authMethods: [],
    credentialKinds: [],
    productKind: "unreviewed",
    sourceKind: "unreviewed",
    authorizationBasis: "unreviewed",
    declaredUnit: "unknown",
    declaredWindows: [],
    pollingPolicy: "notPolled",
    pendingCapabilityReview: true,
  };
}

function compareIds(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function gitHeadSha(checkoutPath: string): string {
  const result = spawnSync("git", ["-C", checkoutPath, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new OmpSyncError("headUnresolved", `unable to resolve HEAD in ${checkoutPath}`);
  }
  return result.stdout.trim();
}

function discoverOmpProviders(checkoutPath: string): readonly DiscoveredOmpProvider[] {
  const registryPath = resolve(checkoutPath, "packages/ai/src/auth-storage.ts");
  if (!existsSync(registryPath)) {
    throw new OmpSyncError("registrySourceMissing", `OMP registry source not found at ${registryPath}`);
  }
  const source = readFileSync(registryPath, "utf8");
  const providerNames = extractIdentifierArray(source, "DEFAULT_USAGE_PROVIDERS");
  if (providerNames === undefined) {
    throw new OmpSyncError("registrySourceMissing", "DEFAULT_USAGE_PROVIDERS array not found in auth-storage.ts");
  }
  const imports = extractNamedImports(source);
  return providerNames.map((name) => {
    const specifier = imports.get(name);
    if (specifier === undefined || !specifier.startsWith("./")) {
      throw new OmpSyncError("providerUnresolved", `no relative import found for provider binding ${name}`);
    }
    const adapterPath = resolve(dirname(registryPath), `${specifier}.ts`);
    if (!existsSync(adapterPath)) {
      throw new OmpSyncError("providerUnresolved", `adapter source missing for ${name}: ${adapterPath}`);
    }
    const id = extractObjectPropertyString(readFileSync(adapterPath, "utf8"), name, "id");
    if (id === undefined) {
      throw new OmpSyncError("providerUnresolved", `provider id not found for ${name} in ${adapterPath}`);
    }
    return { id, adapterSourcePath: relative(checkoutPath, adapterPath) };
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const checkoutPath = flagValue(args, "--checkout") ?? process.env["OMP_CHECKOUT"] ?? "";
  const outPath = flagValue(args, "--out") ?? resolve(import.meta.dir, "../generated/provider-capabilities.json");
  try {
    const manifest = syncOmpRegistry({ checkoutPath });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(manifest, null, "\t")}\n`);
    console.log(`synced ${manifest.providers.length} providers from ${manifest.syncedFromSha.slice(0, 12)} to ${outPath}`);
  } catch (error) {
    const summary = error instanceof OmpSyncError ? `${error.kind}: ${error.message}` : String(error);
    console.error(`omp registry sync failed: ${summary}`);
    process.exitCode = 1;
  }
}

function flagValue(flags: readonly string[], name: string): string | undefined {
  for (let i = 0; i + 1 < flags.length; i++) {
    if (flags[i] === name) {
      return flags[i + 1];
    }
  }
  return undefined;
}
