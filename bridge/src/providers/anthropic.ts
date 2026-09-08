/**
 * Anthropic (Claude Pro/Max subscription) provider: usage connector + auth
 * module, hand-ported from the pinned oh-my-pi checkout @
 * 8500092296621a6826b7136e840f8a59ea338958:
 *
 * - packages/ai/src/usage/claude.ts                    (usage fetch + normalization)
 * - packages/ai/src/registry/oauth/anthropic.ts        (browser OAuth login + refresh)
 * - packages/ai/src/usage/shared.ts                    (parseIsoTimestamp)
 * Authentication fingerprints updated from d720e81fb747132f0b6c6c0f44eafc887552ec7f:
 * - packages/catalog/src/compat/rules/auth/anthropic.kdl (refresh header template)
 * - packages/ai/src/registry/engine/refresh.ts          (SDK template substitution)
 * - packages/ai/src/providers/claude-code-fingerprint.ts (CLI 2.1.257, SDK 0.112.1)
 * Usage normalization remains the earlier port; no ranking/reserve policy is copied.
 *
 * Kept from the OMP sources (same endpoints, client id, request bodies and
 * normalization boundaries):
 * - Usage: GET https://api.anthropic.com/api/oauth/usage with the exact
 *   claude-cli header set (accept, accept-encoding, the long anthropic-beta
 *   list, content-type, user-agent "claude-cli/2.1.257 (external, cli)",
 *   connection) and `Bearer <access>`. Best-effort GET
 *   https://api.anthropic.com/api/oauth/profile under OMP's identity-missing
 *   gate.
 * - Normalization: five_hour ?? limits[kind=session], seven_day ??
 *   limits[kind=weekly_all], legacy seven_day_opus / seven_day_sonnet, and
 *   limits[kind=weekly_scoped] rows keyed by scope.model.display_name
 *   (slugified, first occurrence wins, is_active ignored); percent rows clamp
 *   utilization to [0,100] with used/limit 100/100; extra usage comes from
 *   `spend` (newer) or `extra_usage` (legacy) as a USD row; resets_at is ISO
 *   parsed; severity follows the shared bridge/Swift wire bands.
 * - Browser login: PKCE + state against https://claude.ai/oauth/authorize
 *   with the base64-embedded client id 9d1c250a-e61b-44d9-88ed-5944d1962f5e
 *   and CC's subscription scopes, loopback callback on 127.0.0.1:54545
 *   (/callback), JSON code exchange at https://api.anthropic.com/v1/oauth/token
 *   (Content-Type only — CC omits Accept on OAuth token requests), the
 *   `code#state` fragment split, expiry = now + expires_in - 5min, and
 *   best-effort identity via https://api.anthropic.com/api/claude_cli/bootstrap
 *   ?entrypoint=cli&model=claude-opus-4-20-family (claude-opus-4-8) when the
 *   token response lacks account/email/org.
 * - Refresh: POST the token URL with {grant_type:refresh_token, client_id,
 *   refresh_token} plus the headers CC sends on refresh only
 *   (anthropic-beta: oauth-2025-04-20, User-Agent
 *   "anthropic-sdk-typescript/0.112.1 userOAuthProvider"); missing
 *   refresh_token keeps the old one; org identity is never rewritten.
 *
 * Deviations from the OMP sources (with reasons):
 * - Shared wire severity (warning >=0.8, critical >=0.95, exhausted >=1)
 *   replaces OMP's status ladder so Swift accepts every normalized window.
 * - Caller cancellation is rechecked after best-effort bootstrap enrichment:
 *   an aborted login must not return a successful credential.
 * - OMP's 3-attempt retry loop around the usage fetch (transient statuses,
 *   missing-data re-poll; 429 deliberately excluded) is not ported: the
 *   bridge contract is one deadline-bounded attempt whose typed errors the
 *   caller schedules retries around.
 * - OMP's rate-limit-header parser (parseClaudeRateLimitHeaders) serves
 *   inference responses, not usage fetching — out of scope for this
 *   connector.
 * - OMP's UsageReport metadata (endpoint/accountId/email/orgId/raw payload)
 *   has no bridge surface; the best-effort profile fetch is still performed
 *   under OMP's gate for wire parity, but its identity result is discarded.
 *   The credential-ranking strategy (scopeClaudeLimitsForModel etc.) is
 *   OMP-side routing policy, not usage reporting, and is not ported.
 * - OMP null-report outcomes become typed BridgeErrors: non-OK HTTP via
 *   callProviderHttp's status map, non-object/non-JSON bodies ->
 *   malformedPayload, zero usable rows -> noData.
 * - OMP validates only the JSON parse of the token response; this port also
 *   rejects a missing/empty access_token (malformedPayload) — without it the
 *   returned credential would be unusable.
 * - OMP's interactive paste-code fallback (onManualCodeInput racing the
 *   callback server) is ported onto the duplex AuthEvents.requestInput
 *   channel — a pasteHint event still carries the instruction, and the paste
 *   itself never touches a tty. The loopback binds a single 127.0.0.1
 *   listener (see ../auth/loopback.ts) instead of OMP's dual-stack
 *   localhost + oauth.html page.
 * - Per-request 30s OMP timeouts are combined with the caller's AbortSignal
 *   (the bridge contract requires honoring it); pre-rotation fires when
 *   expiresAtMs is missing or within 60s of now, and a 401 mid-flow rotates
 *   once and retries once (bridge common rules). A successful rotation is
 *   never dropped: when the subsequent usage work fails, the BridgeError
 *   carries refreshedCredential so the caller persists the rotated bundle
 *   before surfacing the error (Anthropic burns the old refresh token).
 * - OMP stores expires as Date.now()-based; the connector path uses the
 *   request's nowMs so rotation timestamps stay deterministic.
 */

