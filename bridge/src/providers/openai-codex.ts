/**
 * OpenAI Codex (ChatGPT subscription OAuth) provider: usage connector +
 * browser/device auth module, hand-ported from the pinned oh-my-pi checkout
 * @ 8500092296621a6826b7136e840f8a59ea338958:
 *
 * - packages/ai/src/registry/oauth/openai-codex.ts  (client id, authorize
 *   and token endpoints, PKCE browser flow with the fixed loopback listener
 *   plus the manual paste race, headless device authorization,
 *   authorization-code and refresh grants, JWT identity extraction, manual
 *   paste parsing)
 * - packages/ai/src/registry/oauth/callback-server.ts (the fixed-port
 *   callback bind policy and the callback-vs-manual-input race)
 * - packages/ai/src/usage/openai-codex.ts           (wham/usage fetch +
 *   window normalization + rate-limit-reset credit count)
 * - packages/ai/src/usage/openai-codex-base-url.ts  (ChatGPT base URL
 *   normalization)
 * - packages/ai/src/usage/openai-codex-reset.ts     (saved-reset credit
 *   list endpoint and count sync)
 * - packages/catalog/src/wire/codex.ts              (CODEX_BASE_URL,
 *   ORIGINATOR_CODEX "pi")
 * - packages/utils/src/dirs.ts                      (USER_AGENT "omp/17.3.7")
 *
 * Kept from the OMP sources (same endpoints, client id, request bodies and
 * normalization boundaries):
 * - Browser login: authorization URL at auth.openai.com/oauth/authorize with
 *   the embedded client id app_EMoamEEZ73f0CkXaXp7hrann, PKCE S256, the
 *   fixed redirect http://localhost:1455/auth/callback, the exact Codex
 *   scope, id_token_add_organizations=true,
 *   codex_cli_simplified_flow=true and originator=pi; the fixed port is
 *   bound with no random-port fallback (OpenAI validates the redirect
 *   against its registered allowlist, OMP redirectUri +
 *   allowPortFallback:false rationale); the captured redirect races the
 *   manual paste prompt (OMP #waitForCallback + onManualCodeInput): each
 *   paste is parsed with OMP's parseCallbackInput (URL / query-string /
 *   raw code[#state]) and an unusable paste (no code, or a state mismatch
 *   when the paste carries one) re-prompts; the token exchange is a
 *   form-urlencoded authorization_code grant at auth.openai.com/oauth/token;
 *   identity (chatgpt_account_id, email, plan type) is decoded from the
 *   access/id token JWT claims and the login fails without an account id;
 *   expiry = now + expires_in (no skew).
 * - Device login (OMP loginOpenAICodexDevice): POST
 *   auth.openai.com/api/accounts/deviceauth/usercode with the client id,
 *   then poll /api/accounts/deviceauth/token with {device_auth_id,
 *   user_code} where 403/404 mean authorization pending; the user visits
 *   auth.openai.com/codex/device and enters the code; polling waits
 *   interval seconds (number or numeric string, default 5) + 3s safety
 *   margin with a 5s first-wait cap, at most 120 polls; the poll returns
 *   {authorization_code, code_verifier} which the shared token exchange
 *   redeems over the redirect https://auth.openai.com/deviceauth/callback.
 * - Refresh: form-urlencoded refresh_token grant (grant_type, refresh_token,
 *   client_id) at the same token endpoint; every token response must carry
 *   access_token, refresh_token and expires_in (OMP validation boundary).
 * - Usage: GET {base}/wham/usage with Bearer access, User-Agent omp/17.3.7
 *   and ChatGPT-Account-Id when an account id is known (credential identity
 *   first, then the access-token JWT claim). {base} normalizes exactly like
 *   OMP: only chatgpt.com / chat.openai.com origins are honored (any extra
 *   path collapses to the origin's /backend-api); anything else falls back
 *   to https://chatgpt.com/backend-api. When the payload reports
 *   rate_limit_reset_credits.available_count > 0 the live count syncs from
 *   GET {base}/wham/rate-limit-reset-credits (best-effort: every failure
 *   keeps the stale payload count, OMP listCodexResetCredits null handling).
 * - Normalization: primary/secondary windows -> ids openai-codex:primary /
 *   openai-codex:secondary with labels from limit_window_seconds (>= 1 day
 *   -> "N Days"/"1 Day" -> `<n>d`; else rounded hours with a 1h floor ->
 *   "N Hours" -> `<n>h`; without a duration the OMP "Primary window"/
 *   "Secondary window" fallback labels), reset time from reset_at (seconds
 *   -> ms coercion) else now + reset_after_seconds, percent amounts clamped
 *   to [0,100] with used/limit <percent>/100; additional_rate_limits become
 *   openai-codex:<slug>:<key> windows ("spark" when the limit name or
 *   metered feature mentions spark/bengalfox, else the slugified metered
 *   feature or limit name) labeled "<window> (<display name>)"; severity
 *   bands: >=1 exhausted — downgraded to warning only while the meter still
 *   explicitly allows (allowed=true && limit_reached=false) — >=0.9 warning,
 *   else ok, unknown without a percent.
 *
 * Identity fallback updated from registry/oauth/openai-codex.ts at
 * d720e81fb747132f0b6c6c0f44eafc887552ec7f; no inference/transport migration.
 *
 * Deviations from the OMP sources (with reasons):
 * - Severity uses the shared wire bands (warning >=0.8, critical >=0.95,
 *   exhausted >=1), even when upstream flags explicitly allow further use.
 *   Swift validates severity against the fraction, not those metadata flags.
 * - JWT identity is decoded, not signature/issuer/audience verified. It is
 *   workspace/display metadata, not proof of a verified email or identity.
 *   Access claims take precedence; absent claims fall back to the ID token.
 *   Refresh preserves the entire login identity instead of re-inferring it.
 * - The loopback listener binds a single 127.0.0.1 socket (the shared
 *   ../auth/loopback module) where OMP's `localhost` flows bind both the
 *   IPv4 and IPv6 loopback families; the advertised redirect stays
 *   http://localhost:1455/auth/callback exactly as OpenAI registers it.
 * - OMP's interactive onManualCodeInput prompt becomes an injectable
 *   readPaste dependency; production routes it through the duplex AuthEvents
 *   requestInput channel (stdin remains the versioned NDJSON session — the
 *   bridge never reads /dev/tty). Without a paste source the login waits on
 *   the listener alone.
 * - A busy port 1455 maps OMP's ConfigurationError to BridgeError
 *   dependencyUnavailable (with the OMP-style "free the port" message plus
 *   the device-method alternative).
 * - OMP's Bun.sleep device waits are replaced by the abortable node
 *   scheduler wait, so cancellation settles immediately instead of after
 *   the current interval; the cancelled message keeps OMP's text.
 * - OMP's AIError kinds collapse onto BridgeError kinds: device-flow status
 *   failures map 401 -> authRequired, 429 -> rateLimited, else upstreamError
 *   (OMP messages verbatim), and validation failures -> malformedPayload.
 * - OMP's formatOpenAICodexTokenEndpointError body detail is dropped:
 *   callProviderHttp throws on non-OK before the body is readable, and the
 *   status-only message can never carry secret material.
 * - OMP's UsageReport metadata (planType, allowed/limitReached flags, email,
 *   accountId, meterStates) and the reset-credit objects (granted/expires
 *   timestamps) have no bridge surface; the synced available_count surfaces
 *   as resetCredits on the primary chat window.
 * - OMP null-report outcomes become typed BridgeErrors: HTTP failures map
 *   through callProviderHttp's status map, a payload with no usable windows
 *   -> noData, and the expired-token short-circuit (no refresh material)
 *   -> noData.
 * - Token rotation (pre-flight when expiresAtMs is missing or within 60s of
 *   the fetch, and once after a mid-flow 401) is bridge protocol and returns
 *   refreshedCredential; OMP leaves refresh to AuthStorage. The connector
 *   stamps rotation expiry from the request's nowMs for determinism, while
 *   login keeps OMP's Date.now().
 * - The base URL override rides credential identity.baseUrl (the bridge
 *   request has no config surface; login stores inputs.apiBaseUrl there);
 *   OMP reads providers.openai-codex.baseUrl.
 */

