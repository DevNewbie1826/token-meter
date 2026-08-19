/**
 * Cursor provider module (auth + usage), hand-ported from the pinned
 * oh-my-pi checkout @ 8500092296621a6826b7136e840f8a59ea338958:
 *
 * - packages/ai/src/registry/oauth/cursor.ts (PKCE + UUID browser login,
 *   auth polling, token refresh, JWT subject/expiry helpers)
 * - packages/ai/src/usage/cursor.ts          (usage fetch + normalization)
 * - packages/ai/src/usage/shared.ts          (usageStatus, parseIsoTimestamp)
 * - packages/catalog/src/utils.ts            (toNumber)
 *
 * Kept from the OMP sources (same endpoints, request bodies and
 * normalization boundaries):
 * - Browser login: PKCE verifier/challenge + random UUID -> open
 *   https://cursor.com/loginDeepControl?challenge=&uuid=&mode=login&redirectTarget=cli,
 *   then GET https://api2.cursor.sh/auth/poll?uuid=<uuid>&verifier=<verifier>
 *   with no headers; 404 = not-yet-authorized (1.2x backoff capped at 10s,
 *   error budget reset), any other failure counts toward the 3-consecutive
 *   -error budget, 150 attempts max, JSON { accessToken, refreshToken }.
 * - Refresh: POST https://api2.cursor.sh/auth/exchange_user_api_key with
 *   Authorization: Bearer <refresh-token> and body "{}"; response
 *   { accessToken, refreshToken } (missing refreshToken keeps the old one).
 *   Cursor's refresh endpoint is NOT a grant_type=refresh_token form
 *   endpoint, so the connector rule's generic rotation body is replaced by
 *   this exact OMP request (rotation trigger/retry/refreshedCredential
 *   semantics still follow the bridge contract).
 * - Token expiry: JWT exp * 1000 - 5min, fallback now + 1h.
 * - Usage: GET https://api2.cursor.sh/auth/usage with Accept + Bearer,
 *   normalized with OMP's legacy row mapping (used from numRequests / used /
 *   amountUsed / usdUsed; limit from maxRequestUsage / limit / amountLimit /
 *   usdLimit; both required; planUsage / *usd* / *billing* / *stripe* keys
 *   are USD, everything else requests; ids cursor:usd:<key> and
 *   cursor:requests:<lowercased key>).
 * - OAuth-backed fetches additionally synthesize the dashboard session
 *   cookie WorkosCursorSessionToken=encodeURIComponent(`${subUserId}::${token}`)
 *   (sub is the part after "|") and GET https://cursor.com/api/usage-summary,
 *   normalized with OMP's individualUsage mapping: the overall cents bucket
 *   first (used/limit/remaining in cents / 100), else the plan rails
 *   (autoPercentUsed -> "Cursor Models" percent row, apiPercentUsed ->
 *   "Other Models" USD row, totalPercentUsed or cents -> "Personal Usage"),
 *   plus the on-demand cents row when it carries a positive limit. Resets
 *   come from billingCycleEnd / endOfMonth / resetsAt / nextReset, else
 *   startOfMonth / billingCycleStart / startOfBillingCycle + 1 UTC month.
 * - Severity: OMP usageStatus bands (>=1 exhausted, >=0.9 warning, else ok;
 *   no fraction -> unknown).
 *
 * Deviations from the OMP sources (with reasons):
 * - OMP races the /auth/usage and dashboard calls and soft-fails both
 *   (fetchCursorJson returns undefined on any error). The bridge contract
 *   requires callProviderHttp with the default status map for every call, so
 *   a primary /auth/usage failure surfaces as a typed BridgeError (401 ->
 *   authRequired, 429 -> rateLimited, non-JSON -> malformedPayload) while the
 *   dashboard usage-summary call keeps OMP's best-effort enrichment
 *   semantics (a failed summary just drops its rows).
 * - OMP's /api/auth/me email lookup is not ported: the bridge UsageReport
 *   has no metadata surface (and model fields are forbidden anyway).
 * - Bridge OAuth rotation contract: pre-rotate before the first upstream
 *   call when oauth.expiresAtMs is missing or within 60s of nowMs and a
 *   refresh token + refreshEndpoint exist; on a 401 from /auth/usage rotate
 *   once and retry once; every rotation returns refreshedCredential, and a
 *   failed usage fetch after a rotation carries it on the error envelope
 *   (the exchange can retire the old refresh token).
 * - The browser credential carries refreshEndpoint + identity { userId }
 *   (JWT sub after "|"); OMP's Cursor flow embeds no OAuth client id, so
 *   oauth.clientId stays unset rather than inventing one. accountLabel is
 *   the extracted userId (the only identity the OMP login flow yields).
 * - Browser login opens the URL through the bridge openInBrowser helper and
 *   emits openUrl + waiting auth events (OMP's onAuth/onPollStart
 *   callbacks); the poll sleeps are injectable (Bun.sleep in production) so
 *   tests never depend on wall-clock delays, and the login AbortSignal is
 *   honored between poll attempts.
 * - apiKey login is a bridge addition (OMP's registry offers browser OAuth
 *   only); the pasted key becomes { kind: "bearer" } because OMP's cursor
 *   usage provider accepts api_key credentials as the plain Bearer token.
 *   The bridge validates the key before returning it with the exact request
 *   the usage path makes (GET /auth/usage, Bearer key, Accept JSON) so an
 *   invalid key fails the login instead of the first usage fetch.
 * - OMP's malformed poll response would store undefined tokens; the bridge
 *   credential requires a secret, so a missing accessToken is a
 *   malformedPayload failure that still counts against OMP's consecutive
 *   error budget.
 * - The legacy and dashboard fetches run sequentially (OMP races them); the
 *   merged row order [...legacy, ...summary] is preserved.
 */