import { defaultBrowserOpener, openInBrowser } from "../auth/open-browser";
import type { BrowserOpener } from "../auth/open-browser";
import { CallbackCancelledError, CallbackFailedError, generateCallbackState, startLoopbackCallback } from "../auth/loopback";
import type { LoopbackCallbackHandle } from "../auth/loopback";
import { rethrowWithRefreshedCredential, waitForCallbackOrManualPaste } from "../auth/refresh";
import { generatePKCE } from "../auth/pkce";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type { BridgeCredential, BridgeRequest, BridgeSuccessResponse, OAuthCredential, UsageWindow } from "../protocol";

// ---------------------------------------------------------------------------
// Shared constants (OMP registry/oauth/anthropic.ts + usage/claude.ts)
// ---------------------------------------------------------------------------

const PROVIDER_ID = "anthropic";
const CONNECTOR_VERSION = "anthropic-1";

/** OMP decodes the embedded client id the same way: atob(CLIENT_ID_B64). */
const decode = (value: string): string => atob(value);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const USAGE_BASE_URL = "https://api.anthropic.com/api/oauth";

// Scopes required for direct OAuth-token inference (user:inference) plus
// account/session management (OMP comment: the claude.ai endpoint is required
// for direct inference access).
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
const CLAUDE_CODE_VERSION = "2.1.257";
const BOOTSTRAP_MODEL = "claude-opus-4-8";
/** OMP per-request timeout (postJson / fetchBootstrapIdentity). */
const REQUEST_TIMEOUT_MS = 30_000;
/** OMP expires = now + expires_in - 5min safety margin. */
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;
/** Bridge common rule: rotate when the token expires within 60s. */
const PRE_ROTATE_WINDOW_MS = 60_000;

const REFRESH_USER_AGENT = "anthropic-sdk-typescript/0.112.1 userOAuthProvider";
const REFRESH_BETA = "oauth-2025-04-20";

/** OMP CLAUDE_HEADERS, verbatim (plus the Bearer authorization line). */
const CLAUDE_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/json, text/plain, */*",
  "accept-encoding": "gzip, compress, deflate, br",
  "anthropic-beta":
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  "content-type": "application/json",
  "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  connection: "keep-alive",
};

const BROWSER_PASTE_HINT =
  "Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.";

// ---------------------------------------------------------------------------
// Shared small helpers (OMP pi-catalog toNumber + usage/shared parseIsoTimestamp)
// ---------------------------------------------------------------------------

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

/** OMP usage/shared.ts parseIsoTimestamp: ISO string -> epoch ms. */
function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** OMP nonEmpty: non-empty string or undefined. */
function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordField(data: unknown, field: string): unknown {
  return isRecord(data) ? data[field] : undefined;
}