import { scheduler } from "node:timers/promises";
import { verificationUriWithUserCode } from "../auth/device";
import { defaultBrowserOpener, openInBrowser } from "../auth/open-browser";
import type { BrowserOpener } from "../auth/open-browser";
import {
  CallbackCancelledError,
  CallbackFailedError,
  generateCallbackState,
  startLoopbackCallback,
} from "../auth/loopback";
import type { CallbackResult, LoopbackCallbackHandle } from "../auth/loopback";
import { generatePKCE } from "../auth/pkce";
import { rethrowWithRefreshedCredential } from "../auth/refresh";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type {
  BridgeCredential,
  BridgeRequest,
  BridgeSuccessResponse,
  OAuthCredential,
  UsageReport,
  UsageWindow,
} from "../protocol";

const PROVIDER_ID = "openai-codex";
const CONNECTOR_VERSION = "openai-codex-1";

// OMP packages/ai/src/registry/oauth/openai-codex.ts, verbatim.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
/** OMP TOKEN_REQUEST_TIMEOUT_MS. */
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
// OMP loginOpenAICodexDevice constants, verbatim.
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** OMP DEVICE_MAX_POLLS: upper bound on device-code polling. */
const DEVICE_MAX_POLLS = 120;

// OMP packages/catalog/src/wire/codex.ts.
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
/** OMP OPENAI_HEADER_VALUES.ORIGINATOR_CODEX. */
const ORIGINATOR_CODEX = "pi";

// OMP packages/utils/src/dirs.ts: USER_AGENT = `omp/${VERSION}` at the pin.
const USER_AGENT = "omp/17.3.7";

// OMP packages/ai/src/usage/openai-codex.ts + openai-codex-reset.ts.
const USAGE_PATH = "wham/usage";
const RESET_CREDITS_PATH = "wham/rate-limit-reset-credits";

/** Bridge pre-rotation window: rotate when expiry is missing or this close. */
const ROTATION_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Shared small helpers (OMP pi-catalog toNumber, oauth decodeJwt, usage
// base64UrlDecode/parseJwt)
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

type CodexJwtPayload = {
  readonly [JWT_CLAIM_PATH]?: { readonly chatgpt_account_id?: string; readonly chatgpt_plan_type?: string };
  readonly [JWT_PROFILE_CLAIM]?: { readonly email?: string };
};

/** OMP decodeJwt (registry/oauth/openai-codex.ts): base64 JWT payload claim decode. */
function decodeCodexJwt(token: string): CodexJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64").toString("utf-8")) as CodexJwtPayload;
  } catch {
    return null;
  }
}

/**
 * OMP getTokenProfile: the ChatGPT workspace id, email and plan type decoded
 * from unverified access claims, falling back field-wise to the ID token.
 */