import { defaultBrowserOpener, openInBrowser } from "../auth/open-browser";
import type { BrowserOpener } from "../auth/open-browser";
import { rethrowWithRefreshedCredential } from "../auth/refresh";
import { generatePKCE } from "../auth/pkce";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord } from "../protocol";
import type { BridgeCredential, BridgeRequest, BridgeSuccessResponse, OAuthCredential, Severity, UsageWindow } from "../protocol";

const PROVIDER_ID = "cursor";
const CONNECTOR_VERSION = "cursor-1";

/** CURSOR_LOGIN_URL from OMP registry/oauth/cursor.ts. */
const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
/** CURSOR_POLL_URL from OMP registry/oauth/cursor.ts. */
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
/** CURSOR_REFRESH_URL from OMP registry/oauth/cursor.ts. */
const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
/** DEFAULT_CURSOR_BASE_URL + "/auth/usage" from OMP usage/cursor.ts. */
const AUTH_USAGE_URL = "https://api2.cursor.sh/auth/usage";
/** Dashboard usage-summary endpoint from OMP usage/cursor.ts. */
const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";

/** OMP poll tuning constants. */
const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1000;
const POLL_MAX_DELAY = 10000;
const POLL_BACKOFF_MULTIPLIER = 1.2;

/** OMP getTokenExpiry: JWT exp minus a 5-minute skew. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** OMP getTokenExpiry fallback when the token carries no exp claim. */
const FALLBACK_TOKEN_LIFETIME_MS = 3600 * 1000;
/** Bridge rotation contract: pre-rotate when expiry is this close. */
const ROTATION_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared helpers (OMP catalog utils.ts + usage/shared.ts + oauth/cursor.ts)
// ---------------------------------------------------------------------------

/** toNumber from packages/catalog/src/utils.ts: finite number or numeric string. */
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

