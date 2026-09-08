/**
 * xAI SuperGrok (xai-oauth) provider module (device-flow auth + usage
 * connector), hand-ported from the pinned oh-my-pi checkout @
 * 8500092296621a6826b7136e840f8a59ea338958:
 * Reviewed against d720e81fb747132f0b6c6c0f44eafc887552ec7f: billing
 * normalization is unchanged upstream; retain the stricter pinned device flow.
 *
 * - packages/ai/src/registry/oauth/xai-oauth.ts (OIDC discovery, RFC 8628
 *   device authorization + token polling, token refresh, x.ai/grok.com
 *   endpoint pinning, JWT subject parsing, userinfo identity)
 * - packages/ai/src/usage/xai-oauth.ts          (billing fetch + normalization)
 * - packages/ai/src/usage/shared.ts             (usageStatus bands, parseIsoTimestamp)
 * - packages/catalog/src/utils.ts               (toNumber)
 *
 * Kept from the OMP sources (same endpoints, client id, scopes, request
 * bodies and normalization boundaries):
 * - Auth: GET https://auth.x.ai/.well-known/openid-configuration discovery
 *   (token_endpoint pinned to https on x.ai / *.x.ai), RFC 8628 device flow
 *   against https://auth.x.ai/oauth2/device/code with client id
 *   b1a00492-073a-47ea-816f-4c329264a828 and scope "openid profile email
 *   offline_access grok-cli:access api:access" (verbatim), strict device-code
 *   response parsing (device_code / user_code / verification_uri /
 *   verification_uri_complete / expires_in > 0 / interval > 0 all required,
 *   both verification URIs pinned to x.ai), token polling with
 *   authorization_pending / slow_down handling, refresh_token required in
 *   token responses (with the previous refresh token as fallback), the
 *   5-minute ACCESS_TOKEN_CLIENT_SKEW_MS on absolute expiries, and the
 *   best-effort https://auth.x.ai/oauth2/userinfo identity (sub/email,
 *   email lowercased) stored with the credential.
 * - Refresh: re-runs OIDC discovery, then POSTs grant_type=refresh_token +
 *   client_id + refresh_token to the discovered token endpoint.
 * - Usage: GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *   (legacy weekly shape) with Authorization Bearer + Accept +
 *   X-XAI-Token-Auth: xai-grok-cli, probing the paramless monthly shape for
 *   unified-billing accounts; normalization emits xai-oauth:credits:1w
 *   (creditUsagePercent), xai-oauth:product:<slug>:1w rows (unit "percent",
 *   used = percent, limit = 100), xai-oauth:included:1mo (monthlyLimit/used,
 *   unit "unknown" — xAI does not label it) and the optional
 *   xai-oauth:on-demand row (unit "unknown"), with the unified-account
 *   inferred-weekly / confirmsNoMonthlyQuota resolution, weekly periods
 *   defaulting an omitted creditUsagePercent to 0 while still active, and
 *   dedup by id (keep first). Severity uses shared bridge/Swift bands instead
 *   of OMP's incompatible ladder. API-key credentials are rejected outright:
 *   paid xAI API keys are a separate product and must
 *   never be sent to the CLI billing proxy (OMP supports() gate).
 *
 * Deviations from the OMP sources (with reasons):
 * - OMP UsageLimit scope/metadata/raw, window durationMs and monthly labels
 *   have no bridge equivalents. Derived remaining amounts are not duplicated;
 *   the bridge retains the source used/limit values. Window ids keep OMP's limit
 *   ids verbatim. OMP's fetchUsage userinfo enrichment feeds only that
 *   metadata; the bridge surfaces identity solely through
 *   refreshedCredential, so the userinfo result (fetched only when the
 *   stored credential lacks an email, exactly like OMP) is merged into a
 *   rotated credential's identity — OMP's refresh-time withXAIOAuthIdentity
 *   outcome — and otherwise discarded.
 * - OMP's null-report outcomes become typed BridgeErrors: HTTP failures map
 *   through callProviderHttp (401 -> authRequired, 429 -> rateLimited, ...),
 *   unusable billing shapes -> noData. Independent transport/upstream/body
 *   failures permit useful weekly/monthly fallback; with no usable rows the
 *   original error survives. Auth, permission, rate-limit and parent deadline
 *   failures remain fatal. OMP's expired-token skip probe is
 *   replaced by the bridge rotation contract: rotate before the first call
 *   when expiresAtMs is missing or within 60s (and refresh material exists),
 *   rotate once and retry once on a mid-flow 401. A successful rotation is
 *   never dropped: when the retried billing probe fails, the failure carries
 *   refreshedCredential on the error envelope so the caller persists the
 *   rotated bundle before surfacing the error.
 * - The weekly inferred-percent default compares the period end against the
 *   fetch's nowMs (not Date.now()) so bridge responses are deterministic;
 *   rotation likewise mints expiresAtMs from nowMs.
 * - OMP's per-request 15s (discovery/userinfo) and 20s (token) timeouts are
 *   kept on the auth path, combined with the login AbortSignal via
 *   AbortSignal.any. Usage identity has its own optional 15s bound within the
 *   bridge deadline; remaining connector calls use the bridge deadline.
 *   Parent cancellation never becomes optional identity success.
 * - Credential-bearing userinfo, token polling, refresh and billing calls
 *   reject redirects, including calls through callProviderHttp.
 * - The device flow drives the shared poll engine in ../auth/device
 *   (pollOAuthDeviceCodeFlow) with OMP xai's own request/parse boundaries
 *   instead of runDeviceAuthorizationFlow, whose parser applies kimi's
 *   looser defaults (verification_uri_complete fallback, 15-min/5-s
 *   defaults, optional refresh_token); OMP xai's parser is stricter.
 */