function getTokenProfile(
  accessToken: string,
  idToken?: string,
): { accountId?: string | undefined; email?: string | undefined; planType?: string | undefined } {
  const payload = decodeCodexJwt(accessToken);
  const idPayload = idToken !== undefined ? decodeCodexJwt(idToken) : null;
  const auth = payload?.[JWT_CLAIM_PATH];
  const idAuth = idPayload?.[JWT_CLAIM_PATH];
  const accountId = auth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id;
  const email = (payload?.[JWT_PROFILE_CLAIM]?.email ?? idPayload?.[JWT_PROFILE_CLAIM]?.email)?.trim().toLowerCase();
  const planType = (auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type)?.trim().toLowerCase();
  return {
    accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
    email: typeof email === "string" && email.length > 0 ? email : undefined,
    planType: typeof planType === "string" && planType.length > 0 ? planType : undefined,
  };
}

// ---------------------------------------------------------------------------
// Usage normalization (OMP packages/ai/src/usage/openai-codex.ts)
// ---------------------------------------------------------------------------

interface ParsedUsageWindow {
  readonly usedPercent?: number;
  readonly limitWindowSeconds?: number;
  readonly resetAfterSeconds?: number;
  readonly resetAt?: number;
}

interface ParsedAdditionalUsage {
  readonly limitName?: string;
  readonly meteredFeature?: string;
  readonly allowed?: boolean;
  readonly limitReached?: boolean;
  readonly primary?: ParsedUsageWindow;
  readonly secondary?: ParsedUsageWindow;
}

interface ParsedUsage {
  readonly allowed?: boolean | undefined;
  readonly limitReached?: boolean | undefined;
  readonly primary?: ParsedUsageWindow | undefined;
  readonly secondary?: ParsedUsageWindow | undefined;
  readonly additional: readonly ParsedAdditionalUsage[];
}

function toBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseUsageWindow(value: unknown): ParsedUsageWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = toNumber(value["used_percent"]);
  const limitWindowSeconds = toNumber(value["limit_window_seconds"]);
  const resetAfterSeconds = toNumber(value["reset_after_seconds"]);
  const resetAt = toNumber(value["reset_at"]);
  if (
    usedPercent === undefined &&
    limitWindowSeconds === undefined &&
    resetAfterSeconds === undefined &&
    resetAt === undefined
  ) {
    return undefined;
  }
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(limitWindowSeconds !== undefined ? { limitWindowSeconds } : {}),
    ...(resetAfterSeconds !== undefined ? { resetAfterSeconds } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
  };
}

function parseAdditionalRateLimit(value: unknown): ParsedAdditionalUsage | null {
  if (!isRecord(value)) return null;
  const limitName = typeof value["limit_name"] === "string" ? value["limit_name"] : undefined;
  const meteredFeature = typeof value["metered_feature"] === "string" ? value["metered_feature"] : undefined;
  const rateLimit = isRecord(value["rate_limit"]) ? value["rate_limit"] : undefined;
  if (rateLimit === undefined) return null;
  const primary = parseUsageWindow(rateLimit["primary_window"]);
  const secondary = parseUsageWindow(rateLimit["secondary_window"]);
  const allowed = toBoolean(rateLimit["allowed"]);
  const limitReached = toBoolean(rateLimit["limit_reached"]);
  if (primary === undefined && secondary === undefined && allowed === undefined && limitReached === undefined) {
    return null;
  }
  return {
    ...(limitName !== undefined ? { limitName } : {}),
    ...(meteredFeature !== undefined ? { meteredFeature } : {}),
    ...(allowed !== undefined ? { allowed } : {}),
    ...(limitReached !== undefined ? { limitReached } : {}),
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
  };
}

function parseUsagePayload(value: unknown): ParsedUsage | null {
  if (!isRecord(value)) return null;
  const rateLimit = isRecord(value["rate_limit"]) ? value["rate_limit"] : undefined;
  const additionalRaw = Array.isArray(value["additional_rate_limits"]) ? value["additional_rate_limits"] : [];
  const additional = additionalRaw
    .map(parseAdditionalRateLimit)
    .filter((entry): entry is ParsedAdditionalUsage => entry !== null);
  if (rateLimit === undefined && additional.length === 0) return null;
  const parsed: ParsedUsage = {
    ...(rateLimit !== undefined ? { allowed: toBoolean(rateLimit["allowed"]) } : {}),
    ...(rateLimit !== undefined ? { limitReached: toBoolean(rateLimit["limit_reached"]) } : {}),
    ...(rateLimit !== undefined ? { primary: parseUsageWindow(rateLimit["primary_window"]) } : {}),
    ...(rateLimit !== undefined ? { secondary: parseUsageWindow(rateLimit["secondary_window"]) } : {}),
    additional,
  };
  if (
    parsed.primary === undefined &&
    parsed.secondary === undefined &&
    parsed.allowed === undefined &&
    parsed.limitReached === undefined &&
    parsed.additional.length === 0
  ) {
    return null;
  }
  return parsed;
}

/**
 * OMP parseResetCredits: the rate_limit_reset_credits block of /wham/usage,
 * reduced to the banked-reset count (the credit objects have no bridge
 * surface).
 */
function parseResetCredits(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const block = value["rate_limit_reset_credits"];
  if (!isRecord(block)) return undefined;
  const availableCount = toNumber(block["available_count"]);
  if (availableCount === undefined) return undefined;
  return Math.max(0, Math.trunc(availableCount));
}

/**
 * OMP listCodexResetCredits payload parse: null on a non-object (the fetch
 * failure paths stay in the caller), otherwise the reported available_count
 * with the available-credit count as fallback.
 */
function parseResetCreditList(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const credits = Array.isArray(value["credits"])
    ? value["credits"].filter((entry): entry is Record<string, unknown> => isRecord(entry))
    : [];
  const reported = toNumber(value["available_count"]);
  if (reported !== undefined) {
    return Math.max(0, Math.trunc(reported));
  }
  return credits.filter((entry) => {
    const status = entry["status"];
    return (typeof status === "string" ? status : "available") === "available";
  }).length;
}

