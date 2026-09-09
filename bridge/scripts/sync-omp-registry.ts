/**
 * OMP registry sync.
 *
 * Reads exactly one configured absolute OMP checkout, verifies the pinned
 * source SHA and clean working tree, extracts DEFAULT_USAGE_PROVIDERS ids from
 * packages/ai/src/auth-storage.ts (scanner-based; OMP code is never imported
 * or executed), and emits a deterministic sorted capability manifest.
 *
 * An OMP-derived locked provider missing from the checkout fails loudly. A newly
 * discovered provider appears only in a separate pending discovery report —
 * sync never promotes support, registration, authorization or polling policy.
 * App-owned providers are merged independently of OMP discovery.
 *
 * Usage:
 *   bun scripts/sync-omp-registry.ts --checkout <absolute-path> [--discovery] [--out <path>]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { LOCKED_PROVIDER_IDS, OMP_PROVIDER_IDS, REGISTRY_VERSION, listProviderCapabilities } from "../src/registry";
import type { ProviderCapability } from "../src/registry";
import { extractIdentifierArray, extractNamedImports, extractObjectPropertyString } from "./omp-source-reader";

export const OMP_PINNED_SHA = "d720e81fb747132f0b6c6c0f44eafc887552ec7f";
export const DISCOVERY_VERSION = "1.0.0";

export const OMP_SYNC_ERROR_KINDS = [
  "invalidCheckoutPath",
  "checkoutMissing",
  "headUnresolved",
  "shaMismatch",
  "statusUnresolved",
  "dirtyCheckout",
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

export type CapabilityManifest = {
  readonly schemaVersion: typeof REGISTRY_VERSION;
  readonly syncedFromSha: string;
  readonly providers: readonly ProviderCapability[];
};

export type PendingDiscoveryReport = {
  readonly schemaVersion: typeof DISCOVERY_VERSION;
  readonly syncedFromSha: string;
  readonly pendingProviders: readonly (DiscoveredOmpProvider & {
    readonly reviewStatus: "pendingCapabilityReview";
  })[];
};

export type SyncOmpRegistryOptions = {
  readonly checkoutPath: string;
  readonly resolveHeadSha?: (checkoutPath: string) => string;
  readonly resolveCheckoutStatus?: (checkoutPath: string) => string;
  readonly discoverProviders?: (checkoutPath: string) => readonly DiscoveredOmpProvider[];
};

type DiscoveryInput = {
  readonly discovered: readonly DiscoveredOmpProvider[];
  readonly headSha: string;
};

function requireLockedProviders(discovered: readonly DiscoveredOmpProvider[]): void {
  const discoveredIds = new Set(discovered.map((provider) => provider.id));
  const missing = OMP_PROVIDER_IDS.filter((id) => !discoveredIds.has(id));
  if (missing.length > 0) {
    throw new OmpSyncError("lockedProviderMissing", `locked provider(s) missing from OMP checkout: ${missing.join(", ")}`);
  }
}

export function buildCapabilityManifest(input: DiscoveryInput): CapabilityManifest {
  requireLockedProviders(input.discovered);
  const providers = [...listProviderCapabilities()].sort((a, b) => compareIds(a.id, b.id));
  return { schemaVersion: REGISTRY_VERSION, syncedFromSha: input.headSha, providers };
}

export function buildPendingDiscoveryReport(input: DiscoveryInput): PendingDiscoveryReport {
  requireLockedProviders(input.discovered);
  const locked = new Set<string>(LOCKED_PROVIDER_IDS);
  const pendingProviders = input.discovered
    .filter(provider => !locked.has(provider.id))
    .map(({ id, adapterSourcePath }) => ({ id, adapterSourcePath, reviewStatus: "pendingCapabilityReview" as const }))
    .sort((a, b) => compareIds(a.id, b.id) || compareIds(a.adapterSourcePath, b.adapterSourcePath))
    .filter((provider, index, entries) => index === 0 || provider.id !== entries[index - 1]?.id ||
      provider.adapterSourcePath !== entries[index - 1]?.adapterSourcePath);
  return { schemaVersion: DISCOVERY_VERSION, syncedFromSha: input.headSha, pendingProviders };
}

export function syncOmpRegistry(options: SyncOmpRegistryOptions): CapabilityManifest {
  return buildCapabilityManifest(readCheckout(options));
}

export function syncOmpDiscovery(options: SyncOmpRegistryOptions): PendingDiscoveryReport {
  return buildPendingDiscoveryReport(readCheckout(options));
}

function readCheckout(options: SyncOmpRegistryOptions): DiscoveryInput {
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
  const status = (options.resolveCheckoutStatus ?? gitCheckoutStatus)(options.checkoutPath);
  if (status !== "") {
    throw new OmpSyncError("dirtyCheckout", `OMP checkout must be clean at ${OMP_PINNED_SHA}`);
  }
  const discoverProviders = options.discoverProviders ?? discoverOmpProviders;
  const discovered = discoverProviders(options.checkoutPath);
  return { discovered, headSha };
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

function gitCheckoutStatus(checkoutPath: string): string {
  const result = spawnSync("git", ["-C", checkoutPath, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new OmpSyncError("statusUnresolved", `unable to resolve working tree status in ${checkoutPath}`);
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
  const discovery = args.includes("--discovery");
  const outPath = flagValue(args, "--out") ?? resolve(import.meta.dir,
    discovery ? "../generated/provider-discovery.json" : "../generated/provider-capabilities.json");
  try {
    const manifest = discovery ? syncOmpDiscovery({ checkoutPath }) : syncOmpRegistry({ checkoutPath });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(manifest, null, "\t")}\n`);
    const count = "pendingProviders" in manifest ? manifest.pendingProviders.length : manifest.providers.length;
    console.log(`synced ${count} ${discovery ? "pending discoveries" : "providers"} from ${manifest.syncedFromSha.slice(0, 12)} to ${outPath}`);
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