/** parseIsoTimestamp from packages/ai/src/usage/shared.ts. */
function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** usageStatus from packages/ai/src/usage/shared.ts (Cursor's severity map). */
function usageStatus(usedFraction: number | undefined): Severity {
  if (usedFraction === undefined) {
    return "unknown";
  }
  if (usedFraction >= 1) {
    return "exhausted";
  }
  if (usedFraction >= 0.9) {
    return "warning";
  }
  return "ok";
}

/** decodeCursorAccessTokenPayload from OMP registry/oauth/cursor.ts. */
function decodeCursorAccessTokenPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  const payload = parts[1];
  if (!payload) {
    return undefined;
  }
  return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
}

/** extractCursorAccessTokenUserId from OMP registry/oauth/cursor.ts. */
export function extractCursorAccessTokenUserId(token: string): string | undefined {
  try {
    const payload = decodeCursorAccessTokenPayload(token);
    if (!isRecord(payload) || typeof payload["sub"] !== "string") {
      return undefined;
    }
    const sub = payload["sub"];
    const parts = sub.split("|");
    const userId = (parts.length > 1 ? (parts[1] ?? sub) : sub).trim();
    return userId === "" ? undefined : userId;
  } catch {
    return undefined;
  }
}

/** getTokenExpiry from OMP registry/oauth/cursor.ts (exp - 5min, else +1h). */
function cursorTokenExpiry(token: string, nowMs: number): number {
  try {
    const decoded = decodeCursorAccessTokenPayload(token);
    if (isRecord(decoded) && typeof decoded["exp"] === "number") {
      return decoded["exp"] * 1000 - EXPIRY_SKEW_MS;
    }
  } catch {
    // OMP ignores parse errors and falls back to a 1h assumption.
  }
  return nowMs + FALLBACK_TOKEN_LIFETIME_MS;
}

// ---------------------------------------------------------------------------
// Usage connector (OMP packages/ai/src/usage/cursor.ts)
// ---------------------------------------------------------------------------

export type CursorUsageInput = {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
};

/** OMP UsageAmount subset the bridge windows expose. */
type CursorAmount = {
  readonly used?: number;
  readonly limit?: number;
  readonly usedFraction?: number;
  readonly unit: "usd" | "percent" | "requests";
};

/** One OMP-normalized limit, mapped 1:1 onto a bridge UsageWindow. */
type CursorLimit = {
  readonly id: string;
  readonly label: string;
  readonly resetsAtMs?: number;
  readonly amount: CursorAmount;
};