function nonEmptyField(data: unknown, field: string): string | undefined {
  const value = recordField(data, field);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Token rotation (OMP refreshAnthropicToken)
// ---------------------------------------------------------------------------

function canRotate(credential: OAuthCredential): boolean {
  return (
    credential.oauth.refresh !== undefined &&
    credential.oauth.refreshEndpoint !== undefined &&
    credential.oauth.clientId !== undefined
  );
}

function needsPreRotation(credential: OAuthCredential, nowMs: number): boolean {
  const expiresAtMs = credential.oauth.expiresAtMs;
  return (expiresAtMs === undefined || expiresAtMs - nowMs <= PRE_ROTATE_WINDOW_MS) && canRotate(credential);
}

/**
 * OMP refreshAnthropicToken: JSON refresh_token grant with CC's refresh-only
 * headers. Org identity is deliberately never rewritten (OMP comment: the org
 * a credential is scoped to is fixed at login).
 */
async function rotateAnthropicToken(
  credential: OAuthCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
  nowMs: number,
): Promise<OAuthCredential> {
  const oauth = credential.oauth;
  // Destructured so the canRotate guarantees narrow the locals for the body.
  const refreshToken = oauth.refresh;
  const refreshEndpoint = oauth.refreshEndpoint;
  const clientId = oauth.clientId;
  if (refreshToken === undefined || refreshEndpoint === undefined || clientId === undefined) {
    throw new BridgeError("authRequired", "Anthropic token rotation requires a refresh token, refresh endpoint, and client id");
  }
  const response = await callProviderHttp({
    call: {
      url: refreshEndpoint,
      method: "POST",
      // CC sends these on refresh but not on the initial code exchange.
      headers: {
        "anthropic-beta": REFRESH_BETA,
        "User-Agent": REFRESH_USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    },
    fetcher,
    signal,
    endpointLabel: "Anthropic token refresh",
    extraSecrets: [credential.secret, oauth.access, refreshToken],
  });
  const data = await response.json();
  const access = nonEmptyField(data, "access_token");
  if (access === undefined) {
    throw new BridgeError("authRequired", "Anthropic token refresh returned no access token");
  }
  const rotatedRefresh = nonEmptyField(data, "refresh_token") ?? refreshToken;
  const expiresIn = toNumber(recordField(data, "expires_in"));
  const expiresAtMs =
    expiresIn !== undefined ? nowMs + expiresIn * 1000 - EXPIRY_SAFETY_MARGIN_MS : oauth.expiresAtMs;
  return {
    kind: "oauth",
    secret: access,
    oauth: {
      access,
      refresh: rotatedRefresh,
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
      refreshEndpoint,
      clientId,
      ...(oauth.identity !== undefined ? { identity: oauth.identity } : {}),
    },
  };
}

/** AuthModule.refresh entry point (tests inject the fetcher). */
export async function refreshAnthropicCredential(
  credential: BridgeCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<BridgeCredential> {
  if (credential.kind !== "oauth") {
    throw new BridgeError("invalidRequest", "Anthropic token refresh requires an OAuth credential");
  }
  return await rotateAnthropicToken(credential, fetcher, signal, Date.now());
}

// ---------------------------------------------------------------------------
// Usage connector (OMP packages/ai/src/usage/claude.ts)
// ---------------------------------------------------------------------------

export type AnthropicUsageInput = {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
};

interface ParsedUsageBucket {
  readonly utilization?: number;
  readonly resetsAt?: number;
}

interface ParsedApiLimitEntry {
  readonly kind: string;
  readonly bucket: ParsedUsageBucket;
  readonly displayName?: string;
}

/** OMP parseBucket: skip only when both utilization and resets_at are absent. */
function parseBucket(value: unknown): ParsedUsageBucket | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const utilization = toNumber(value["utilization"]);
  const resetsAt = parseIsoTimestamp(typeof value["resets_at"] === "string" ? value["resets_at"] : undefined);
  if (utilization === undefined && resetsAt === undefined) {
    return undefined;
  }
  return {
    ...(utilization !== undefined ? { utilization } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

function getApiLimitDisplayName(scope: unknown): string | undefined {
  const displayName = nonEmptyField(recordField(scope, "model"), "display_name");
  return displayName !== undefined && displayName.trim() !== "" ? displayName.trim() : undefined;
}

/**
 * OMP parseApiLimitEntries: generic limits[] rows keep kind + percent +
 * resets_at + optional display name. is_active is deliberately ignored (live
 * payloads mark only the currently binding limit active; filtering on it hid
 * real utilization).
 */
function parseApiLimitEntries(raw: unknown): readonly ParsedApiLimitEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const entries: ParsedApiLimitEntry[] = [];
  for (const rawEntry of raw) {
    if (!isRecord(rawEntry)) {
      continue;
    }
    const kind = rawEntry["kind"];
    if (typeof kind !== "string") {
      continue;
    }
    const utilization = toNumber(rawEntry["percent"]);
    const resetsAt = parseIsoTimestamp(typeof rawEntry["resets_at"] === "string" ? rawEntry["resets_at"] : undefined);
    if (utilization === undefined && resetsAt === undefined) {
      continue;
    }
    const displayName = getApiLimitDisplayName(rawEntry["scope"]);
    entries.push({
      kind,
      bucket: {
        ...(utilization !== undefined ? { utilization } : {}),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
      },
      ...(displayName !== undefined ? { displayName } : {}),
    });
  }
  return entries;
}

/**
 * OMP buildUsageLimit for percent rows: buckets without utilization produce
 * no window (buildUsageAmount returns undefined); utilization is clamped to
 * [0,100] with limit 100.
 */
function percentWindow(args: {
  readonly id: string;
  readonly label: string;
  readonly bucket: ParsedUsageBucket | undefined;
}): UsageWindow | undefined {
  const utilization = args.bucket?.utilization;
  if (utilization === undefined) {
    return undefined;
  }
  const used = Math.min(Math.max(utilization, 0), 100);
  const resolvedFraction = used / 100;
  return {
    id: args.id,
    label: args.label,
    unit: "percent",
    resolvedFraction,
    severity: severityForFraction(resolvedFraction),
    used,
    limit: 100,
    ...(args.bucket?.resetsAt !== undefined ? { resetsAtMs: args.bucket.resetsAt } : {}),
  };
}

/** OMP slugifyClaudeLimitDisplayName. */
function slugifyDisplayName(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * OMP buildScopedWeeklyUsageLimits: weekly_scoped rows keyed by display name
 * slug; the first occurrence of a slug wins.
 */
function scopedWeeklyWindows(entries: readonly ParsedApiLimitEntry[]): readonly UsageWindow[] {
  const seenSlugs = new Set<string>();
  const windows: UsageWindow[] = [];
  for (const entry of entries) {
    if (entry.kind !== "weekly_scoped" || entry.displayName === undefined) {
      continue;
    }
    const slug = slugifyDisplayName(entry.displayName);
    if (slug === "" || seenSlugs.has(slug)) {
      continue;
    }
    seenSlugs.add(slug);
    const window = percentWindow({
      id: `anthropic:7d:${slug}`,
      label: `Claude 7 Day (${entry.displayName})`,
      bucket: entry.bucket,
    });
    if (window !== undefined) {
      windows.push(window);
    }
  }
  return windows;
}

/** OMP parseDollarAmount: minor units + exponent; USD enforced when required. */
function parseDollarAmount(
  amountMinor: unknown,
  exponent: unknown,
  currency: unknown,
  currencyRequired: boolean,
): number | undefined {
  if (
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 0 ||
    typeof exponent !== "number" ||
    !Number.isSafeInteger(exponent) ||
    exponent < 0
  ) {
    return undefined;
  }
  if (currency === undefined) {
    if (currencyRequired) {
      return undefined;
    }
  } else if (typeof currency !== "string" || currency.toUpperCase() !== "USD") {
    return undefined;
  }
  const divisor = 10 ** exponent;
  if (!Number.isFinite(divisor)) {
    return undefined;
  }
  const dollars = amountMinor / divisor;
  return Number.isFinite(dollars) ? dollars : undefined;
}

interface ParsedExtraUsage {
  readonly used: number;
  readonly limit?: number;
}

/** OMP parseSpendExtraUsage: the newer `spend` block (enabled + owned limit key). */
function parseSpendExtraUsage(value: unknown): ParsedExtraUsage | null {
  if (!isRecord(value) || value["enabled"] !== true || !Object.hasOwn(value, "limit") || !isRecord(value["used"])) {
    return null;
  }
  const used = recordField(value, "used");
  const limit = recordField(value, "limit");
  const usedDollars = parseDollarAmount(
    recordField(used, "amount_minor"),
    recordField(used, "exponent"),
    recordField(used, "currency"),
    true,
  );
  if (usedDollars === undefined) {
    return null;
  }
  if (limit === null) {
    return { used: usedDollars };
  }
  if (!isRecord(limit)) {
    return null;
  }
  const limitDollars = parseDollarAmount(
    recordField(limit, "amount_minor"),
    recordField(limit, "exponent"),
    recordField(limit, "currency"),
    true,
  );
  // Reject non-positive caps rather than normalizing them into contradictory zero fractions.
  return limitDollars === undefined || limitDollars <= 0 ? null : { used: usedDollars, limit: limitDollars };
}

/** OMP parseLegacyExtraUsage: the older `extra_usage` block. */
function parseLegacyExtraUsage(value: unknown): ParsedExtraUsage | null {
  if (!isRecord(value) || value["is_enabled"] !== true || !Object.hasOwn(value, "monthly_limit")) {
    return null;
  }
  const decimalPlaces = value["decimal_places"] === undefined ? 2 : value["decimal_places"];
  const usedDollars = parseDollarAmount(value["used_credits"], decimalPlaces, value["currency"], false);
  if (usedDollars === undefined) {
    return null;
  }
  const monthlyLimit = value["monthly_limit"];
  if (monthlyLimit === null || monthlyLimit === undefined) {
    return { used: usedDollars };
  }
  const limitDollars = parseDollarAmount(monthlyLimit, decimalPlaces, value["currency"], false);
  return limitDollars === undefined || limitDollars <= 0 ? null : { used: usedDollars, limit: limitDollars };
}

/**
 * OMP buildClaudeExtraUsageLimit as a bridge window: `spend` wins over the
 * legacy `extra_usage` block; no cap means no fraction and an unknown
 * severity; used >= limit is exhausted.
 */
function extraUsageWindow(payload: Record<string, unknown>): UsageWindow | undefined {
  const spend = payload["spend"];
  const parsed = spend === null || spend === undefined ? parseLegacyExtraUsage(payload["extra_usage"]) : parseSpendExtraUsage(spend);
  if (parsed === null) {
    return undefined;
  }
  return {
    id: "anthropic:extra",
    label: "Claude Extra Usage",
    unit: "usd",
    ...(parsed.limit !== undefined
      ? { resolvedFraction: parsed.used / parsed.limit, severity: severityForFraction(parsed.used / parsed.limit) }
      : { severity: "unknown" }),
    used: parsed.used,
    ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
  };
}

/** OMP fetchClaudeUsage limit list, in OMP order. */
function buildClaudeWindows(payload: Record<string, unknown>): readonly UsageWindow[] {
  const apiLimitEntries = parseApiLimitEntries(payload["limits"]);
  const fiveHour = parseBucket(payload["five_hour"]) ?? apiLimitEntries.find((entry) => entry.kind === "session")?.bucket;
  const sevenDay = parseBucket(payload["seven_day"]) ?? apiLimitEntries.find((entry) => entry.kind === "weekly_all")?.bucket;
  const sevenDayOpus = parseBucket(payload["seven_day_opus"]);
  const sevenDaySonnet = parseBucket(payload["seven_day_sonnet"]);
  return [
    percentWindow({ id: "anthropic:5h", label: "Claude 5 Hour", bucket: fiveHour }),
    percentWindow({ id: "anthropic:7d", label: "Claude 7 Day", bucket: sevenDay }),
    percentWindow({ id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", bucket: sevenDayOpus }),
    percentWindow({ id: "anthropic:7d:sonnet", label: "Claude 7 Day (Sonnet)", bucket: sevenDaySonnet }),
    ...scopedWeeklyWindows(apiLimitEntries),
    extraUsageWindow(payload),
  ].filter((window): window is UsageWindow => window !== undefined);
}

/** OMP getPayloadString: non-empty trimmed string or undefined. */
function getUsagePayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value.trim();
}

function getNestedUsagePayloadString(payload: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  const nested = recordField(payload, key);
  return isRecord(nested) ? getUsagePayloadString(nested, nestedKey) : undefined;
}

/** OMP extractUsageIdentity: first non-empty account/email alias wins. */
function extractUsageIdentity(payload: Record<string, unknown>): { accountId?: string; email?: string } {
  const accountId =
    getUsagePayloadString(payload, "account_id") ??
    getUsagePayloadString(payload, "accountId") ??
    getUsagePayloadString(payload, "user_id") ??
    getUsagePayloadString(payload, "userId") ??
    getNestedUsagePayloadString(payload, "account", "uuid") ??
    getNestedUsagePayloadString(payload, "account", "id") ??
    getNestedUsagePayloadString(payload, "user", "uuid") ??
    getNestedUsagePayloadString(payload, "user", "id");
  const email =
    getUsagePayloadString(payload, "email") ??
    getUsagePayloadString(payload, "user_email") ??
    getUsagePayloadString(payload, "userEmail") ??
    getNestedUsagePayloadString(payload, "account", "email") ??
    getNestedUsagePayloadString(payload, "user", "email");
  return {
    ...(accountId !== undefined ? { accountId } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

/**
 * OMP fetchProfile: best-effort GET /profile under the same headers when the
 * usage payload and credential identity lack account/email. The bridge
 * UsageReport has no metadata surface, so the response body is discarded —
 * the call is kept for wire parity with OMP.
 */
async function maybeFetchProfileBestEffort(input: {
  readonly payload: Record<string, unknown>;
  readonly credential: OAuthCredential;
  readonly fetcher: Fetcher;
  readonly signal: AbortSignal;
}): Promise<void> {
  const payloadIdentity = extractUsageIdentity(input.payload);
  const credentialIdentity = input.credential.oauth.identity;
  const accountId = payloadIdentity.accountId ?? (credentialIdentity !== undefined ? nonEmpty(credentialIdentity["accountId"]) : undefined);
  const email = payloadIdentity.email ?? (credentialIdentity !== undefined ? nonEmpty(credentialIdentity["email"]) : undefined);
  if (accountId !== undefined && email !== undefined) {
    return;
  }
  try {
    await callProviderHttp({
      call: {
        url: `${USAGE_BASE_URL}/profile`,
        method: "GET",
        headers: { ...CLAUDE_HEADERS, authorization: `Bearer ${input.credential.oauth.access}` },
      },
      fetcher: input.fetcher,
      signal: input.signal,
      endpointLabel: "Anthropic profile endpoint",
      extraSecrets: [input.credential.secret, input.credential.oauth.access],
    });
  } catch {
    // Deliberately best-effort (OMP fetchProfile swallows every failure):
    // identity enrichment must never fail the usage report.
  }
}

async function fetchUsageOnce(
  credential: OAuthCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<{ json: () => Promise<unknown> }> {
  return await callProviderHttp({
    call: {
      url: `${USAGE_BASE_URL}/usage`,
      method: "GET",
      headers: { ...CLAUDE_HEADERS, authorization: `Bearer ${credential.oauth.access}` },
    },
    fetcher,
    signal,
    endpointLabel: "Anthropic usage endpoint",
    extraSecrets: [credential.secret, credential.oauth.access],
  });
}

export async function fetchAnthropicUsage(input: AnthropicUsageInput): Promise<BridgeSuccessResponse> {
  const { request, fetcher, nowMs } = input;
  if (request.providerId !== PROVIDER_ID) {
    throw new BridgeError("invalidProvider", `anthropic connector received providerId "${request.providerId}"`);
  }
  const credential = request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", "anthropic usage requires a credential");
  }
  if (credential.kind !== "oauth") {
    throw new BridgeError("invalidRequest", "anthropic usage requires an OAuth credential");
  }
  const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));

  let effective = credential;
  let rotated: OAuthCredential | undefined;
  try {
    if (needsPreRotation(credential, nowMs)) {
      effective = await rotateAnthropicToken(credential, fetcher, signal, nowMs);
      rotated = effective;
    }

    let response: { json: () => Promise<unknown> };
    try {
      response = await fetchUsageOnce(effective, fetcher, signal);
    } catch (error) {
      // 401 mid-flow: rotate once and retry once (bridge common rule).
      if (error instanceof BridgeError && error.kind === "authRequired" && rotated === undefined && canRotate(effective)) {
        effective = await rotateAnthropicToken(effective, fetcher, signal, nowMs);
        rotated = effective;
        response = await fetchUsageOnce(effective, fetcher, signal);
      } else {
        throw error;
      }
    }

    const payload = await response.json();
    if (!isRecord(payload)) {
      throw new BridgeError("malformedPayload", "anthropic usage endpoint returned a non-object body");
    }
    const windows = buildClaudeWindows(payload);
    if (windows.length === 0) {
      throw new BridgeError("noData", "anthropic usage response contained no usable quota windows");
    }
    await maybeFetchProfileBestEffort({ payload, credential: effective, fetcher, signal });

    return {
      schemaVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      providerId: request.providerId,
      connectorId: request.connectorId,
      accountRef: request.accountRef,
      status: "ok",
      completedAtMs: nowMs,
      report: {
        productKind: "quota",
        sourceKind: "privateApi",
        fetchedAtMs: nowMs,
        connectorVersion: CONNECTOR_VERSION,
        windows,
      },
      ...(rotated !== undefined ? { refreshedCredential: rotated } : {}),
    };
  } catch (error) {
    // Rotation durability: a rotated token must reach the caller even when
    // the subsequent usage work fails — Anthropic burns the old refresh
    // token on rotation, so dropping it would strand the credential.
    throw rethrowWithRefreshedCredential(error, rotated);
  }
}

export const anthropicConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchAnthropicUsage,
};

// ---------------------------------------------------------------------------
// Auth module (OMP packages/ai/src/registry/oauth/anthropic.ts)
// ---------------------------------------------------------------------------

/** Field values may be explicitly undefined (OMP optional-identity shape). */
interface AnthropicIdentity {
  readonly accountId?: string | undefined;
  readonly email?: string | undefined;
  readonly orgId?: string | undefined;
  readonly orgName?: string | undefined;
}

/**
 * OMP exchangeToken's `#`-fragment split: a pasted code can carry the real
 * state after a "#" (loopback codes never do, but the boundary is ported).
 */
function splitCodeFragment(code: string, state: string): { code: string; state: string } {
  const codeFragmentIndex = code.indexOf("#");
  if (codeFragmentIndex < 0) {
    return { code, state };
  }
  const exchangeCode = code.slice(0, codeFragmentIndex);
  const codeFragmentState = code.slice(codeFragmentIndex + 1);
  return { code: exchangeCode, state: codeFragmentState.length > 0 ? codeFragmentState : state };
}

/** OMP extractAccountFromTokenResponse. */
function extractAccountFromTokenResponse(data: Record<string, unknown>): AnthropicIdentity {
  const account = recordField(data, "account");
  const organization = recordField(data, "organization");
  return {
    accountId: nonEmptyField(account, "uuid"),
    email: nonEmptyField(account, "email_address"),
    orgId: nonEmptyField(organization, "uuid"),
    orgName: nonEmptyField(organization, "name"),
  };
}

/**
 * OMP fetchBootstrapIdentity: GET /api/claude_cli/bootstrap?entrypoint=cli
 * &model=claude-opus-4-8 with the claude-code fingerprint headers. Failures
 * are swallowed — identity is best-effort (OMP resolveAccountIdentity catch).
 */
async function fetchBootstrapIdentity(
  accessToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<AnthropicIdentity> {
  try {
    const url = `${BOOTSTRAP_URL}?${new URLSearchParams({ entrypoint: "cli", model: BOOTSTRAP_MODEL }).toString()}`;
    const response = await callProviderHttp({
      call: {
        url,
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": `claude-code/${CLAUDE_CODE_VERSION}`,
          "anthropic-beta": REFRESH_BETA,
        },
      },
      fetcher,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      endpointLabel: "Anthropic bootstrap identity endpoint",
      extraSecrets: [accessToken],
    });
    const data = await response.json();
    const oauthAccount = recordField(data, "oauth_account");
    if (!isRecord(oauthAccount)) {
      return {};
    }
    return {
      accountId: nonEmptyField(oauthAccount, "account_uuid"),
      email: nonEmptyField(oauthAccount, "account_email"),
      orgId: nonEmptyField(oauthAccount, "organization_uuid"),
      orgName: nonEmptyField(oauthAccount, "organization_name"),
    };
  } catch {
    // Deliberately best-effort (OMP swallows bootstrap failures): a missing
    // identity must never fail an otherwise successful login.
    return {};
  }
}

/**
 * OMP resolveAccountIdentity: prefer the token response's account/organization
 * blocks, recover the rest from bootstrap. includeOrg is login-only.
 */
async function resolveAccountIdentity(
  data: Record<string, unknown>,
  accessToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
  options?: { readonly includeOrg?: boolean },
): Promise<AnthropicIdentity> {
  const identity = extractAccountFromTokenResponse(data);
  const orgSatisfied = options?.includeOrg !== true || identity.orgId !== undefined;
  if (identity.accountId !== undefined && identity.email !== undefined && orgSatisfied) {
    return identity;
  }
  const bootstrap = await fetchBootstrapIdentity(accessToken, fetcher, signal);
  return {
    accountId: identity.accountId ?? bootstrap.accountId,
    email: identity.email ?? bootstrap.email,
    orgId: identity.orgId ?? bootstrap.orgId,
    orgName: identity.orgName ?? bootstrap.orgName,
  };
}

function throwIfLoginCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("timeout", "Anthropic login cancelled");
  }
}

export type AnthropicLoginDeps = {
  readonly fetcher: Fetcher;
  /** Injectable browser opener; defaults to the macOS `open` spawn. */
  readonly openBrowser?: BrowserOpener;
};

/**
 * OMP AnthropicOAuthFlow + loginAnthropic: PKCE + state browser flow on the
 * claude.ai authorize endpoint, loopback capture, JSON code exchange, then
 * best-effort identity resolution.
 */
export async function loginAnthropic(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: AnthropicLoginDeps,
): Promise<LoginResult> {
  if (method !== "browser") {
    throw new BridgeError("invalidRequest", `provider "anthropic" does not offer login method "${method}"`);
  }
  throwIfLoginCancelled(signal);

  const state = generateCallbackState();
  let handle: LoopbackCallbackHandle;
  try {
    handle = await startLoopbackCallback(state, { preferredPort: CALLBACK_PORT, callbackPath: CALLBACK_PATH, signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeError("transport", `unable to start the local Anthropic OAuth callback server: ${message}`);
  }
  // The 300s loopback deadline can reject this promise on paths that never
  // await it; keep that rejection observed.
  void handle.wait.catch(() => undefined);

  try {
    // OMP generateAuthUrl: PKCE pair, then the exact authorize parameter set.
    const pkce = await generatePKCE();
    const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: handle.redirectUri,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
    }).toString()}`;
    events.onEvent({ type: "openUrl", url: authorizeUrl });
    
    events.onEvent({ type: "pasteHint", detail: BROWSER_PASTE_HINT });
    events.onEvent({ type: "waiting", detail: "Waiting for browser authentication..." });

    let callback: { code: string; state: string };
    try {
      // OMP races the loopback callback against the manual paste channel
      // (onManualCodeInput); the bridge routes the paste through the duplex
      // requestInput channel — never a tty.
      callback = await waitForCallbackOrManualPaste({
        wait: handle.wait,
        expectedState: state,
        requestInput: events.requestInput,
        prompt: { prompt: BROWSER_PASTE_HINT, inputKind: "redirectUrl", sensitive: true },
        signal,
      });
    } catch (error) {
      if (error instanceof CallbackCancelledError) {
        throw new BridgeError(
          "timeout",
          signal.aborted
            ? "Anthropic login cancelled while waiting for the browser callback"
            : "Anthropic login timed out waiting for the browser callback",
        );
      }
      if (error instanceof CallbackFailedError) {
        // The redirect carried our state nonce: a genuine provider-reported
        // authorization failure (e.g. the user denied the consent screen).
        throw new BridgeError("invalidRequest", error.message);
      }
      throw error;
    }
    throwIfLoginCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Exchanging authorization code for tokens..." });

    const exchange = splitCodeFragment(callback.code, callback.state);
    const response = await callProviderHttp({
      call: {
        url: TOKEN_URL,
        method: "POST",
        // No Accept header: CC omits it on OAuth token requests (OMP comment).
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          code: exchange.code,
          state: exchange.state,
          redirect_uri: handle.redirectUri,
          code_verifier: pkce.verifier,
        }),
      },
      fetcher: deps.fetcher,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      endpointLabel: "Anthropic token exchange endpoint",
    });
    const data = await response.json();
    if (!isRecord(data)) {
      throw new BridgeError("malformedPayload", "Anthropic token response was not a JSON object");
    }
    const access = nonEmptyField(data, "access_token");
    if (access === undefined) {
      throw new BridgeError("malformedPayload", "Anthropic token response missing access token");
    }
    const refresh = nonEmptyField(data, "refresh_token");
    const expiresAtMs = (() => {
      const expiresIn = toNumber(recordField(data, "expires_in"));
      return expiresIn !== undefined ? Date.now() + expiresIn * 1000 - EXPIRY_SAFETY_MARGIN_MS : undefined;
    })();

    const identity = await resolveAccountIdentity(data, access, deps.fetcher, signal, { includeOrg: true });
    throwIfLoginCancelled(signal);
    const identityRecord: Record<string, string> = {};
    if (identity.accountId !== undefined) {
      identityRecord["accountId"] = identity.accountId;
    }
    if (identity.email !== undefined) {
      identityRecord["email"] = identity.email;
    }
    if (identity.orgId !== undefined) {
      identityRecord["orgId"] = identity.orgId;
    }
    if (identity.orgName !== undefined) {
      identityRecord["orgName"] = identity.orgName;
    }
    const accountLabel = identity.email ?? identity.accountId;

    return {
      credential: {
        kind: "oauth",
        secret: access,
        oauth: {
          access,
          ...(refresh !== undefined ? { refresh } : {}),
          ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
          refreshEndpoint: TOKEN_URL,
          clientId: CLIENT_ID,
          ...(Object.keys(identityRecord).length > 0 ? { identity: identityRecord } : {}),
        },
      },
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    };
  } finally {
    handle.stop();
  }
}

const platformAnthropicFetch: Fetcher = (url, init) => fetch(url, init);

export const anthropicAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["browser"],
  login: (method, inputs, events, signal) => loginAnthropic(method, inputs, events, signal, { fetcher: platformAnthropicFetch }),
  refresh: (credential, signal) => refreshAnthropicCredential(credential, platformAnthropicFetch, signal),
};