/** OMP formatWindowLabel: "5 Hours", "1 Hour". */
function formatWindowLabel(value: number, unit: "hour" | "day"): string {
  const rounded = Math.round(value);
  const suffix = rounded === 1 ? unit : `${unit}s`;
  return `${rounded} ${suffix}`;
}

/** OMP buildWindowLabel: window id + label from limit_window_seconds. */
function buildWindowIdentity(seconds: number, key: "primary" | "secondary"): { id: string; label: string } {
  const daySeconds = 86_400;
  if (seconds >= daySeconds) {
    const days = Math.round(seconds / daySeconds);
    return { id: `${days}d`, label: formatWindowLabel(days, "day") };
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return { id: `${hours}h`, label: formatWindowLabel(hours, "hour") };
}

/**
 * OMP resolveResetTime: reset_at coerced seconds->ms when it predates the
 * ms era, else now + reset_after_seconds.
 */
function resolveResetTimeMs(window: ParsedUsageWindow, nowMs: number): number | undefined {
  if (window.resetAt !== undefined) {
    const resetAtMs = window.resetAt > 1_000_000_000_000 ? window.resetAt : window.resetAt * 1000;
    if (Number.isFinite(resetAtMs)) return resetAtMs;
  }
  if (window.resetAfterSeconds !== undefined) {
    return nowMs + window.resetAfterSeconds * 1000;
  }
  return undefined;
}

/** One bridge UsageWindow per OMP-normalized Codex limit. */
function buildCodexWindow(args: {
  readonly id: string;
  readonly key: "primary" | "secondary";
  readonly window: ParsedUsageWindow;
  readonly allowed?: boolean | undefined;
  readonly limitReached?: boolean | undefined;
  readonly displayName?: string;
  readonly nowMs: number;
}): UsageWindow {
  const identity =
    args.window.limitWindowSeconds !== undefined
      ? buildWindowIdentity(args.window.limitWindowSeconds, args.key)
      : {
          id: args.key,
          label: args.key === "primary" ? "Primary window" : "Secondary window",
        };
  const label =
    args.displayName !== undefined ? `${identity.label} (${args.displayName})` : identity.label;
  const resetsAtMs = resolveResetTimeMs(args.window, args.nowMs);
  const usedPercent = args.window.usedPercent;
  if (usedPercent === undefined) {
    return {
      id: args.id,
      label,
      unit: "percent",
      severity: "unknown",
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    };
  }
  const clamped = Math.min(Math.max(usedPercent, 0), 100);
  const usedFraction = clamped / 100;
  return {
    id: args.id,
    label,
    unit: "percent",
    resolvedFraction: usedFraction,
    severity: severityForFraction(usedFraction),
    used: clamped,
    limit: 100,
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

/** OMP additionalLimitSlug: spark/bengalfox probes, else slugified source. */
function additionalLimitSlug(limitName: string | undefined, meteredFeature: string | undefined): string {
  const probe = `${limitName ?? ""} ${meteredFeature ?? ""}`.toLowerCase();
  if (probe.includes("spark") || probe.includes("bengalfox")) return "spark";
  const source = (meteredFeature ?? limitName ?? "extra").toLowerCase();
  return (
    source
      .replace(/^codex[-_]/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "extra"
  );
}

/** OMP additionalDisplayName. */
function additionalDisplayName(slug: string, limitName: string | undefined): string {
  if (slug === "spark") return "Spark";
  if (limitName !== undefined) return limitName;
  return slug.replace(/(^|-)([a-z])/g, (_match, separator: string, character: string) =>
    `${separator === "-" ? " " : ""}${character.toUpperCase()}`,
  );
}

function buildCodexWindows(parsed: ParsedUsage, nowMs: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const flags = { allowed: parsed.allowed, limitReached: parsed.limitReached };
  if (parsed.primary !== undefined) {
    windows.push(buildCodexWindow({ id: "openai-codex:primary", key: "primary", window: parsed.primary, ...flags, nowMs }));
  }
  if (parsed.secondary !== undefined) {
    windows.push(
      buildCodexWindow({ id: "openai-codex:secondary", key: "secondary", window: parsed.secondary, ...flags, nowMs }),
    );
  }
  for (const extra of parsed.additional) {
    const slug = additionalLimitSlug(extra.limitName, extra.meteredFeature);
    const displayName = additionalDisplayName(slug, extra.limitName);
    const extraFlags = { allowed: extra.allowed, limitReached: extra.limitReached };
    if (extra.primary !== undefined) {
      windows.push(
        buildCodexWindow({
          id: `openai-codex:${slug}:primary`,
          key: "primary",
          window: extra.primary,
          displayName,
          ...extraFlags,
          nowMs,
        }),
      );
    }
    if (extra.secondary !== undefined) {
      windows.push(
        buildCodexWindow({
          id: `openai-codex:${slug}:secondary`,
          key: "secondary",
          window: extra.secondary,
          displayName,
          ...extraFlags,
          nowMs,
        }),
      );
    }
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Token rotation (OMP refreshOpenAICodexToken)
// ---------------------------------------------------------------------------

/**
 * OMP refreshOpenAICodexToken: form-urlencoded refresh_token grant with the
 * embedded client id; every response must carry access_token, refresh_token
 * and expires_in. Workspace identity is never rewritten (the workspace is
 * fixed at login, OMP comment).
 */
async function rotateCodexToken(
  credential: OAuthCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
  nowMs: number,
): Promise<OAuthCredential> {
  const oauth = credential.oauth;
  const refreshToken = oauth.refresh;
  const refreshEndpoint = oauth.refreshEndpoint;
  if (refreshToken === undefined || refreshEndpoint === undefined) {
    throw new BridgeError("authRequired", "openai-codex token rotation requires a refresh token and refresh endpoint");
  }
  const clientId = oauth.clientId ?? CLIENT_ID;
  const response = await callProviderHttp({
    call: {
      url: refreshEndpoint,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: refreshToken,
      }).toString(),
    },
    fetcher,
    signal,
    endpointLabel: "OpenAI Codex token refresh",
    extraSecrets: [credential.secret, oauth.access, refreshToken],
  });

  const data = await response.json();
  if (!isRecord(data)) {
    throw new BridgeError("malformedPayload", "Token response missing required fields");
  }
  const access = typeof data["access_token"] === "string" ? data["access_token"] : "";
  const rotatedRefresh = typeof data["refresh_token"] === "string" ? data["refresh_token"] : "";
  const expiresIn = data["expires_in"];
  if (access === "" || rotatedRefresh === "" || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    // OMP message, verbatim.
    throw new BridgeError("malformedPayload", "Token response missing required fields");
  }
  return {
    kind: "oauth",
    secret: access,
    oauth: {
      access,
      refresh: rotatedRefresh,
      expiresAtMs: nowMs + expiresIn * 1000,
      refreshEndpoint,
      clientId,
      ...(oauth.identity !== undefined ? { identity: oauth.identity } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Usage connector (OMP packages/ai/src/usage/openai-codex.ts)
// ---------------------------------------------------------------------------

/** OMP normalizeCodexBaseUrl: canonical ChatGPT origins only, path collapsed. */
export function normalizeCodexBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (trimmed === undefined || trimmed === "") return CODEX_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return CODEX_BASE_URL;
  }
  const host = parsed.host.toLowerCase();
  if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_BASE_URL;
  return `${parsed.origin}/backend-api`;
}

function codexUrl(baseUrl: string, path: string): string {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalized}${path}`;
}

/** OMP usage headers: Bearer + USER_AGENT, ChatGPT-Account-Id when known. */
function usageHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
  };
  if (accountId !== undefined) {
    headers["ChatGPT-Account-Id"] = accountId;
  }
  return headers;
}

export type OpenAICodexUsageInput = {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
};

export async function fetchOpenAICodexUsage(input: OpenAICodexUsageInput): Promise<BridgeSuccessResponse> {
  const { request, fetcher, nowMs } = input;
  if (request.providerId !== PROVIDER_ID) {
    throw new BridgeError("invalidProvider", `openai-codex connector received providerId "${request.providerId}"`);
  }
  const credential = request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", "openai-codex usage requires a credential");
  }
  if (credential.kind !== "oauth") {
    throw new BridgeError("invalidRequest", "openai-codex usage requires an OAuth credential");
  }
  const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
  const oauth = credential.oauth;
  const canRotate = oauth.refresh !== undefined && oauth.refreshEndpoint !== undefined;
  // OMP short-circuit: an expired token with no refresh path yields a null
  // report instead of burning an authenticated call.
  if (oauth.expiresAtMs !== undefined && oauth.expiresAtMs <= nowMs && !canRotate) {
    throw new BridgeError("noData", "openai-codex access token is expired and no refresh token is available");
  }

  let current: OAuthCredential = credential;
  let rotated: OAuthCredential | undefined;
  const expiresSoon = oauth.expiresAtMs === undefined || oauth.expiresAtMs - nowMs <= ROTATION_WINDOW_MS;
  if (expiresSoon && canRotate) {
    current = await rotateCodexToken(credential, fetcher, signal, nowMs);
    rotated = current;
  }

  const identity = oauth.identity;
  const accountId =
    (identity !== undefined && identity["accountId"] !== undefined && identity["accountId"] !== ""
      ? identity["accountId"]
      : undefined) ?? getTokenProfile(current.oauth.access).accountId;
  const baseUrl = normalizeCodexBaseUrl(identity?.["baseUrl"]);
  const usageUrl = codexUrl(baseUrl, USAGE_PATH);

  const fetchUsagePayload = async (access: string): Promise<unknown> => {
    const response = await callProviderHttp({
      call: { url: usageUrl, method: "GET", headers: usageHeaders(access, accountId) },
      fetcher,
      signal,
      endpointLabel: "OpenAI Codex usage endpoint",
      extraSecrets: [access],
    });
    return await response.json();
  };

  let payload: unknown;
  try {
    payload = await fetchUsagePayload(current.oauth.access);
  } catch (error) {
    // 401 mid-flow: rotate once and retry once (bridge common rule).
    if (error instanceof BridgeError && error.kind === "authRequired" && rotated === undefined && canRotate) {
      current = await rotateCodexToken(credential, fetcher, signal, nowMs);
      rotated = current;
      try {
        payload = await fetchUsagePayload(current.oauth.access);
      } catch (retryError) {
        throw rethrowWithRefreshedCredential(retryError, rotated);
      }
    } else {
      throw rethrowWithRefreshedCredential(error, rotated);
    }
  }

  const parsed = parseUsagePayload(payload);
  const windows = parsed === null ? [] : buildCodexWindows(parsed, nowMs);
  if (windows.length === 0) {
    throw rethrowWithRefreshedCredential(
      new BridgeError("noData", "openai-codex usage response contained no usable rate-limit windows"),
      rotated,
    );
  }

  // Saved-reset count per OMP: parse the /wham/usage block, and when it is
  // positive sync the live count from the dedicated detail endpoint.
  let resetCredits = parseResetCredits(payload);
  if (resetCredits !== undefined && resetCredits > 0) {
    try {
      const detail = await callProviderHttp({
        call: {
          url: codexUrl(baseUrl, RESET_CREDITS_PATH),
          method: "GET",
          headers: usageHeaders(current.oauth.access, accountId),
        },
        fetcher,
        signal,
        endpointLabel: "OpenAI Codex reset-credits endpoint",
        extraSecrets: [current.oauth.access],
      });
      const listCount = parseResetCreditList(await detail.json());
      if (listCount !== null) {
        resetCredits = listCount;
      }
    } catch {
      // Deliberately best-effort (OMP listCodexResetCredits returns null on
      // every failure and the stale payload count survives).
    }
  }
  if (resetCredits !== undefined) {
    const primaryIndex = windows.findIndex((window) => window.id === "openai-codex:primary");
    const primary = windows[primaryIndex];
    if (primary !== undefined) {
      windows[primaryIndex] = { ...primary, resetCredits };
    }
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
    ...(rotated !== undefined ? { refreshedCredential: rotated } : {}),
  };
}

export const openaiCodexConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchOpenAICodexUsage,
};

// ---------------------------------------------------------------------------
// Auth module (OMP packages/ai/src/registry/oauth/openai-codex.ts)
// ---------------------------------------------------------------------------

/** OMP parseCallbackInput: pasted redirect URL, query string, or raw code[#state]. */
export function parseCodexCallbackInput(input: string): { code?: string | undefined; state?: string | undefined } {
  const value = input.trim();
  if (value === "") return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // Not a URL — check for a query-string format (OMP comment).
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  const [code, state] = value.split("#", 2);
  return { code, state };
}

function throwIfLoginCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("timeout", "OpenAI Codex login cancelled");
  }
}

/** Races a pending step against the login AbortSignal (cancellation wins). */
async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal, cancelledMessage: string): Promise<T> {
  if (signal.aborted) {
    throw new BridgeError("timeout", cancelledMessage);
  }
  const { promise: abortPromise, reject } = Promise.withResolvers<never>();
  const onAbort = (): void => reject(new BridgeError("timeout", cancelledMessage));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // The loser's rejection must stay observed after the race settles.
    void promise.catch(() => undefined);
  }
}

type CodexTokens = {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAtMs: number;
  readonly accountId: string;
  readonly email?: string;
  readonly planType?: string;
};

/** OMP exchangeCodeForToken: form-urlencoded authorization_code grant + JWT profile. */
async function exchangeCodexToken(
  code: string,
  verifier: string,
  redirectUri: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<CodexTokens> {
  const response = await callProviderHttp({
    call: {
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }).toString(),
    },
    fetcher,
    signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
    endpointLabel: "OpenAI Codex token exchange endpoint",
    extraSecrets: [code, verifier],
  });

  const data = await response.json();
  if (!isRecord(data)) {
    throw new BridgeError("malformedPayload", "Token response missing required fields");
  }
  const access = typeof data["access_token"] === "string" ? data["access_token"] : "";
  const refresh = typeof data["refresh_token"] === "string" ? data["refresh_token"] : "";
  const expiresIn = data["expires_in"];
  if (access === "" || refresh === "" || typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    // OMP message, verbatim.
    throw new BridgeError("malformedPayload", "Token response missing required fields");
  }
  const idToken = typeof data["id_token"] === "string" ? data["id_token"] : undefined;
  const { accountId, email, planType } = getTokenProfile(access, idToken);
  if (accountId === undefined) {
    // OMP message, verbatim.
    throw new BridgeError("malformedPayload", "Failed to extract accountId from token");
  }
  return {
    access,
    refresh,
    expiresAtMs: Date.now() + expiresIn * 1000,
    accountId,
    ...(email !== undefined ? { email } : {}),
    ...(planType !== undefined ? { planType } : {}),
  };
}


const PASTE_HINT = `Complete the OpenAI Codex sign-in in your browser. After approval you are redirected to ${REDIRECT_URI}?code=... — paste that full redirected URL (or just the code) when prompted.`;

/**
 * Login result shared by both methods: OMP identity (account id, email, plan
 * type) plus the optional base-URL override from the login inputs.
 */
function codexLoginResult(tokens: CodexTokens, inputs: LoginInputs): LoginResult {
  const identity: Record<string, string> = { accountId: tokens.accountId };
  if (tokens.email !== undefined) {
    identity["email"] = tokens.email;
  }
  if (tokens.planType !== undefined) {
    identity["planType"] = tokens.planType;
  }
  const apiBaseUrl = inputs.apiBaseUrl?.trim();
  if (apiBaseUrl !== undefined && apiBaseUrl !== "") {
    identity["baseUrl"] = apiBaseUrl;
  }
  const accountLabel = tokens.email ?? tokens.accountId;
  return {
    credential: {
      kind: "oauth",
      secret: tokens.access,
      oauth: {
        access: tokens.access,
        refresh: tokens.refresh,
        expiresAtMs: tokens.expiresAtMs,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity,
      },
    },
    ...(accountLabel !== undefined ? { accountLabel } : {}),
  };
}

/** Whether a failed loopback bind means another process already holds the port. */
function isLoopbackPortInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") return code === "EADDRINUSE";
  return error instanceof Error && /EADDRINUSE|in use/i.test(error.message);
}

/**
 * OMP OAuthCallbackFlow bind policy for Codex: the fixed port and path with
 * no random-port fallback (OpenAI validates the redirect URI against its
 * registered allowlist; OMP throws ConfigurationError when 1455 is busy).
 */
async function startCodexLoopbackCallback(state: string, signal: AbortSignal): Promise<LoopbackCallbackHandle> {
  try {
    return await startLoopbackCallback(state, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      // OpenAI only allows http://localhost:1455/auth/callback: never fall
      // back to a random port (OMP redirectUri + allowPortFallback:false).
      allowPortFallback: false,
      signal,
    });
  } catch (error) {
    if (isLoopbackPortInUse(error)) {
      throw new BridgeError(
        "dependencyUnavailable",
        `loopback port ${CALLBACK_PORT} is in use, but the OpenAI Codex redirect ${REDIRECT_URI} requires this exact port. Free port ${CALLBACK_PORT} (stop the process bound to it) and retry, or use login method "device"`,
      );
    }
    throw error;
  }
}

/** Maps the loopback wait's cancellation/denial errors to BridgeErrors. */
async function captureCodexCallback(wait: Promise<CallbackResult>): Promise<CallbackResult> {
  try {
    return await wait;
  } catch (error) {
    if (error instanceof CallbackCancelledError) {
      throw new BridgeError("timeout", "OpenAI Codex login cancelled while waiting for the browser callback");
    }
    if (error instanceof CallbackFailedError) {
      // The redirect carried our state nonce: the user denied consent.
      throw new BridgeError("authRequired", error.message);
    }
    throw error;
  }
}

export type OpenAICodexLoginDeps = {
  readonly fetcher: Fetcher;
  /** Injectable browser opener; defaults to the macOS `open` spawn. */
  readonly openBrowser?: BrowserOpener;
  /** OMP onManualCodeInput: resolves with the pasted redirected URL or code. */
  readonly readPaste?: () => Promise<string>;
  /** Injectable device-flow sleep; defaults to the abortable scheduler wait. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * OMP loginOpenAICodex (browser): PKCE + state authorize URL on the fixed
 * localhost:1455/auth/callback redirect, then a race between the loopback
 * listener capturing the redirect and the manual paste prompt (OMP
 * #waitForCallback with onManualCodeInput; unusable pastes re-prompt), and
 * the form-urlencoded token exchange mints the credential.
 */
export async function loginOpenAICodex(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: OpenAICodexLoginDeps,
): Promise<LoginResult> {
  if (method === "device") {
    return await loginOpenAICodexDevice(inputs, events, signal, deps);
  }
  if (method !== "browser") {
    throw new BridgeError("invalidRequest", `provider "openai-codex" does not offer login method "${method}"`);
  }
  throwIfLoginCancelled(signal);

  const pkce = await generatePKCE();
  const state = generateCallbackState();
  // OMP createOpenAICodexAuthorizationUrl, verbatim parameter set and order.
  const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: ORIGINATOR_CODEX,
  }).toString()}`;

  const handle = await startCodexLoopbackCallback(state, signal);
  try {
    events.onEvent({ type: "openUrl", url: authorizeUrl });
    
    events.onEvent({ type: "pasteHint", detail: PASTE_HINT });
    events.onEvent({ type: "waiting", detail: "Waiting for browser authentication..." });

    // OMP manual-input race: optional — a non-duplex client simply waits on
    // the listener. requestInput prompts ride the duplex login channel.
    const requestInput = events.requestInput;
    const readPaste =
      deps.readPaste ??
      (requestInput !== undefined
        ? () => requestInput({ prompt: PASTE_HINT, inputKind: "redirectUrl", sensitive: true }, signal)
        : undefined);

    const callbackCapture = captureCodexCallback(handle.wait);
    let code: string;
    if (readPaste === undefined) {
      code = (await callbackCapture).code;
    } else {
      // OMP manual-input loop: each paste races the callback capture; a paste
      // without both a usable code and the exact state is ignored and the
      // prompt repeats.
      const manualCapture = (async (): Promise<CallbackResult> => {
        for (;;) {
          throwIfLoginCancelled(signal);
          const pasted = await awaitWithAbort(
            readPaste(),
            signal,
            "OpenAI Codex login cancelled while waiting for the pasted callback",
          );
          const parsedPaste = parseCodexCallbackInput(pasted);
          if (
            parsedPaste.code !== undefined &&
            parsedPaste.code !== "" &&
            parsedPaste.state === state
          ) {
            return { code: parsedPaste.code, state: parsedPaste.state };
          }
        }
      })();
      code = (await Promise.race([callbackCapture, manualCapture])).code;
    }

    throwIfLoginCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Exchanging authorization code for tokens..." });
    const tokens = await exchangeCodexToken(code, pkce.verifier, REDIRECT_URI, deps.fetcher, signal);
    return codexLoginResult(tokens, inputs);
  } finally {
    handle.stop();
  }
}

// ---------------------------------------------------------------------------
// Device login (OMP loginOpenAICodexDevice)
// ---------------------------------------------------------------------------

/** JSON POST to a Codex device endpoint, bounded by the login signal + OMP 15s timeout. */
async function postCodexDeviceRequest(
  url: string,
  body: Record<string, string>,
  fetcher: Fetcher,
  signal: AbortSignal,
  endpointLabel: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS)]),
    });
  } catch (error) {
    if (signal.aborted) {
      throw new BridgeError("timeout", "OpenAI Codex login cancelled");
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new BridgeError("timeout", `${endpointLabel} request timed out`);
    }
    throw new BridgeError("transport", `network failure contacting ${endpointLabel}`);
  }
  return response;
}