import { DeviceFlowCancelledError, DeviceFlowFailedError, pollOAuthDeviceCodeFlow } from "../auth/device";
import type { OAuthDeviceCodePollResult } from "../auth/device";
import { rethrowWithRefreshedCredential } from "../auth/refresh";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type {
  BridgeSuccessResponse,
  OAuthCredential,
  UsageReport,
  UsageWindow,
} from "../protocol";

const PROVIDER_ID = "xai-oauth";
const CONNECTOR_VERSION = "xai-oauth-1";

// Fixed xAI OAuth constants, verbatim from OMP registry/oauth/xai-oauth.ts @ 8500092.
const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const XAI_OAUTH_USERINFO_URL = `${XAI_OAUTH_ISSUER}/oauth2/userinfo`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_CLI_BILLING_BASE_URL = "https://cli-chat-proxy.grok.com";
const XAI_CLI_BILLING_PATH = "/v1/billing";
const XAI_CLI_BILLING_FORMAT = "credits";

/** OMP ACCESS_TOKEN_CLIENT_SKEW_MS: mint absolute expiries five minutes early. */
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
/** OMP DISCOVERY_TIMEOUT_MS. */
const DISCOVERY_TIMEOUT_MS = 15_000;
/** OMP TOKEN_REQUEST_TIMEOUT_MS (device-auth and token requests). */
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
/** Bridge wire contract: pre-rotate when expiry is missing or within 60s. */
const ROTATION_THRESHOLD_MS = 60 * 1000;

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_CANCEL_MESSAGE = "Login cancelled";

const platformFetch: Fetcher = (url, init) => fetch(url, init);

// ---------------------------------------------------------------------------
// Shared helpers (OMP usage/shared.ts + catalog/src/utils.ts toNumber)
// ---------------------------------------------------------------------------

/** OMP toNumber (pi-catalog/utils): finite numbers and numeric strings. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** OMP usage/shared.ts parseIsoTimestamp. */
function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    // Ignore body-read failures; the status code is the diagnostic.
    return "";
  }
}

// ---------------------------------------------------------------------------
// Endpoint pinning (OMP validateXAIEndpoint / validateXAIBillingEndpoint)
// ---------------------------------------------------------------------------

/** Auth endpoints live on the OIDC issuer, not the billing proxy host. */
function isXaiAuthHostname(host: string): boolean {
  return host === "x.ai" || host.endsWith(".x.ai");
}

/** SuperGrok CLI billing proxy host, intentionally not on *.x.ai. */
function isXaiBillingHostname(host: string): boolean {
  return host === "grok.com" || host.endsWith(".grok.com");
}

function isXaiEndpoint(url: string, field: string, isHostAllowed: (host: string) => boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeError("malformedPayload", `Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new BridgeError("malformedPayload", `Invalid xAI ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "" || !isHostAllowed(host)) {
    throw new BridgeError("malformedPayload", `Invalid xAI ${field}: ${url}`);
  }
  return url;
}

/** OMP validateXAIEndpoint: HTTPS on x.ai / *.x.ai. */
function validateXaiAuthEndpoint(url: string, field: string): string {
  return isXaiEndpoint(url, field, isXaiAuthHostname);
}

/** OMP validateXAIBillingEndpoint: HTTPS on grok.com / *.grok.com. */
function validateXaiBillingEndpoint(url: string, field: string = "billing_url"): string {
  return isXaiEndpoint(url, field, isXaiBillingHostname);
}

// ---------------------------------------------------------------------------
// Access-token JWT helpers (OMP parseXAIAccessTokenPayload / extractSubject)
// ---------------------------------------------------------------------------