export async function fetchCursorUsage(input: CursorUsageInput): Promise<BridgeSuccessResponse> {
  const { request, fetcher, nowMs } = input;
  if (request.providerId !== PROVIDER_ID) {
    throw new BridgeError("invalidProvider", `cursor connector received providerId "${request.providerId}"`);
  }
  const originalCredential = request.credential;
  if (originalCredential === undefined) {
    throw new BridgeError("missingCredential", "cursor usage requires a credential");
  }
  const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));

  let refreshed: OAuthCredential | undefined;
  try {
    // Bridge rotation contract: rotate before the first upstream call when the
    // access token is expired/expiring (OMP tracks this via
    // isCursorTokenExpiringSoon on every request).
    let credential = originalCredential;
    if (needsCursorRotation(credential, nowMs)) {
      credential = await rotateCursorToken(credential, fetcher, signal, nowMs);
      refreshed = credential;
    }
    const token = credential.kind === "oauth" ? credential.oauth.access : credential.secret;

    let usagePayload: unknown;
    try {
      usagePayload = await fetchCursorAuthUsage(token, fetcher, signal);
    } catch (error) {
      // Bridge rotation contract: one rotate + retry on a 401 mid-flow.
      if (
        error instanceof BridgeError &&
        error.kind === "authRequired" &&
        credential.kind === "oauth" &&
        refreshed === undefined &&
        canRotate(credential)
      ) {
        credential = await rotateCursorToken(credential, fetcher, signal, nowMs);
        refreshed = credential;
        usagePayload = await fetchCursorAuthUsage(credential.oauth.access, fetcher, signal);
      } else {
        throw error;
      }
    }

    const legacyLimits = parseCursorUsage(usagePayload);

    // OMP: the dashboard summary only rides OAuth credentials on the default
    // base URL, gated on the JWT subject; failures just drop the rows.
    let summaryLimits: readonly CursorLimit[] = [];
    if (credential.kind === "oauth") {
      const userId = extractCursorAccessTokenUserId(credential.oauth.access);
      if (userId !== undefined) {
        const cookie = `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${credential.oauth.access}`)}`;
        summaryLimits = await fetchCursorSummaryLimits(cookie, fetcher, signal);
      }
    }

    const limits = [...legacyLimits, ...summaryLimits];
    if (limits.length === 0) {
      throw new BridgeError("noData", "cursor usage payload contained no usable quota rows");
    }

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
        windows: limits.map(cursorWindowFromLimit),
      },
      ...(refreshed !== undefined ? { refreshedCredential: refreshed } : {}),
    };
  } catch (error) {
    // Rotation durability: Cursor's exchange can retire the old refresh
    // token, so a rotated bundle must reach the caller even when the retried
    // usage work fails.
    throw rethrowWithRefreshedCredential(error, refreshed);
  }
}

export const cursorConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchCursorUsage,
};

function canRotate(credential: OAuthCredential): boolean {
  return credential.oauth.refresh !== undefined && credential.oauth.refreshEndpoint !== undefined;
}

function needsCursorRotation(credential: BridgeCredential, nowMs: number): credential is OAuthCredential {
  if (credential.kind !== "oauth" || !canRotate(credential)) {
    return false;
  }
  const expiresAtMs = credential.oauth.expiresAtMs;
  return expiresAtMs === undefined || expiresAtMs - nowMs <= ROTATION_WINDOW_MS;
}

async function fetchCursorAuthUsage(token: string, fetcher: Fetcher, signal: AbortSignal): Promise<unknown> {
  const response = await callProviderHttp({
    call: {
      url: AUTH_USAGE_URL,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    fetcher,
    signal,
    endpointLabel: "cursor auth usage",
    extraSecrets: [token],
  });
  return await response.json();
}

/** Dashboard usage-summary via the synthesized session cookie; best-effort per OMP fetchCursorJson. */
async function fetchCursorSummaryLimits(
  cookie: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<readonly CursorLimit[]> {
  try {
    const response = await callProviderHttp({
      call: {
        url: USAGE_SUMMARY_URL,
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: cookie,
        },
      },
      fetcher,
      signal,
      endpointLabel: "cursor usage summary",
    });
    return parseCursorIndividualUsage(await response.json());
  } catch (error) {
    if (signal.aborted && error instanceof BridgeError) {
      throw error;
    }
    return [];
  }
}

/** parseCursorUsage from OMP usage/cursor.ts: legacy /auth/usage row mapping. */
function parseCursorUsage(payload: unknown): CursorLimit[] {
  if (!isRecord(payload)) {
    return [];
  }
  const resetsAtMs = deriveCursorResetsAt(payload);
  const limits: CursorLimit[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (!isRecord(value)) {
      continue;
    }
    // OMP used chain: numRequests, used, amountUsed, usdUsed.
    const usedVal =
      toNumber(value["numRequests"]) ?? toNumber(value["used"]) ?? toNumber(value["amountUsed"]) ?? toNumber(value["usdUsed"]);
    // OMP limit chain: maxRequestUsage, limit, amountLimit, usdLimit.
    const limitVal =
      toNumber(value["maxRequestUsage"]) ??
      toNumber(value["limit"]) ??
      toNumber(value["amountLimit"]) ??
      toNumber(value["usdLimit"]);
    if (usedVal === undefined || limitVal === undefined) {
      continue;
    }
    const lower = key.toLowerCase();
    const isUsd = key === "planUsage" || lower.includes("usd") || lower.includes("billing") || lower.includes("stripe");
    limits.push({
      id: isUsd ? `cursor:usd:${lower.trim()}` : `cursor:requests:${lower.trim()}`,
      label: isUsd ? `${key} spend` : `${key} requests`,
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
      amount: {
        used: usedVal,
        limit: limitVal,
        usedFraction: limitVal > 0 ? usedVal / limitVal : 0,
        unit: isUsd ? "usd" : "requests",
      },
    });
  }
  return limits;
}

/** parseTimestamp from OMP usage/cursor.ts: numeric seconds/ms, else ISO. */
function parseCursorTimestamp(value: unknown): number | undefined {
  const numeric = toNumber(value);
  if (numeric !== undefined) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  return parseIsoTimestamp(value);
}

/** deriveResetsAt from OMP usage/cursor.ts. */
function deriveCursorResetsAt(payload: Readonly<Record<string, unknown>>): number | undefined {
  for (const key of ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"]) {
    const parsed = parseCursorTimestamp(payload[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  for (const key of ["startOfMonth", "billingCycleStart", "startOfBillingCycle"]) {
    const parsed = parseCursorTimestamp(payload[key]);
    if (parsed !== undefined) {
      const date = new Date(parsed);
      date.setUTCMonth(date.getUTCMonth() + 1);
      return date.getTime();
    }
  }
  return undefined;
}

/**
 * parseCursorCentsBucket from OMP usage/cursor.ts: `used`/`limit`/`remaining`
 * in USD cents; null for disabled or malformed buckets; limit-less buckets
 * stay usage-only (no invented fraction).
 */
function parseCursorCentsBucket(bucket: Readonly<Record<string, unknown>>): CursorAmount | null {
  if (bucket["enabled"] === false) {
    return null;
  }
  const reportedUsed = toNumber(bucket["used"]);
  const reportedRemaining = toNumber(bucket["remaining"]);
  const hasValidUsed = reportedUsed !== undefined && reportedUsed >= 0;
  const hasValidRemaining = reportedRemaining !== undefined && reportedRemaining >= 0;
  const limit = toNumber(bucket["limit"]);

  if (bucket["limit"] === null || bucket["limit"] === undefined) {
    if (!hasValidUsed) {
      return null;
    }
    return { used: reportedUsed / 100, unit: "usd" };
  }
  if (limit === undefined || limit <= 0) {
    return null;
  }
  let used: number;
  if (reportedUsed !== undefined && reportedUsed > 0) {
    used = reportedUsed;
  } else if (hasValidRemaining && reportedRemaining < limit) {
    used = Math.max(0, limit - reportedRemaining);
  } else if (hasValidUsed) {
    used = reportedUsed;
  } else {
    return null;
  }
  return {
    used: used / 100,
    limit: limit / 100,
    usedFraction: used / limit,
    unit: "usd",
  };
}

/**
 * parseCursorPlanDashboardAmounts from OMP usage/cursor.ts: Pro+ exposes
 * separate auto/api percent pools instead of one shared percent; percent-only
 * rows never invent a limit.
 */
function parseCursorPlanDashboardAmounts(bucket: Readonly<Record<string, unknown>>): {
  auto?: CursorAmount;
  api?: CursorAmount;
  fallback?: CursorAmount;
} {
  if (bucket["enabled"] === false) {
    return {};
  }
  const limitCents = toNumber(bucket["limit"]);
  const limitUsd = limitCents !== undefined && limitCents > 0 ? limitCents / 100 : undefined;
  const autoPct = toNumber(bucket["autoPercentUsed"]);
  const apiPct = toNumber(bucket["apiPercentUsed"]);
  const totalPct = toNumber(bucket["totalPercentUsed"]);

  const fromPercent = (pct: number, withLimit: boolean): CursorAmount => {
    const usedFraction = Math.max(0, pct) / 100;
    if (withLimit && limitUsd !== undefined) {
      return { used: limitUsd * usedFraction, limit: limitUsd, usedFraction, unit: "usd" };
    }
    return { used: usedFraction * 100, usedFraction, unit: "percent" };
  };

  const result: { auto?: CursorAmount; api?: CursorAmount; fallback?: CursorAmount } = {};
  if (autoPct !== undefined) {
    result.auto = fromPercent(autoPct, false);
  }
  if (apiPct !== undefined) {
    result.api = fromPercent(apiPct, true);
  }
  if (result.auto === undefined && result.api === undefined) {
    if (totalPct !== undefined) {
      result.fallback = fromPercent(totalPct, true);
    } else {
      const cents = parseCursorCentsBucket(bucket);
      if (cents !== null) {
        result.fallback = cents;
      }
    }
  }
  return result;
}

/** pushCursorPlanRails + parseCursorIndividualUsage from OMP usage/cursor.ts. */
function parseCursorIndividualUsage(payload: unknown): CursorLimit[] {
  if (!isRecord(payload) || !isRecord(payload["individualUsage"])) {
    return [];
  }
  const individual = payload["individualUsage"];
  const resetsAtMs = deriveCursorResetsAt(payload);
  const limits: CursorLimit[] = [];

  // Prefer a usable overall bucket; fall through to plan rails otherwise.
  const overall = isRecord(individual["overall"]) ? individual["overall"] : undefined;
  const plan = isRecord(individual["plan"]) ? individual["plan"] : undefined;
  let usedOverall = false;
  if (overall !== undefined) {
    const amount = parseCursorCentsBucket(overall);
    if (amount !== null) {
      usedOverall = true;
      limits.push({
        id: "cursor:usd:individual-overall",
        label: "Personal Usage",
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        amount,
      });
    }
  }
  if (!usedOverall && plan !== undefined) {
    const rails = parseCursorPlanDashboardAmounts(plan);
    if (rails.auto !== undefined) {
      limits.push({
        id: "cursor:usd:individual-auto",
        label: "Cursor Models",
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        amount: rails.auto,
      });
    }
    if (rails.api !== undefined) {
      limits.push({
        id: "cursor:usd:individual-api",
        label: "Other Models",
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        amount: rails.api,
      });
    }
    if (rails.fallback !== undefined) {
      limits.push({
        id: "cursor:usd:individual-plan",
        label: "Personal Usage",
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        amount: rails.fallback,
      });
    }
  }

  // On-demand rides along even when the included bucket is absent/unusable.
  if (isRecord(individual["onDemand"])) {
    const amount = parseCursorCentsBucket(individual["onDemand"]);
    if (amount !== null && amount.limit !== undefined && amount.limit > 0) {
      limits.push({
        id: "cursor:usd:individual-ondemand",
        label: "On-Demand Usage",
        ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
        amount,
      });
    }
  }
  return limits;
}

function cursorWindowFromLimit(limit: CursorLimit): UsageWindow {
  return {
    id: limit.id,
    label: limit.label,
    unit: limit.amount.unit,
    ...(limit.amount.usedFraction !== undefined ? { resolvedFraction: limit.amount.usedFraction } : {}),
    severity: usageStatus(limit.amount.usedFraction),
    ...(limit.amount.used !== undefined ? { used: limit.amount.used } : {}),
    ...(limit.amount.limit !== undefined ? { limit: limit.amount.limit } : {}),
    ...(limit.resetsAtMs !== undefined ? { resetsAtMs: limit.resetsAtMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Auth module (OMP packages/ai/src/registry/oauth/cursor.ts + registry/cursor.ts)
// ---------------------------------------------------------------------------

const platformFetch: Fetcher = (url, init) => fetch(url, init);

export type CursorLoginDeps = {
  readonly fetcher: Fetcher;
  /** Injectable browser opener; defaults to the macOS `open` spawn. */
  readonly openBrowser?: BrowserOpener;
  /** Injectable poll sleep; defaults to Bun.sleep so tests stay instant. */
  readonly sleep?: (ms: number) => Promise<void>;
};

function cursorLoginCancelled(): BridgeError {
  return new BridgeError("timeout", "Cursor login was cancelled");
}

function throwIfCursorLoginCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cursorLoginCancelled();
  }
}

/** Dispatch a cursor login by method (tests inject deps; production uses fetch). */
export async function loginCursor(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: CursorLoginDeps,
): Promise<LoginResult> {
  try {
    if (signal.aborted) {
      throw cursorLoginCancelled();
    }
    if (method === "browser") {
      return await loginCursorBrowser(events, signal, deps);
    }
    if (method === "apiKey") {
      return await loginCursorApiKey(inputs, events, signal, deps);
    }
    throw new BridgeError("invalidRequest", `provider "cursor" does not offer login method "${method}"`);
  } catch (error) {
    if (error instanceof BridgeError) {
      if (error.kind === "timeout" && signal.aborted) {
        throw cursorLoginCancelled();
      }
      throw error;
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw cursorLoginCancelled();
    }
    throw error;
  }
}

export const cursorAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["browser", "apiKey"],
  login: (method, inputs, events, signal) => loginCursor(method, inputs, events, signal, { fetcher: platformFetch }),
  refresh: (credential, signal) => refreshCursorCredential(credential, signal),
};

/** OMP-like per-request bound for the apiKey validation probe. */
const API_KEY_VALIDATION_TIMEOUT_MS = 30_000;

/**
 * Bridge addition (OMP accepts api_key credentials for usage): the pasted
 * access token / API key is validated with the exact request the usage path
 * makes (GET /auth/usage, the raw key as the plain Bearer token) before it
 * becomes a bearer credential, trimmed like OMP.
 */
async function loginCursorApiKey(
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: CursorLoginDeps,
): Promise<LoginResult> {
  events.onEvent({ type: "pasteHint", detail: "Paste your Cursor access token or API key." });
  throwIfCursorLoginCancelled(signal);
  const secret = inputs.apiKey?.trim() ?? "";
  if (secret === "") {
    throw new BridgeError("invalidRequest", "cursor apiKey login requires inputs.apiKey");
  }
  events.onEvent({ type: "waiting", detail: "Validating API key..." });
  await callProviderHttp({
    call: {
      url: AUTH_USAGE_URL,
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${secret}`,
      },
    },
    fetcher: deps.fetcher,
    signal: AbortSignal.any([signal, AbortSignal.timeout(API_KEY_VALIDATION_TIMEOUT_MS)]),
    endpointLabel: "cursor API key validation endpoint",
    extraSecrets: [secret],
  });
  return { credential: { kind: "bearer", secret } };
}

