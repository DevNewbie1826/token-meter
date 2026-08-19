/**
 * TokenMeter/1.2.0 wire vocabulary: constants, closed types, the typed
 * BridgeError, response encoding, secret redaction and severity bands.
 * Request parsing lives in request-parse.ts; protocol.ts is the public
 * facade both are surfaced through. The login command's wire types live in
 * dispatch.ts next to the auth module contracts.
 */

export const PROTOCOL_FAMILY = "TokenMeter";
export const PROTOCOL_VERSION = "1.2.0";
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const USAGE_UNITS = ["percent", "tokens", "requests", "usd", "minutes", "bytes", "unknown"] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

export const SEVERITIES = ["ok", "warning", "critical", "exhausted", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const PRODUCT_KINDS = ["quota", "billingUsage", "organizationUsage", "localActivity"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const REPORT_SOURCE_KINDS = [
  "localObserved",
  "documentedApi",
  "firstPartyApi",
  "privateApi",
  "browserSession",
  "noQuotaApi",
] as const;
export type ReportSourceKind = (typeof REPORT_SOURCE_KINDS)[number];

export const CREDENTIAL_KINDS = ["none", "bearer", "apiKey", "oauth"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** OAuth token bundle carried by `kind: "oauth"` credentials. */
export type OAuthDetails = {
  /** Mirrors `secret`; both are redacted on every error message path. */
  readonly access: string;
  readonly refresh?: string;
  readonly expiresAtMs?: number;
  readonly refreshEndpoint?: string;
  readonly clientId?: string;
  /** Non-secret labels such as login, account id or project id. */
  readonly identity?: Readonly<Record<string, string>>;
};

export type NoCredential = {
  readonly kind: "none";
} & Readonly<Record<string, string>>;
// The string index keeps existing trusted connector internals source-
// compatible when they read `.secret` after dispatch's provider-specific guard.
// Untrusted wire values still pass through credentialFromValue, which accepts
// exactly `{kind:"none"}` and rejects every additional field.

export type StaticCredential = {
  readonly kind: "bearer" | "apiKey";
  readonly secret: string;
};

export type OAuthCredential = {
  readonly kind: "oauth";
  readonly secret: string;
  readonly oauth: OAuthDetails;
};

export type BridgeCredential = NoCredential | StaticCredential | OAuthCredential;

export const OPERATIONS = ["fetchUsage"] as const;
export type BridgeOperation = (typeof OPERATIONS)[number];

export const BRIDGE_ERROR_KINDS = [
  "invalidRequest",
  "invalidProtocol",
  "invalidProvider",
  "invalidPolicy",
  "missingCredential",
  "authRequired",
  "permissionDenied",
  "rateLimited",
  "noData",
  "transport",
  "timeout",
  "malformedPayload",
  "partialPayload",
  "upstreamError",
  "dependencyUnavailable",
  "internalError",
] as const;
export type BridgeErrorKind = (typeof BRIDGE_ERROR_KINDS)[number];

export type BridgeRequest = {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: BridgeOperation;
  readonly providerId: string;
  readonly connectorId: string;
  readonly accountRef: string;
  readonly requestedAtMs: number;
  readonly deadlineAtMs: number;
  readonly credential?: BridgeCredential;
};

export type UsageWindow = {
  readonly id: string;
  readonly label?: string;
  readonly unit: UsageUnit;
  readonly resolvedFraction?: number;
  readonly severity: Severity;
  readonly used?: number;
  readonly limit?: number;
  readonly resetsAtMs?: number;
  readonly resetCredits?: number;
};

export type UsageReport = {
  readonly productKind: ProductKind;
  readonly sourceKind: ReportSourceKind;
  readonly fetchedAtMs: number;
  readonly connectorVersion: string;
  readonly windows: readonly UsageWindow[];
};

export type BridgeErrorPayload = {
  readonly kind: BridgeErrorKind;
  readonly message: string;
  readonly retryAfterMs?: number;
};

export type BridgeSuccessResponse = {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly requestId: string;
  readonly providerId: string;
  readonly connectorId: string;
  readonly accountRef: string;
  readonly status: "ok";
  readonly completedAtMs: number;
  readonly report: UsageReport;
  /** Set only when the connector rotated an OAuth token during the fetch. */
  readonly refreshedCredential?: BridgeCredential;
};

export type BridgeErrorResponse = {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly requestId?: string;
  readonly providerId?: string;
  readonly connectorId?: string;
  readonly accountRef?: string;
  readonly status: "error";
  readonly completedAtMs: number;
  readonly error: BridgeErrorPayload;
  /** Set when a token rotated before the operation ultimately failed. */
  readonly refreshedCredential?: BridgeCredential;
};

export type BridgeResponse = BridgeSuccessResponse | BridgeErrorResponse;

/** Typed bridge failure. Messages must never embed credential material. */
export class BridgeError extends Error {
  readonly name = "BridgeError";
  readonly kind: BridgeErrorKind;
  readonly retryAfterMs?: number;
  readonly refreshedCredential?: BridgeCredential;

  constructor(
    kind: BridgeErrorKind,
    message: string,
    options?: {
      readonly retryAfterMs?: number | undefined;
      readonly refreshedCredential?: BridgeCredential | undefined;
    },
  ) {
    super(message);
    this.kind = kind;
    if (options?.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
    if (options?.refreshedCredential !== undefined) {
      this.refreshedCredential = options.refreshedCredential;
    }
  }
}

const CREDENTIAL_KIND_SET: ReadonlySet<string> = new Set(CREDENTIAL_KINDS);
const USAGE_UNIT_SET: ReadonlySet<string> = new Set(USAGE_UNITS);

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === "string" && CREDENTIAL_KIND_SET.has(value);
}

export function isUsageUnit(value: unknown): value is UsageUnit {
  return typeof value === "string" && USAGE_UNIT_SET.has(value);
}

/** Narrows an unknown JSON value to a plain record (not array, not null). */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeBridgeResponse(response: BridgeResponse): string {
  const encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RESPONSE_BYTES) {
    throw new BridgeError("invalidProtocol", `response exceeds the ${MAX_RESPONSE_BYTES}-byte framing limit`);
  }
  return encoded;
}

/** Every secret string a credential can contribute to an error message path. */
export function credentialSecrets(credential: BridgeCredential | undefined): readonly string[] {
  if (credential === undefined) {
    return [];
  }
  if (credential.kind === "none") {
    return [];
  }
  const secrets = [credential.secret];
  if (credential.kind === "oauth") {
    secrets.push(credential.oauth.access);
    if (credential.oauth.refresh !== undefined) {
      secrets.push(credential.oauth.refresh);
    }
  }
  return [...new Set(secrets.filter((secret) => secret !== ""))];
}

/** Replaces every occurrence of each known secret with a redaction marker. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret !== "") {
      redacted = redacted.split(secret).join("[redacted]");
    }
  }
  return redacted;
}

/** Severity bands: <0.80 ok, >=0.80 warning, >=0.95 critical, >=1 exhausted. */
export function severityForFraction(fraction: number | undefined): Severity {
  if (fraction === undefined) {
    return "unknown";
  }
  if (fraction >= 1) {
    return "exhausted";
  }
  if (fraction >= 0.95) {
    return "critical";
  }
  if (fraction >= 0.8) {
    return "warning";
  }
  return "ok";
}

const FRACTION_EPSILON = 1e-9;

/** Shared consistency tolerance for explicit fraction vs used/limit amounts. */
export function fractionsConsistent(fraction: number, used: number, limit: number): boolean {
  return Math.abs(fraction - used / limit) <= FRACTION_EPSILON;
}