function parseXaiAccessTokenPayload(jwt: string): Record<string, unknown> | null {
  try {
    if (typeof jwt !== "string" || !jwt.includes(".")) return null;
    const parts = jwt.split(".");
    const payloadPart = parts.length >= 2 ? parts[1] : undefined;
    if (payloadPart === undefined || payloadPart === "") return null;
    const decoded: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    return isRecord(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** Stable xAI subject UUID from the access-token JWT (unverified signature). */
function extractXaiAccessTokenSubject(jwt: string): string | undefined {
  const sub = parseXaiAccessTokenPayload(jwt)?.["sub"];
  return typeof sub === "string" && sub.trim() !== "" ? sub.trim() : undefined;
}

// ---------------------------------------------------------------------------
// OIDC discovery + userinfo identity (OMP xaiOAuthDiscovery / fetchXAIOAuthIdentity)
// ---------------------------------------------------------------------------

/** Fetch xAI's OIDC discovery document and return the validated token endpoint. */
async function discoverXaiTokenEndpoint(fetcher: Fetcher, signal: AbortSignal): Promise<string> {
  const response = await callProviderHttp({
    call: {
      url: XAI_OAUTH_DISCOVERY_URL,
      method: "GET",
      headers: { Accept: "application/json" },
    },
    fetcher,
    signal,
    endpointLabel: "xAI OIDC discovery",
  });
  const payload = await response.json();
  if (!isRecord(payload)) {
    throw new BridgeError("malformedPayload", "xAI OIDC discovery response was not a JSON object.");
  }
  const tokenEndpoint = typeof payload["token_endpoint"] === "string" ? payload["token_endpoint"].trim() : "";
  if (tokenEndpoint === "") {
    throw new BridgeError("malformedPayload", "xAI OIDC discovery response was missing token_endpoint.");
  }
  return validateXaiAuthEndpoint(tokenEndpoint, "token_endpoint");
}

type XaiIdentity = {
  readonly accountId?: string;
  readonly email?: string;
};

/**
 * Best-effort OIDC userinfo for a valid access token (OMP fetchXAIOAuthIdentity):
 * Identity-only HTTP failures are optional; parent cancellation is not.
 */
async function fetchXaiIdentity(
  accessToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  timeoutSignal: (ms: number) => AbortSignal = AbortSignal.timeout,
): Promise<XaiIdentity | null> {
  const token = accessToken.trim();
  if (token === "") return null;
  try {
    const response = await callProviderHttp({
      call: {
        url: XAI_OAUTH_USERINFO_URL,
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      fetcher,
      signal: AbortSignal.any([signal, timeoutSignal(DISCOVERY_TIMEOUT_MS)]),
      endpointLabel: "xAI OIDC userinfo",
      extraSecrets: [token],
    });
    const payload = await response.json();
    if (signal.aborted) throw new BridgeError("timeout", "xAI identity lookup was cancelled");
    if (!isRecord(payload)) return null;
    const sub = typeof payload["sub"] === "string" && payload["sub"].trim() !== "" ? payload["sub"].trim() : undefined;
    const email = typeof payload["email"] === "string" && payload["email"].trim() !== "" ? payload["email"].trim() : undefined;
    const name = typeof payload["name"] === "string" && payload["name"].trim() !== "" ? payload["name"].trim() : undefined;
    if (sub === undefined && email === undefined && name === undefined) return null;
    // OMP keeps name for the presence check but stores only accountId/email.
    return {
      ...(sub !== undefined ? { accountId: sub } : {}),
      ...(email !== undefined ? { email: email.toLowerCase() } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw new BridgeError("timeout", "xAI identity lookup was cancelled");
    if (error instanceof BridgeError) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Billing endpoint helpers (OMP buildXAICliBillingUrl / getXAICliBillingHeaders)
// ---------------------------------------------------------------------------

/** SuperGrok CLI billing URL; format "" omits the param (unified monthly payload). */
export function buildXaiCliBillingUrl(format: string = XAI_CLI_BILLING_FORMAT): string {
  const url = new URL(XAI_CLI_BILLING_PATH, XAI_CLI_BILLING_BASE_URL);
  if (format !== "") url.searchParams.set("format", format);
  return validateXaiBillingEndpoint(url.toString());
}

const CREDITS_BILLING_URL = buildXaiCliBillingUrl();
const MONTHLY_BILLING_URL = buildXaiCliBillingUrl("");

/**
 * Headers for cli-chat-proxy.grok.com: the official Grok CLI also sends
 * X-XAI-Token-Auth so billing stays on the same product gate as chat.
 */
function getXaiCliBillingHeaders(accessToken: string): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "X-XAI-Token-Auth": "xai-grok-cli",
  };
}

// ---------------------------------------------------------------------------
// Billing normalization (OMP usage/xai-oauth.ts parse* + buildLimits)
// ---------------------------------------------------------------------------

interface XaiBillingPeriod {
  readonly start: string;
  readonly end: string;
  readonly type: string;
}

interface XaiProductUsage {
  readonly product: string;
  readonly usagePercent: number;
}

/** Legacy SuperGrok weekly credits (?format=credits). */
interface XaiWeeklyBillingConfig {
  readonly kind: "weekly";
  readonly currentPeriod: XaiBillingPeriod;
  readonly creditUsagePercent: number;
  readonly productUsage: readonly XaiProductUsage[];
  readonly onDemandCap?: number;
  readonly onDemandUsed?: number;
  readonly inferredPercent: boolean;
}

/** Unified-billing monthly included quota (default billing URL). */
interface XaiMonthlyBillingConfig {
  readonly kind: "monthly";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly used: number;
  readonly limit: number;
  readonly onDemandCap?: number;
  readonly onDemandUsed?: number;
}

function parsePercent(value: unknown): number | undefined {
  const percent = toNumber(value);
  return percent !== undefined && percent >= 0 && percent <= 100 ? percent : undefined;
}

/** OMP parseOnDemandAmount: { val: number } records, non-negative. */
function parseOnDemandAmount(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const amount = toNumber(value["val"]);
  return amount !== undefined && amount >= 0 ? amount : undefined;
}

function slugifyProduct(product: string): string {
  return product
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseWeeklyBillingConfig(raw: Record<string, unknown>, nowMs: number): XaiWeeklyBillingConfig | null {
  const currentPeriod = raw["currentPeriod"];
  if (!isRecord(currentPeriod)) return null;

  const start = typeof currentPeriod["start"] === "string" ? parseIsoTimestamp(currentPeriod["start"]) : undefined;
  const end = typeof currentPeriod["end"] === "string" ? parseIsoTimestamp(currentPeriod["end"]) : undefined;
  const type = typeof currentPeriod["type"] === "string" ? currentPeriod["type"] : "";
  // Keep recently-ended weekly windows so usage still renders across period
  // rollover while the billing API is mid-refresh (OMP rule). Reject only
  // inverted ranges and non-weekly period types.
  if (start === undefined || end === undefined || end <= start || !type.toUpperCase().includes("WEEK")) {
    return null;
  }

  // Fresh weekly periods (or accounts with 0 usage) omit creditUsagePercent;
  // default to 0 only while the weekly period is active. Expired periods
  // without explicit usage data are rejected to retain last good cache.
  const inferredPercent = raw["creditUsagePercent"] === undefined || raw["creditUsagePercent"] === null;
  let creditUsagePercent: number | undefined;
  if (inferredPercent) {
    creditUsagePercent = end > nowMs ? 0 : undefined;
  } else {
    creditUsagePercent = parsePercent(raw["creditUsagePercent"]);
  }
  if (creditUsagePercent === undefined) return null;

  const productUsage: XaiProductUsage[] = [];
  if (raw["productUsage"] !== undefined) {
    if (!Array.isArray(raw["productUsage"])) return null;
    for (const item of raw["productUsage"]) {
      if (!isRecord(item)) continue;
      const product = typeof item["product"] === "string" ? item["product"].trim() : "";
      const usagePercent =
        item["usagePercent"] === undefined || item["usagePercent"] === null
          ? 0
          : parsePercent(item["usagePercent"]);
      if (product === "" || usagePercent === undefined) continue;
      productUsage.push({ product, usagePercent });
    }
  }

  const onDemandCap = parseOnDemandAmount(raw["onDemandCap"]);
  const onDemandUsed = parseOnDemandAmount(raw["onDemandUsed"]);
  return {
    kind: "weekly",
    currentPeriod: {
      start: currentPeriod["start"] as string,
      end: currentPeriod["end"] as string,
      type,
    },
    creditUsagePercent,
    productUsage,
    ...(onDemandCap !== undefined ? { onDemandCap } : {}),
    ...(onDemandUsed !== undefined ? { onDemandUsed } : {}),
    inferredPercent,
  };
}

function parseMonthlyBillingConfig(raw: Record<string, unknown>): XaiMonthlyBillingConfig | null {
  const periodStart = typeof raw["billingPeriodStart"] === "string" ? raw["billingPeriodStart"] : "";
  const periodEnd = typeof raw["billingPeriodEnd"] === "string" ? raw["billingPeriodEnd"] : "";
  const startMs = parseIsoTimestamp(periodStart);
  const endMs = parseIsoTimestamp(periodEnd);
  if (periodStart === "" || periodEnd === "" || startMs === undefined || endMs === undefined || endMs <= startMs) {
    return null;
  }

  const limit = parseOnDemandAmount(raw["monthlyLimit"]);
  const used = parseOnDemandAmount(raw["used"]);
  // Require a positive included quota; zero/missing is not a usable report.
  if (limit === undefined || limit <= 0 || used === undefined) return null;

  const onDemandCap = parseOnDemandAmount(raw["onDemandCap"]);
  const onDemandUsed = parseOnDemandAmount(raw["onDemandUsed"]);
  return {
    kind: "monthly",
    periodStart,
    periodEnd,
    used,
    limit,
    ...(onDemandCap !== undefined ? { onDemandCap } : {}),
    ...(onDemandUsed !== undefined ? { onDemandUsed } : {}),
  };
}

/** OMP confirmsNoMonthlyQuota: an explicit zero cap, or an inferred weekly shape. */
function confirmsNoMonthlyQuota(raw: Record<string, unknown>, nowMs: number): boolean {
  const limit = parseOnDemandAmount(raw["monthlyLimit"]);
  if (limit !== undefined) return limit === 0;
  // Some weekly accounts return the credits shape from the default endpoint too.
  return parseWeeklyBillingConfig(raw, nowMs)?.inferredPercent === true;
}

/** OMP buildPercentAmount: used = percent, limit = 100, fraction = percent/100. */
function percentWindow(id: string, label: string, usagePercent: number, resetsAtMs: number | undefined): UsageWindow {
  const resolvedFraction = usagePercent / 100;
  return {
    id,
    label,
    unit: "percent",
    resolvedFraction,
    severity: severityForFraction(resolvedFraction),
    used: usagePercent,
    limit: 100,
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

/** OMP product label mapping: GrokBuild -> "Grok Build", Api -> "API". */
function productLabel(product: string): string {
  if (product === "GrokBuild") return "Grok Build";
  if (product === "Api") return "API";
  return product;
}

/** OMP buildOnDemandLimit: cap must be positive and used known; unit unknown. */
function buildOnDemandWindow(onDemandCap: number | undefined, onDemandUsed: number | undefined): UsageWindow | undefined {
  if (onDemandCap === undefined || onDemandCap <= 0 || onDemandUsed === undefined) return undefined;
  const resolvedFraction = Math.min(onDemandUsed / onDemandCap, 1);
  return {
    id: `${PROVIDER_ID}:on-demand`,
    label: "On-demand",
    unit: "unknown",
    resolvedFraction,
    severity: severityForFraction(resolvedFraction),
    used: onDemandUsed,
    limit: onDemandCap,
  };
}

function buildWeeklyWindows(config: XaiWeeklyBillingConfig): UsageWindow[] {
  const resetsAtMs = parseIsoTimestamp(config.currentPeriod.end);
  const windows: UsageWindow[] = [
    percentWindow(`${PROVIDER_ID}:credits:1w`, "SuperGrok Weekly Credits", config.creditUsagePercent, resetsAtMs),
  ];
  for (const item of config.productUsage) {
    const slug = slugifyProduct(item.product);
    if (slug === "") continue;
    windows.push(
      percentWindow(
        `${PROVIDER_ID}:product:${slug}:1w`,
        `${productLabel(item.product)} (Weekly)`,
        item.usagePercent,
        resetsAtMs,
      ),
    );
  }
  const onDemand = buildOnDemandWindow(config.onDemandCap, config.onDemandUsed);
  if (onDemand !== undefined) windows.push(onDemand);
  return windows;
}

function buildMonthlyWindows(config: XaiMonthlyBillingConfig): UsageWindow[] {
  const startMs = parseIsoTimestamp(config.periodStart);
  const endMs = parseIsoTimestamp(config.periodEnd);
  // parseMonthlyBillingConfig already rejected inverted/unparseable ranges.
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return [];
  const resolvedFraction = Math.min(config.used / config.limit, 1);
  const windows: UsageWindow[] = [
    {
      id: `${PROVIDER_ID}:included:1mo`,
      label: "SuperGrok Monthly Included",
      // xAI does not label the unit; amounts match the dashboard quota points.
      unit: "unknown",
      resolvedFraction,
      severity: severityForFraction(resolvedFraction),
      used: config.used,
      limit: config.limit,
      resetsAtMs: endMs,
    },
  ];
  const onDemand = buildOnDemandWindow(config.onDemandCap, config.onDemandUsed);
  if (onDemand !== undefined) windows.push(onDemand);
  return windows;
}

function billingConfig(payload: unknown): Record<string, unknown> | null {
  return isRecord(payload) && isRecord(payload["config"]) ? payload["config"] : null;
}

/**
 * Probe the CLI billing endpoint and normalize to bridge windows (OMP
 * fetchUsage body): always weekly credits first, then the monthly shape when
 * credits are missing/unusable or the account is marked unified, with the
 * unified-account inferred-weekly resolution and id dedup (keep first).
 */
async function fetchBillingWindows(
  accessToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  nowMs: number,
): Promise<UsageWindow[]> {
  let recoverableError: BridgeError | undefined;
  const fetchBillingPayload = async (url: string): Promise<unknown> => {
    try {
      const response = await callProviderHttp({
        call: { url, method: "GET", headers: getXaiCliBillingHeaders(accessToken), redirect: "error" },
        fetcher,
        signal,
        endpointLabel: "xAI CLI billing",
        extraSecrets: [accessToken],
      });
      return await response.json();
    } catch (error) {
      // Only independent endpoint failures permit fallback. In particular,
      // 401 must reach the one-rotation retry, and parent cancellation is fatal.
      if (!(error instanceof BridgeError) || signal.aborted || ![
        "upstreamError", "transport", "malformedPayload", "timeout",
      ].includes(error.kind)) {
        throw error;
      }
      recoverableError ??= error;
      return null;
    }
  };

  // Always probe weekly credits first (legacy SuperGrok shape).
  const creditsPayload = await fetchBillingPayload(CREDITS_BILLING_URL);
  const creditsConfig = billingConfig(creditsPayload);
  const weekly = creditsConfig === null ? null : parseWeeklyBillingConfig(creditsConfig, nowMs);
  const creditsLooksUnified = creditsConfig !== null && creditsConfig["isUnifiedBillingUser"] === true;

  // Unified accounts expose a separate monthly included-quota payload on the
  // default billing URL. Fetch it when credits are missing/unusable, or when
  // credits itself marks the account unified (live responses sometimes
  // include both shapes). OMP's monthlyUrl !== creditsUrl guard is trivially
  // true for the pinned format values.
  let monthlyPayload: unknown = null;
  let monthly: XaiMonthlyBillingConfig | null = null;
  if (!weekly || creditsLooksUnified) {
    monthlyPayload = await fetchBillingPayload(MONTHLY_BILLING_URL);
    const monthlyConfig = billingConfig(monthlyPayload);
    monthly = monthlyConfig === null ? null : parseMonthlyBillingConfig(monthlyConfig);
  }

  // When an account is marked unified billing and weekly credits were only
  // inferred from an omitted percentage field: a positive monthly quota wins
  // outright; a valid monthly config that confirms no monthly quota keeps the
  // weekly reset cycle; anything else drops the inferred weekly.
  let effectiveWeekly = weekly;
  if (weekly !== null && weekly.inferredPercent && creditsLooksUnified) {
    if (monthly !== null) {
      effectiveWeekly = null;
    } else {
      const monthlyConfig = billingConfig(monthlyPayload);
      if (monthlyConfig === null || !confirmsNoMonthlyQuota(monthlyConfig, nowMs)) {
        effectiveWeekly = null;
      }
    }
  }

  const windows: UsageWindow[] = [];
  if (effectiveWeekly !== null) windows.push(...buildWeeklyWindows(effectiveWeekly));
  if (monthly !== null) windows.push(...buildMonthlyWindows(monthly));
  if (windows.length === 0 && recoverableError !== undefined) throw recoverableError;
  // Deduplicate on-demand if both shapes carried the same cap (keep first).
  const seen = new Set<string>();
  return windows.filter((window) => {
    if (seen.has(window.id)) return false;
    seen.add(window.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Token refresh (OMP refreshXAIOAuthToken via the bridge rotation contract)
// ---------------------------------------------------------------------------

/** OMP parseXAITokenResponse fields; `error` carries the exact OMP message. */
type XaiTokenParse =
  | { readonly error: string }
  | { readonly access: string; readonly refresh: string; readonly expiresInSeconds: number };

function parseXaiTokenPayload(payload: unknown, label: string, refreshTokenFallback?: string): XaiTokenParse {
  if (!isRecord(payload)) {
    return { error: `${label} was not a JSON object` };
  }
  const accessToken = typeof payload["access_token"] === "string" ? payload["access_token"] : "";
  const responseRefreshToken = typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : "";
  const refreshToken = responseRefreshToken !== "" ? responseRefreshToken : refreshTokenFallback ?? "";
  const expiresInSeconds = payload["expires_in"];
  if (accessToken === "") {
    return { error: `${label} missing access_token` };
  }
  if (refreshToken === "") {
    return { error: `${label} missing refresh_token` };
  }
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
    return { error: `${label} missing expires_in` };
  }
  return { access: accessToken, refresh: refreshToken, expiresInSeconds };
}

function hasRefreshMaterial(oauth: OAuthCredential["oauth"]): boolean {
  return oauth.refresh !== undefined && oauth.refreshEndpoint !== undefined;
}

function needsPreRotation(oauth: OAuthCredential["oauth"], nowMs: number): boolean {
  return (
    (oauth.expiresAtMs === undefined || oauth.expiresAtMs <= nowMs + ROTATION_THRESHOLD_MS) &&
    hasRefreshMaterial(oauth)
  );
}

/** Merge identity back into a credential (OMP withXAIOAuthIdentity outcome). */
function withXaiIdentity(
  credential: OAuthCredential,
  accountId: string | undefined,
  email: string | undefined,
): OAuthCredential {
  if (accountId === undefined && email === undefined) {
    return credential;
  }
  return {
    ...credential,
    oauth: {
      ...credential.oauth,
      identity: {
        ...credential.oauth.identity,
        ...(accountId !== undefined ? { accountId } : {}),
        ...(email !== undefined ? { email } : {}),
      },
    },
  };
}

/**
 * Rotate the OAuth token exactly as OMP refreshXAIOAuthToken: re-run OIDC
 * discovery (re-validating the token endpoint before sending the stored
 * refresh token), then POST grant_type=refresh_token + client_id +
 * refresh_token. The response refresh token wins, the previous one is the
 * fallback; the new expiry is minted five minutes early.
 */
async function rotateXaiToken(input: {
  readonly credential: OAuthCredential;
  readonly fetcher: Fetcher;
  readonly signal: AbortSignal;
  readonly nowMs: number;
}): Promise<OAuthCredential> {
  const oauth = input.credential.oauth;
  if (oauth.refresh === undefined || oauth.refreshEndpoint === undefined) {
    throw new BridgeError("authRequired", "xAI token refresh requires a refresh token and refresh endpoint");
  }
  const tokenEndpoint = await discoverXaiTokenEndpoint(input.fetcher, input.signal);
  const response = await callProviderHttp({
    call: {
      url: tokenEndpoint,
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: oauth.refresh,
      }).toString(),
    },
    fetcher: input.fetcher,
    signal: input.signal,
    endpointLabel: "xAI token refresh",
    extraSecrets: [oauth.access, oauth.refresh],
  });

  const parsed = parseXaiTokenPayload(await response.json(), "xAI token refresh response", oauth.refresh);
  if ("error" in parsed) {
    throw new BridgeError("authRequired", parsed.error);
  }
  return {
    kind: "oauth",
    secret: parsed.access,
    oauth: {
      access: parsed.access,
      refresh: parsed.refresh,
      expiresAtMs: input.nowMs + parsed.expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
      refreshEndpoint: tokenEndpoint,
      clientId: oauth.clientId ?? XAI_OAUTH_CLIENT_ID,
      ...(oauth.identity !== undefined ? { identity: oauth.identity } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Usage connector (OMP usage/xai-oauth.ts fetchUsage)
// ---------------------------------------------------------------------------

/** Provider-local clock seam; the registered connector uses native deadlines. */
export const createXaiOauthConnector = (
  timeoutSignal: (ms: number) => AbortSignal = AbortSignal.timeout,
): ConnectorModule => ({
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    const credential = request.credential;
    if (credential === undefined) {
      throw new BridgeError("missingCredential", "xai-oauth usage requires a credential");
    }
    // OMP supports() gate: only OAuth access credentials; paid xAI API keys
    // are a separate product and must never be sent to the billing proxy.
    if (credential.kind !== "oauth") {
      throw new BridgeError(
        "invalidPolicy",
        'xai-oauth usage requires an "oauth" credential; xAI API keys are a separate product',
      );
    }
    if (credential.oauth.access.trim() === "") {
      throw new BridgeError("authRequired", "xai-oauth credential carries no access token");
    }

    const signal = timeoutSignal(Math.max(1, request.deadlineAtMs - nowMs));
    let oauth = credential;
    let refreshedCredential: OAuthCredential | undefined;

    try {
      if (needsPreRotation(oauth.oauth, nowMs)) {
        oauth = await rotateXaiToken({ credential: oauth, fetcher, signal, nowMs });
        refreshedCredential = oauth;
      }

      // Best-effort identity per OMP fetchUsage: query userinfo only when the
      // stored credential lacks an email, then resolve the account id from the
      // response, the stored identity or the access-token JWT subject.
      let email = oauth.oauth.identity?.["email"]?.trim().toLowerCase();
      let accountId = oauth.oauth.identity?.["accountId"];
      if (email === undefined) {
        const identity = await fetchXaiIdentity(oauth.oauth.access, fetcher, signal, timeoutSignal);
        if (identity !== null) {
          accountId = identity.accountId ?? accountId;
          email = identity.email;
        }
      }
      if (accountId === undefined) {
        accountId = extractXaiAccessTokenSubject(oauth.oauth.access);
      }

      let windows: UsageWindow[];
      try {
        windows = await fetchBillingWindows(oauth.oauth.access, fetcher, signal, nowMs);
      } catch (error) {
        const retryWithRotation =
          error instanceof BridgeError &&
          error.kind === "authRequired" &&
          refreshedCredential === undefined &&
          hasRefreshMaterial(oauth.oauth);
        if (!retryWithRotation) {
          throw error;
        }
        // 401 mid-flow: rotate once, retry the billing probe once.
        oauth = await rotateXaiToken({ credential: oauth, fetcher, signal, nowMs });
        refreshedCredential = oauth;
        windows = await fetchBillingWindows(oauth.oauth.access, fetcher, signal, nowMs);
      }

      if (windows.length === 0) {
        throw new BridgeError("noData", "xAI billing response contained no usable quota rows");
      }

      if (refreshedCredential !== undefined) {
        refreshedCredential = withXaiIdentity(refreshedCredential, accountId, email);
      }

      const report: UsageReport = {
        productKind: "quota",
        sourceKind: "privateApi",
        fetchedAtMs: nowMs,
        connectorVersion: CONNECTOR_VERSION,
        windows,
      };
      return {
        schemaVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        providerId: request.providerId,
        connectorId: request.connectorId,
        accountRef: request.accountRef,
        status: "ok",
        completedAtMs: nowMs,
        report,
        ...(refreshedCredential !== undefined ? { refreshedCredential } : {}),
      };
    } catch (error) {
      // Rotation durability: xAI's refresh grant retires the old refresh
      // token, so a rotated bundle must reach the caller even when the
      // retried billing probe fails.
      throw rethrowWithRefreshedCredential(error, refreshedCredential);
    }
  },
});

export const xaiOauthConnector = createXaiOauthConnector();

// ---------------------------------------------------------------------------
// Auth module (OMP registry/oauth/xai-oauth.ts loginXAIOAuth)
// ---------------------------------------------------------------------------

interface XaiDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

/** OMP parseXAIDeviceAuthorization: every field required, endpoints pinned. */
function parseXaiDeviceAuthorization(payload: unknown): XaiDeviceAuthorization {
  if (!isRecord(payload)) {
    throw new DeviceFlowFailedError("xAI device-code response was not a JSON object.");
  }
  const deviceCode = typeof payload["device_code"] === "string" ? payload["device_code"].trim() : "";
  const userCode = typeof payload["user_code"] === "string" ? payload["user_code"].trim() : "";
  const verificationUri = typeof payload["verification_uri"] === "string" ? payload["verification_uri"].trim() : "";
  const verificationUriComplete =
    typeof payload["verification_uri_complete"] === "string" ? payload["verification_uri_complete"].trim() : "";
  const expiresInSeconds = payload["expires_in"];
  const intervalSeconds = payload["interval"];
  if (
    deviceCode === "" ||
    userCode === "" ||
    verificationUri === "" ||
    verificationUriComplete === "" ||
    typeof expiresInSeconds !== "number" ||
    !Number.isFinite(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    typeof intervalSeconds !== "number" ||
    !Number.isFinite(intervalSeconds) ||
    intervalSeconds <= 0
  ) {
    throw new DeviceFlowFailedError("xAI device-code response missing or invalid required fields.");
  }
  validateXaiAuthEndpoint(verificationUri, "verification_uri");
  validateXaiAuthEndpoint(verificationUriComplete, "verification_uri_complete");
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds,
    intervalSeconds,
  };
}

/** OMP requestXAIDeviceAuthorization: form POST client_id + scope. */
async function requestXaiDeviceAuthorization(fetcher: Fetcher, signal: AbortSignal): Promise<XaiDeviceAuthorization> {
  let response: Response;
  try {
    response = await fetcher(XAI_OAUTH_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw new DeviceFlowCancelledError(DEVICE_CANCEL_MESSAGE);
    throw new DeviceFlowFailedError(`xAI device-code request failed: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new DeviceFlowFailedError(`xAI device-code request failed: ${response.status}${detail !== "" ? ` ${detail}` : ""}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DeviceFlowFailedError(`xAI device-code response returned invalid JSON: ${errorMessage(error)}`);
  }
  return parseXaiDeviceAuthorization(payload);
}

/** Tokens minted by the device flow (OMP requires refresh_token + expires_in). */
type XaiFlowTokens = {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAtMs: number;
};

/** OMP pollXAIDeviceToken: device_code grant, pending/slow_down, strict parse. */
async function pollXaiDeviceToken(input: {
  readonly tokenEndpoint: string;
  readonly deviceCode: string;
  readonly fetcher: Fetcher;
  readonly signal: AbortSignal;
  readonly now: () => number;
}): Promise<OAuthDeviceCodePollResult<XaiFlowTokens>> {
  let response: Response;
  try {
    response = await input.fetcher(input.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: input.deviceCode,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (input.signal.aborted) throw new DeviceFlowCancelledError(DEVICE_CANCEL_MESSAGE);
    return { status: "failed", message: `xAI device-code token polling failed: ${errorMessage(error)}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return {
      status: "failed",
      message: `xAI device-code token polling returned invalid JSON: ${errorMessage(error)}`,
    };
  }

  if (response.ok) {
    const parsed = parseXaiTokenPayload(payload, "xAI device-code token response");
    if ("error" in parsed) {
      return { status: "failed", message: parsed.error };
    }
    return {
      status: "complete",
      value: {
        access: parsed.access,
        refresh: parsed.refresh,
        expiresAtMs: input.now() + parsed.expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
      },
    };
  }
  if (!isRecord(payload)) {
    return { status: "failed", message: `xAI device-code token polling failed: ${response.status}` };
  }

  const errorCode = typeof payload["error"] === "string" ? payload["error"] : "";
  if (errorCode === "authorization_pending") return { status: "pending" };
  if (errorCode === "slow_down") return { status: "slow_down" };

  const errorDescription = typeof payload["error_description"] === "string" ? payload["error_description"] : "";
  const detail = errorDescription !== "" ? errorDescription : errorCode !== "" ? errorCode : String(response.status);
  return { status: "failed", message: `xAI device-code token polling failed: ${detail}` };
}

function cancelled(): BridgeError {
  return new BridgeError("timeout", "xAI login was cancelled");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function remapLoginError(error: unknown, signal: AbortSignal): never {
  if (error instanceof BridgeError) {
    if (error.kind === "timeout" && signal.aborted) {
      throw cancelled();
    }
    throw error;
  }
  if (error instanceof DeviceFlowCancelledError || isAbortError(error)) {
    throw cancelled();
  }
  if (error instanceof DeviceFlowFailedError) {
    const kind = error.message.includes("timed out") ? "timeout" : "authRequired";
    throw new BridgeError(kind, error.message);
  }
  throw error;
}

function authRequestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

export type XaiOauthLoginDeps = {
  readonly fetcher?: Fetcher;
  /** Injectable clock; used for absolute expiry minting and polling cadence. */
  readonly now?: () => number;
  /** Injectable sleep; forwarded to the poll engine for deterministic tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable identity deadline; independent from the parent login signal. */
  readonly identityTimeoutSignal?: (ms: number) => AbortSignal;
};

/**
 * Device-authorization login against auth.x.ai: OIDC discovery, RFC 8628
 * device code (openUrl with verification_uri_complete, code with user_code,
 * waiting event), token polling at the advertised interval, then the
 * best-effort userinfo identity merged into the stored credential.
 */
export async function loginXaiOauth(
  method: AuthMethod,
  _inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: XaiOauthLoginDeps = {},
): Promise<LoginResult> {
  if (signal.aborted) {
    throw cancelled();
  }
  if (method !== "device") {
    throw new BridgeError("invalidRequest", 'provider "xai-oauth" supports only device login');
  }
  const fetcher = deps.fetcher ?? platformFetch;
  const now = deps.now ?? Date.now;
  try {
    const tokenEndpoint = await discoverXaiTokenEndpoint(fetcher, authRequestSignal(signal, DISCOVERY_TIMEOUT_MS));
    const device = await requestXaiDeviceAuthorization(fetcher, signal);
    events.onEvent({ type: "openUrl", url: device.verificationUriComplete });
    events.onEvent({ type: "code", code: device.userCode, verificationUrl: device.verificationUri });
    events.onEvent({ type: "waiting", detail: "Waiting for xAI device authorization..." });

    const tokens = await pollOAuthDeviceCodeFlow({
      poll: () =>
        pollXaiDeviceToken({
          tokenEndpoint,
          deviceCode: device.deviceCode,
          fetcher,
          signal,
          now,
        }),
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: device.expiresInSeconds,
      signal,
      now,
      ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    });

    const identity = await fetchXaiIdentity(tokens.access, fetcher, signal, deps.identityTimeoutSignal);
    const accountId = identity?.accountId ?? extractXaiAccessTokenSubject(tokens.access);
    const email = identity?.email;
    const credential: OAuthCredential = withXaiIdentity(
      {
        kind: "oauth",
        secret: tokens.access,
        oauth: {
          access: tokens.access,
          refresh: tokens.refresh,
          expiresAtMs: tokens.expiresAtMs,
          refreshEndpoint: tokenEndpoint,
          clientId: XAI_OAUTH_CLIENT_ID,
        },
      },
      accountId,
      email,
    );
    return {
      credential,
      ...(email !== undefined ? { accountLabel: email } : accountId !== undefined ? { accountLabel: accountId } : {}),
    };
  } catch (error) {
    throw remapLoginError(error, signal);
  }
}

export const xaiOauthAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["device"],
  login: (method, inputs, events, signal) => loginXaiOauth(method, inputs, events, signal),
  /** OMP refreshXAIOAuthToken via global fetch; the connector rotates with its own fetcher. */
  refresh: (credential, signal) => {
    if (credential.kind !== "oauth") {
      throw new BridgeError("invalidRequest", 'xai-oauth refresh requires an "oauth" credential');
    }
    return rotateXaiToken({ credential, fetcher: platformFetch, signal, nowMs: Date.now() });
  },
};