/**
 * OMP generateCursorAuthParams + loginCursor + pollCursorAuth: PKCE + UUID
 * login URL opened in the browser, then poll the auth endpoint until Cursor
 * hands back the token pair.
 */
async function loginCursorBrowser(events: AuthEvents, signal: AbortSignal, deps: CursorLoginDeps): Promise<LoginResult> {
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();
  // OMP parameter order: challenge, uuid, mode, redirectTarget.
  const loginUrl = `${CURSOR_LOGIN_URL}?${new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  }).toString()}`;

  events.onEvent({ type: "openUrl", url: loginUrl });
  
  events.onEvent({ type: "waiting", detail: "Waiting for browser authentication..." });

  const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier, signal, deps);
  const userId = extractCursorAccessTokenUserId(accessToken);
  return {
    credential: {
      kind: "oauth",
      secret: accessToken,
      oauth: {
        access: accessToken,
        ...(refreshToken !== "" ? { refresh: refreshToken } : {}),
        expiresAtMs: cursorTokenExpiry(accessToken, Date.now()),
        refreshEndpoint: CURSOR_REFRESH_URL,
        ...(userId !== undefined ? { identity: { userId } } : {}),
      },
    },
    ...(userId !== undefined ? { accountLabel: userId } : {}),
  };
}