/** OMP error text ("<scope>: <status>") mapped onto bridge error kinds. */
function codexDeviceStatusError(scope: string, status: number): BridgeError {
  if (status === 401) return new BridgeError("authRequired", `${scope}: ${status}`);
  if (status === 429) return new BridgeError("rateLimited", `${scope}: ${status}`);
  return new BridgeError("upstreamError", `${scope}: ${status}`);
}

async function parseCodexDeviceJson(
  response: Response,
  endpointLabel: string,
): Promise<Readonly<Record<string, unknown>>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BridgeError("malformedPayload", `${endpointLabel} returned a non-JSON body`);
  }
  if (!isRecord(payload)) {
    throw new BridgeError("malformedPayload", `${endpointLabel} returned a non-object body`);
  }
  return payload;
}

/** Default device sleep: the node scheduler wait, abortable by the login signal. */
const codexDeviceSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await scheduler.wait(ms, signal === undefined ? undefined : { signal });
};

async function sleepCodexDevice(
  ms: number,
  signal: AbortSignal,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch (error) {
    // OMP checks the signal after every sleep; the abortable default sleep
    // surfaces the same cancellation without waiting out the interval.
    if (signal.aborted) {
      throw new BridgeError("timeout", "Device authorization cancelled");
    }
    throw error;
  }
}

