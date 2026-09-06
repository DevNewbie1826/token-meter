/**
 * Locked 17-provider capability registry (16 OMP-derived, one app-owned).
 *
 * REGISTRY_VERSION versions this capability manifest independently from the
 * TokenMeter bridge wire protocol (./protocol PROTOCOL_VERSION): the two may
 * drift apart on purpose, and `providers --format json` always emits this
 * registry version — never the wire version.
 *
 * OMP-derived labels are pinned from the token-meter research verdicts against OMP SHA
 * 8500092296621a6826b7136e840f8a59ea338958. Registry sync may confirm or add
 * source metadata, but it can never silently promote support tier,
 * authorization basis or polling policy. No model catalog fields exist here.
 *
 * connectorTransport "builtin-<providerId>" marks the provider as dispatched
 * by its builtin provider module (github-copilot keeps its legacy
 * "builtin-github-billing" transport). authMethods/credentialKinds mirror
 * what the module under ./providers actually implements.
 */

import type { ProductKind, ReportSourceKind, UsageUnit } from "./protocol";

/** Capability manifest version; separate from the TokenMeter wire version. */
export const REGISTRY_VERSION = "1.2.0";

export const OMP_PROVIDER_IDS = [
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
/** App-owned integrations are not required to appear in OMP discovery. */
export const APP_OWNED_PROVIDER_IDS = ["nekos"] as const;
export type LockedProviderId = (typeof OMP_PROVIDER_IDS)[number] | (typeof APP_OWNED_PROVIDER_IDS)[number];
export const LOCKED_PROVIDER_IDS: readonly LockedProviderId[] = [...OMP_PROVIDER_IDS, ...APP_OWNED_PROVIDER_IDS].sort();

export const SUPPORT_TIERS = ["supported", "bestEffort", "conditional", "excluded"] as const;
export type SupportTier = (typeof SUPPORT_TIERS)[number];

export const CONNECTOR_TRANSPORTS = [
  "builtin-github-billing",
  "builtin-alibaba-token-plan",
  "builtin-anthropic",
  "builtin-cursor",
  "builtin-google-antigravity",
  "builtin-google-gemini-cli",
  "builtin-kimi-code",
  "builtin-minimax-code",
  "builtin-nekos",
  "builtin-ollama",
  "builtin-ollama-cloud",
  "builtin-openai-codex",
  "builtin-opencode-go",
  "builtin-synthetic",
  "builtin-umans",
  "builtin-xai-oauth",
  "builtin-zai",
  "external",
] as const;
export type ConnectorTransport = (typeof CONNECTOR_TRANSPORTS)[number];

export const REGISTRY_AUTH_METHODS = ["apiKey", "browser", "device"] as const;
export type RegistryAuthMethod = (typeof REGISTRY_AUTH_METHODS)[number];

export const REGISTRY_CREDENTIAL_KINDS = ["none", "bearer", "apiKey", "oauth"] as const;
export type RegistryCredentialKind = (typeof REGISTRY_CREDENTIAL_KINDS)[number];

export type RegistryProductKind = ProductKind | "unreviewed";
export type RegistrySourceKind = ReportSourceKind | "unreviewed";

export const AUTHORIZATION_BASES = [
  "documentedUserBilling",
  "subscriptionOAuth",
  "apiKey",
  "browserSession",
  "deviceNone",
  "unreviewed",
] as const;
export type AuthorizationBasis = (typeof AUTHORIZATION_BASES)[number];

export const DECLARED_WINDOWS = ["3h", "5h", "7d", "daily", "weekly", "monthly"] as const;
export type DeclaredWindow = (typeof DECLARED_WINDOWS)[number];

export const POLLING_POLICIES = ["authorizedDefault", "notPolled"] as const;
export type PollingPolicy = (typeof POLLING_POLICIES)[number];

export type ProviderCapability = {
  readonly id: LockedProviderId;
  readonly supportTier: SupportTier;
  readonly connectorTransport: ConnectorTransport;
  readonly authMethods: readonly RegistryAuthMethod[];
  readonly credentialKinds: readonly RegistryCredentialKind[];
  readonly productKind: RegistryProductKind;
  readonly sourceKind: RegistrySourceKind;
  readonly authorizationBasis: AuthorizationBasis;
  readonly declaredUnit: UsageUnit;
  readonly declaredWindows: readonly DeclaredWindow[];
  readonly pollingPolicy: PollingPolicy;
};

const PROVIDER_CAPABILITIES: readonly ProviderCapability[] = [
  {
    id: "alibaba-token-plan",
    supportTier: "excluded",
    connectorTransport: "builtin-alibaba-token-plan",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "browserSession",
    authorizationBasis: "browserSession",
    declaredUnit: "percent",
    declaredWindows: ["5h", "7d"],
    pollingPolicy: "notPolled",
  },
  {
    id: "anthropic",
    supportTier: "excluded",
    connectorTransport: "builtin-anthropic",
    authMethods: ["browser"],
    credentialKinds: ["oauth"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "percent",
    declaredWindows: ["5h", "7d"],
    pollingPolicy: "notPolled",
  },
  {
    id: "cursor",
    supportTier: "excluded",
    connectorTransport: "builtin-cursor",
    authMethods: ["browser", "apiKey"],
    credentialKinds: ["oauth", "bearer"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "percent",
    declaredWindows: ["monthly"],
    pollingPolicy: "notPolled",
  },
  {
    id: "github-copilot",
    supportTier: "supported",
    connectorTransport: "builtin-github-billing",
    authMethods: ["apiKey", "device"],
    credentialKinds: ["bearer", "apiKey"],
    productKind: "billingUsage",
    sourceKind: "documentedApi",
    authorizationBasis: "documentedUserBilling",
    declaredUnit: "requests",
    declaredWindows: ["monthly"],
    pollingPolicy: "authorizedDefault",
  },
  {
    id: "google-antigravity",
    supportTier: "excluded",
    connectorTransport: "builtin-google-antigravity",
    authMethods: ["browser"],
    credentialKinds: ["oauth"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "percent",
    declaredWindows: ["daily", "weekly"],
    pollingPolicy: "notPolled",
  },
  {
    id: "google-gemini-cli",
    supportTier: "excluded",
    connectorTransport: "builtin-google-gemini-cli",
    authMethods: ["browser"],
    credentialKinds: ["oauth"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "percent",
    declaredWindows: [],
    pollingPolicy: "notPolled",
  },
  {
    id: "kimi-code",
    supportTier: "excluded",
    connectorTransport: "builtin-kimi-code",
    authMethods: ["device", "apiKey"],
    credentialKinds: ["oauth", "apiKey"],
    productKind: "quota",
    sourceKind: "firstPartyApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "unknown",
    declaredWindows: ["5h", "7d"],
    pollingPolicy: "notPolled",
  },
  {
    id: "minimax-code",
    supportTier: "conditional",
    connectorTransport: "builtin-minimax-code",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "firstPartyApi",
    authorizationBasis: "apiKey",
    declaredUnit: "percent",
    declaredWindows: ["weekly"],
    pollingPolicy: "notPolled",
  },
  {
    id: "nekos",
    supportTier: "bestEffort",
    connectorTransport: "builtin-nekos",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "firstPartyApi",
    authorizationBasis: "apiKey",
    declaredUnit: "percent",
    declaredWindows: ["3h", "daily", "weekly"],
    pollingPolicy: "notPolled",
  },
  {
    id: "ollama",
    supportTier: "conditional",
    connectorTransport: "builtin-ollama",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey", "none"],
    productKind: "localActivity",
    sourceKind: "noQuotaApi",
    authorizationBasis: "deviceNone",
    declaredUnit: "unknown",
    declaredWindows: [],
    pollingPolicy: "notPolled",
  },
  {
    id: "ollama-cloud",
    supportTier: "conditional",
    connectorTransport: "builtin-ollama-cloud",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "localActivity",
    sourceKind: "noQuotaApi",
    authorizationBasis: "deviceNone",
    declaredUnit: "unknown",
    declaredWindows: [],
    pollingPolicy: "notPolled",
  },
  {
    id: "openai-codex",
    supportTier: "excluded",
    connectorTransport: "builtin-openai-codex",
    authMethods: ["browser", "device"],
    credentialKinds: ["oauth"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "percent",
    declaredWindows: [],
    pollingPolicy: "notPolled",
  },
  {
    id: "opencode-go",
    supportTier: "bestEffort",
    connectorTransport: "builtin-opencode-go",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "firstPartyApi",
    authorizationBasis: "apiKey",
    declaredUnit: "percent",
    declaredWindows: ["5h", "7d", "monthly"],
    pollingPolicy: "notPolled",
  },
  {
    id: "synthetic",
    supportTier: "conditional",
    connectorTransport: "builtin-synthetic",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "firstPartyApi",
    authorizationBasis: "apiKey",
    declaredUnit: "requests",
    declaredWindows: ["5h", "7d"],
    pollingPolicy: "notPolled",
  },
  {
    id: "umans",
    supportTier: "conditional",
    connectorTransport: "builtin-umans",
    authMethods: ["apiKey"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "firstPartyApi",
    authorizationBasis: "apiKey",
    declaredUnit: "requests",
    declaredWindows: ["5h"],
    pollingPolicy: "notPolled",
  },
  {
    id: "xai-oauth",
    supportTier: "excluded",
    connectorTransport: "builtin-xai-oauth",
    authMethods: ["device"],
    credentialKinds: ["oauth"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "subscriptionOAuth",
    declaredUnit: "unknown",
    declaredWindows: ["weekly", "monthly"],
    pollingPolicy: "notPolled",
  },
  {
    id: "zai",
    supportTier: "conditional",
    connectorTransport: "builtin-zai",
    authMethods: ["apiKey", "browser"],
    credentialKinds: ["apiKey"],
    productKind: "quota",
    sourceKind: "privateApi",
    authorizationBasis: "apiKey",
    declaredUnit: "tokens",
    declaredWindows: ["5h", "7d"],
    pollingPolicy: "notPolled",
  },
];

export function listProviderCapabilities(): readonly ProviderCapability[] {
  return PROVIDER_CAPABILITIES;
}