/** pollCursorAuth from OMP registry/oauth/cursor.ts (sleep-first, 1.2x backoff). */
async function pollCursorAuth(
  uuid: string,
  verifier: string,
  signal: AbortSignal,
  deps: CursorLoginDeps,
): Promise<{ accessToken: string; refreshToken: string }> {
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    throwIfCursorLoginCancelled(signal);
    await sleep(delay);
    throwIfCursorLoginCancelled(signal);
    try {
      const response = await callProviderHttp({
        // OMP concatenates the query raw: ?uuid=<uuid>&verifier=<verifier>.
        call: { url: `${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}` },
        fetcher: deps.fetcher,
        signal,
        endpointLabel: "cursor auth poll",
        statusMap: { 404: "noData" },
      });
      const data = await response.json();
      if (!isRecord(data) || typeof data["accessToken"] !== "string" || data["accessToken"] === "") {
        // OMP would store undefined tokens; bridge credentials need a secret.
        throw new BridgeError("malformedPayload", "cursor auth poll returned no access token");
      }
      return {
        accessToken: data["accessToken"],
        refreshToken: typeof data["refreshToken"] === "string" ? data["refreshToken"] : "",
      };
    } catch (error) {
      if (error instanceof BridgeError && error.kind === "timeout" && signal.aborted) {
        throw cursorLoginCancelled();
      }
      if (error instanceof BridgeError && error.kind === "noData") {
        // OMP: 404 means "not authorized yet" — reset the error budget and back off.
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
        continue;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw new BridgeError("upstreamError", "Too many consecutive errors during Cursor auth polling");
      }
    }
  }
  throw new BridgeError("timeout", "Cursor authentication polling timeout");
}