/**
 * OMP loginOpenAICodexDevice (headless): request a user code, poll the device
 * token endpoint (403/404 = pending) at interval + 3s safety margin with a
 * 5s first-wait cap, then exchange the server-provided authorization code
 * and verifier over the device redirect URI.
 */
export async function loginOpenAICodexDevice(
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: OpenAICodexLoginDeps,
): Promise<LoginResult> {
  throwIfLoginCancelled(signal);
  events.onEvent({ type: "waiting", detail: "Initiating device authorization..." });

  const initResponse = await postCodexDeviceRequest(
    DEVICE_USERCODE_URL,
    { client_id: CLIENT_ID },
    deps.fetcher,
    signal,
    "OpenAI Codex device authorization initiation",
  );
  if (!initResponse.ok) {
    throw codexDeviceStatusError("Device authorization initiation failed", initResponse.status);
  }
  const initData = await parseCodexDeviceJson(initResponse, "OpenAI Codex device authorization initiation");
  const deviceAuthId = typeof initData["device_auth_id"] === "string" ? initData["device_auth_id"] : "";
  const userCode = typeof initData["user_code"] === "string" ? initData["user_code"] : "";
  if (deviceAuthId === "" || userCode === "") {
    throw new BridgeError("malformedPayload", "Device authorization response missing required fields");
  }
  // OMP interval parse: seconds as number or numeric string, default 5.
  const intervalSeconds =
    typeof initData["interval"] === "number"
      ? initData["interval"]
      : parseInt(String(initData["interval"] ?? "5"), 10) || 5;
  const pollIntervalMs = intervalSeconds * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS;

  events.onEvent({
    type: "openUrl",
    url: verificationUriWithUserCode(DEVICE_AUTH_URL, userCode),
  });
  events.onEvent({ type: "code", code: userCode, verificationUrl: DEVICE_AUTH_URL });
  events.onEvent({ type: "waiting", detail: `Enter code: ${userCode}` });
  events.onEvent({ type: "waiting", detail: "Waiting for browser authorization..." });

  const sleep = deps.sleep ?? codexDeviceSleep;
  for (let poll = 0; poll < DEVICE_MAX_POLLS; poll += 1) {
    await sleepCodexDevice(poll === 0 ? Math.min(pollIntervalMs, DEVICE_POLL_INTERVAL_MS) : pollIntervalMs, signal, sleep);
    if (signal.aborted) {
      throw new BridgeError("timeout", "Device authorization cancelled");
    }

    const pollResponse = await postCodexDeviceRequest(
      DEVICE_TOKEN_URL,
      { device_auth_id: deviceAuthId, user_code: userCode },
      deps.fetcher,
      signal,
      "OpenAI Codex device token polling",
    );
    // OMP: 403/404 mean authorization pending, keep polling.
    if (pollResponse.status === 403 || pollResponse.status === 404) {
      continue;
    }
    if (!pollResponse.ok) {
      throw codexDeviceStatusError("Device token polling failed", pollResponse.status);
    }
    const pollData = await parseCodexDeviceJson(pollResponse, "OpenAI Codex device token polling");
    const authorizationCode = typeof pollData["authorization_code"] === "string" ? pollData["authorization_code"] : "";
    const codeVerifier = typeof pollData["code_verifier"] === "string" ? pollData["code_verifier"] : "";
    if (authorizationCode === "" || codeVerifier === "") {
      throw new BridgeError("malformedPayload", "Device token response missing authorization_code or code_verifier");
    }

    events.onEvent({ type: "waiting", detail: "Exchanging authorization code for tokens..." });
    const tokens = await exchangeCodexToken(authorizationCode, codeVerifier, DEVICE_REDIRECT_URI, deps.fetcher, signal);
    return codexLoginResult(tokens, inputs);
  }

  throw new BridgeError("timeout", "Device authorization timed out - user did not complete login in time");
}

/** AuthModule.refresh entry point (tests inject the fetcher). */
export async function refreshOpenAICodexCredential(
  credential: BridgeCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<BridgeCredential> {
  if (credential.kind !== "oauth") {
    throw new BridgeError("invalidRequest", "openai-codex token refresh requires an OAuth credential");
  }
  return await rotateCodexToken(credential, fetcher, signal, Date.now());
}

const platformCodexFetch: Fetcher = (url, init) => fetch(url, init);

export const openaiCodexAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["browser", "device"],
  login: (method, inputs, events, signal) =>
    loginOpenAICodex(method, inputs, events, signal, { fetcher: platformCodexFetch }),
  refresh: (credential, signal) => refreshOpenAICodexCredential(credential, platformCodexFetch, signal),
};