/**
 * refreshCursorToken from OMP registry/oauth/cursor.ts, ported verbatim:
 * POST the exchange endpoint with the refresh token as Bearer and an empty
 * JSON body; a missing refreshToken keeps the current one.
 */
async function rotateCursorToken(
  credential: OAuthCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
  nowMs: number,
): Promise<OAuthCredential> {
  const refresh = credential.oauth.refresh;
  const refreshEndpoint = credential.oauth.refreshEndpoint;
  if (refresh === undefined || refreshEndpoint === undefined) {
    throw new BridgeError("authRequired", "cursor token refresh requires a refresh token and refresh endpoint");
  }
  const response = await callProviderHttp({
    call: {
      url: refreshEndpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${refresh}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    fetcher,
    signal,
    endpointLabel: "cursor token refresh",
    extraSecrets: [credential.oauth.access, refresh],
  });
  const data = await response.json();
  if (!isRecord(data) || typeof data["accessToken"] !== "string" || data["accessToken"] === "") {
    throw new BridgeError("authRequired", "cursor token refresh returned no access token");
  }
  const access = data["accessToken"];
  const rotatedRefresh = typeof data["refreshToken"] === "string" && data["refreshToken"] !== "" ? data["refreshToken"] : refresh;
  return {
    kind: "oauth",
    secret: access,
    oauth: {
      access,
      refresh: rotatedRefresh,
      expiresAtMs: cursorTokenExpiry(access, nowMs),
      refreshEndpoint,
      ...(credential.oauth.clientId !== undefined ? { clientId: credential.oauth.clientId } : {}),
      ...(credential.oauth.identity !== undefined ? { identity: credential.oauth.identity } : {}),
    },
  };
}

/** AuthModule.refresh surface over the OMP refreshCursorToken port. */
export async function refreshCursorCredential(
  credential: BridgeCredential,
  signal: AbortSignal,
  fetcher: Fetcher = platformFetch,
): Promise<BridgeCredential> {
  if (credential.kind !== "oauth" || !canRotate(credential)) {
    throw new BridgeError("invalidRequest", "cursor token refresh requires an oauth credential with a refresh token and endpoint");
  }
  return await rotateCursorToken(credential, fetcher, signal, Date.now());
}
