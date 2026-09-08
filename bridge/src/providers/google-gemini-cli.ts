/**
 * Google Gemini CLI (Cloud Code Assist) provider module, hand-ported from the
 * pinned oh-my-pi checkout @ 8500092296621a6826b7136e840f8a59ea338958:
 *
 * - packages/ai/src/registry/oauth/google-gemini-cli.ts   (browser login,
 *   project discovery/onboarding/LRO polling, token refresh)
 * - packages/ai/src/registry/oauth/google-oauth-shared.ts  (Google
 *   authorization-code flow: authorize URL, exchange, userinfo, 30s
 *   per-request provisioning timeout)
 * - packages/ai/src/usage/gemini.ts                        (loadCodeAssist +
 *   retrieveUserQuota fetch and bucket normalization)
 * - packages/catalog/src/wire/gemini-headers.ts            (GeminiCLI
 *   User-Agent + Client-Metadata headers)
 *
 * Kept from the OMP sources (same endpoints, embedded client id/secret,
 * request bodies and normalization boundaries):
 * - Login: authorization-code flow against accounts.google.com with the Gemini
 *   CLI client id/secret (base64-embedded verbatim), loopback redirect on
 *   127.0.0.1:8085/oauth2callback, scopes cloud-platform + userinfo.email +
 *   userinfo.profile, access_type=offline, prompt=consent; form-encoded token
 *   exchange at oauth2.googleapis.com/token; userinfo email probe (optional,
 *   errors swallowed); loadCodeAssist discovery with the login body shape
 *   (cloudaicompanionProject + metadata.duetProject from GOOGLE_CLOUD_PROJECT
 *   / GOOGLE_CLOUD_PROJECT_ID), VPC-SC SECURITY_POLICY_VIOLATED detection,
 *   allowedTiers defaulting (free-tier/legacy-tier/standard-tier),
 *   onboardUser + long-running-operation polling (5s interval, 24 attempts).
 * - Usage: POST cloudcode-pa.googleapis.com/v1internal:loadCodeAssist then
 *   v1internal:retrieveUserQuota with `Bearer <access>` plus the GeminiCLI
 *   headers; one window per quota bucket: id `${modelId}:${reset-<epoch>}`
 *   (opaque "quota" window when resetTime is absent/unparseable), percent
 *   unit, used = 100 - remaining (clamped, one decimal), limit 100, Flash/Pro
 *   tier grouping per GEMINI_TIER_MAP plus the flash/pro substring fallback.
 * - Refresh: oauth2.googleapis.com/token form grant_type=refresh_token +
 *   client_id + client_secret + refresh_token, with OMP's 5-minute expiry
 *   safety margin; refresh_token preserved when Google omits a new one.
 *
 * Deviations from the OMP sources (with reasons):
 * - OMP's report metadata (currentTierId/currentTierName) and raw payload are
 *   dropped: the bridge UsageReport has no metadata/raw surface and model
 *   catalog fields are forbidden on the wire.
 * - OMP carries scope.tier next to each limit; UsageWindow has no tier field,
 *   so the tier group surfaces in the window label ("Gemini Flash",
 *   "Gemini Pro", "Gemini 3-Flash"). OMP's label was `Gemini ${modelId}`;
 *   the modelId itself stays in the OMP-exact window id.
 * - OMP keeps the raw usedFraction alongside the rounded percent amounts; the
 *   bridge requires resolvedFraction to equal used/limit exactly, so
 *   resolvedFraction derives from the rounded percent (worst-case drift from
 *   OMP's raw fraction is 0.05 percentage points).
 * - OMP's null-report outcomes become typed BridgeErrors: retrieveUserQuota
 *   HTTP failures map through callProviderHttp (401 -> authRequired,
 *   429 -> rateLimited, ...); a loadCodeAssist HTTP failure stays non-fatal
 *   (OMP logs a warning and continues with the known project id) while
 *   transport/timeout/malformed-JSON failures still fail the fetch; empty or
 *   absent buckets -> noData (OMP returns an empty-limits report).
 * - OMP's resolveAccessToken expiry short-circuit is replaced by the bridge
 *   rotation contract: rotate before the first upstream call when
 *   expiresAtMs is missing or within 60s and refresh material exists, and on
 *   a mid-flow 401 rotate once and retry the sequence once. A successful
 *   rotation is never dropped: when the subsequent quota work fails, the
 *   BridgeError carries refreshedCredential so the caller persists the
 *   rotated bundle before surfacing the error (Google burns the old refresh
 *   token on rotation). OMP leaves all refresh to AuthStorage; the bridge
 *   connector owns it.
 * - Login-phase OAuthController callbacks become AuthEvents (openUrl for the
 *   authorize URL, pasteHint for OMP's pasteCodeFlow fallback instruction,
 *   waiting for the onProgress strings), and OMP's manual paste race
 *   (onManualCodeInput) rides the duplex AuthEvents.requestInput channel —
 *   never a tty. OMP's OAuthError kinds map to BridgeError kinds:
 *   discovery/provisioning failures use the HTTP status mapping, the
 *   GOOGLE_CLOUD_PROJECT requirement and no-project outcomes are
 *   invalidRequest, provisioning-poll exhaustion is timeout.
 * - The login-phase loadCodeAssist call goes through the fetcher directly
 *   with an equivalent abort/transport/status mapping because the VPC-SC
 *   branch must read the FAILED response body, which callProviderHttp does
 *   not expose (it throws without the body). Error text carries the status
 *   only, never the upstream body, so no secret material can leak.
 * - OMP OAuthCredentials { refresh, access, expires, projectId, email }
 *   becomes the bridge oauth credential { access, refresh, expiresAtMs,
 *   refreshEndpoint: oauth2.googleapis.com/token, clientId, identity:
 *   { projectId, email? } }; accountLabel is the discovered email.
 */

import { defaultBrowserOpener, openInBrowser } from "../auth/open-browser";
import type { BrowserOpener } from "../auth/open-browser";
import { CallbackCancelledError, CallbackFailedError, generateCallbackState, startLoopbackCallback } from "../auth/loopback";
import type { LoopbackCallbackHandle } from "../auth/loopback";
import { rethrowWithRefreshedCredential, rotateOAuthToken, waitForCallbackOrManualPaste } from "../auth/refresh";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type {
  BridgeErrorKind,
  BridgeRequest,
  BridgeSuccessResponse,
  OAuthCredential,
  Severity,
  UsageReport,
  UsageWindow,
} from "../protocol";

const PROVIDER_ID = "google-gemini-cli";
const CONNECTOR_VERSION = "google-gemini-cli-1";

// Gemini CLI embedded client credentials (base64 verbatim from OMP
// packages/ai/src/registry/oauth/google-gemini-cli.ts @ 8500092).
const decodeBase64 = (s: string): string => atob(s);
const CLIENT_ID = decodeBase64(
  "NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRl" +
    "bnQuY29t",
);
const CLIENT_SECRET = decodeBase64(
  "R09DU1BYLTR1SGdNUG0tMW83U2" + "stZ2VWNkN1NWNsWEZzeGw=",
);

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const LOAD_CODE_ASSIST_URL = `${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
const RETRIEVE_USER_QUOTA_URL = `${CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`;
const ONBOARD_USER_URL = `${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`;

const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/** OMP OAUTH_REQUEST_TIMEOUT_MS for the post-callback provisioning phase. */
const LOGIN_REQUEST_TIMEOUT_MS = 30_000;
/** OMP poll cadence/bound for the Cloud Code Assist onboarding LRO. */
const POLL_INTERVAL_MS = 5_000;
const POLL_MAX_ATTEMPTS = 24;
/** OMP expiry safety margin (refreshGoogleCloudToken / exchangeToken). */
const EXPIRY_SAFETY_MS = 5 * 60 * 1000;
/** Bridge rotation contract: rotate when expiry lands within this window. */
const ROTATION_WINDOW_MS = 60_000;

const TIER_FREE = "free-tier";
const TIER_LEGACY = "legacy-tier";

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

const PROJECT_ENV_REQUIREMENT =
  "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
  "See https://goo.gle/gemini-cli-auth-docs#workspace-gca";

const BROWSER_PASTE_HINT =
  "Complete Google sign-in in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.";

/**
 * GeminiCLI wire headers (OMP getGeminiCliHeaders @ 8500092): the User-Agent
 * identifies as the official Gemini CLI to unlock higher rate limits; the
 * version tracks PI_AI_GEMINI_CLI_VERSION like OMP.
 */
function geminiCliHeaders(): Record<string, string> {
  const version = process.env["PI_AI_GEMINI_CLI_VERSION"] || "0.46.0";
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return {
    "User-Agent": `GeminiCLI/${version}/gemini-3.1-pro-preview (${platform}; ${arch}; terminal)`,
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
  };
}

/** OMP $env.GOOGLE_CLOUD_PROJECT || $env.GOOGLE_CLOUD_PROJECT_ID. */
function envProjectId(): string | undefined {
  return process.env["GOOGLE_CLOUD_PROJECT"] || process.env["GOOGLE_CLOUD_PROJECT_ID"] || undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

// ---------------------------------------------------------------------------
// Usage connector (OMP packages/ai/src/usage/gemini.ts)
// ---------------------------------------------------------------------------

/** Quota-only memberships match catalog compat/rules/runtime/behavior.kdl
 * at d720e81f; no model catalog is imported. Exact IDs win over fallbacks. */
const GEMINI_TIER_MAP: ReadonlyArray<{ readonly tier: string; readonly models: readonly string[] }> = [
  { tier: "3-Flash", models: ["gemini-3-flash-preview", "gemini-3-flash", "gemini-3.5-flash"] },
  {
    tier: "Flash",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-1.5-flash"],
  },
  {
    tier: "Pro",
    models: [
      "gemini-2.5-pro",
      "gemini-3-pro-preview",
      "gemini-3.1-pro-preview",
      "gemini-3-pro",
      "gemini-3.1-pro",
      "gemini-pro-agent",
      "gemini-1.5-pro",
    ],
  },
];

function getModelTier(modelId: string): string | undefined {
  for (const entry of GEMINI_TIER_MAP) {
    if (entry.models.includes(modelId)) {
      return entry.tier;
    }
  }
  if (modelId.includes("flash")) return "Flash";
  if (modelId.includes("pro")) return "Pro";
  return undefined;
}

/**
 * OMP parseWindow + parseIsoTimestamp: a parseable resetTime anchors an opaque
 * `reset-<epoch>` window id; anything else falls back to "quota".
 */
function parseWindowReset(resetTime: string | undefined): { readonly windowId: string; readonly resetsAtMs?: number } {
  if (resetTime === undefined || resetTime === "") {
    return { windowId: "quota" };
  }
  const resetsAt = Date.parse(resetTime);
  if (!Number.isFinite(resetsAt)) {
    return { windowId: "quota" };
  }
  return { windowId: `reset-${resetsAt}`, resetsAtMs: resetsAt };
}

/** OMP buildAmount: percent-remaining amounts, clamped, used rounded to 0.1. */
function windowForBucket(bucket: unknown): UsageWindow | undefined {
  const record = isRecord(bucket) ? bucket : {};
  const modelId =
    typeof record["modelId"] === "string" && record["modelId"] !== "" ? record["modelId"] : undefined;
  const rawRemaining = typeof record["remainingFraction"] === "number" ? record["remainingFraction"] : undefined;
  const remainingFraction =
    rawRemaining !== undefined && Number.isFinite(rawRemaining) ? rawRemaining : undefined;
  // An amountless bucket cannot form a wire utilization, even with a reset.
  if (remainingFraction === undefined) return undefined;
  const reset = parseWindowReset(typeof record["resetTime"] === "string" ? record["resetTime"] : undefined);
  const tier = modelId !== undefined ? getModelTier(modelId) : undefined;
  const label =
    modelId === undefined ? "Gemini quota" : tier !== undefined ? `Gemini ${tier}` : `Gemini ${modelId}`;

  let resolvedFraction: number | undefined;
  let used: number | undefined;
  if (remainingFraction !== undefined) {
    const remaining = Math.min(Math.max(remainingFraction, 0), 1);
    const usedFraction = Math.min(Math.max(1 - remaining, 0), 1);
    used = Math.round(usedFraction * 1000) / 10;
    resolvedFraction = used / 100;
  }
  const severity: Severity = severityForFraction(resolvedFraction);
  return {
    id: `${modelId ?? "unknown"}:${reset.windowId}`,
    label,
    unit: "percent",
    severity,
    ...(resolvedFraction !== undefined ? { resolvedFraction } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(used !== undefined ? { limit: 100 } : {}),
    ...(reset.resetsAtMs !== undefined ? { resetsAtMs: reset.resetsAtMs } : {}),
  };
}

/** OMP getProjectId: cloudaicompanionProject as string or { id }. */
function getProjectId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const raw = payload["cloudaicompanionProject"];
  if (typeof raw === "string") {
    return raw;
  }
  if (isRecord(raw) && typeof raw["id"] === "string") {
    return raw["id"];
  }
  return undefined;
}

function canRotate(credential: OAuthCredential): boolean {
  return credential.oauth.refresh !== undefined && credential.oauth.refreshEndpoint !== undefined;
}

function needsPreRotation(credential: OAuthCredential, nowMs: number): boolean {
  if (!canRotate(credential)) {
    return false;
  }
  const expiresAtMs = credential.oauth.expiresAtMs;
  return expiresAtMs === undefined || expiresAtMs <= nowMs + ROTATION_WINDOW_MS;
}

/** OMP refreshGoogleCloudToken response shape + 5-minute safety margin. */
function mapGoogleRefreshResponse(json: unknown): { access: string; refresh?: string; expiresInMs?: number } {
  if (!isRecord(json)) {
    return { access: "" };
  }
  const access = typeof json["access_token"] === "string" ? json["access_token"] : "";
  const refresh =
    typeof json["refresh_token"] === "string" && json["refresh_token"] !== "" ? json["refresh_token"] : undefined;
  const expiresIn =
    typeof json["expires_in"] === "number" && Number.isFinite(json["expires_in"]) ? json["expires_in"] : undefined;
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(expiresIn !== undefined ? { expiresInMs: expiresIn * 1000 - EXPIRY_SAFETY_MS } : {}),
  };
}

async function rotateGeminiCredential(
  credential: OAuthCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  return await rotateOAuthToken({
    // The embedded Gemini CLI client id backs any credential that lacks one.
    credential: {
      ...credential,
      oauth: { ...credential.oauth, clientId: credential.oauth.clientId ?? CLIENT_ID },
    },
    fetcher,
    signal,
    // OMP refreshGoogleCloudToken posts the client secret with the grant.
    extraBody: { client_secret: CLIENT_SECRET },
    mapResponse: mapGoogleRefreshResponse,
  });
}

/** BridgeError kinds that map to upstream HTTP statuses (see provider-http). */
const HTTP_STATUS_KINDS: ReadonlySet<BridgeErrorKind> = new Set([
  "authRequired",
  "permissionDenied",
  "rateLimited",
  "upstreamError",
]);

async function fetchQuotaPayload(
  credential: OAuthCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<readonly unknown[]> {
  const accessToken = credential.oauth.access;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...geminiCliHeaders(),
  };
  const identityProjectId = credential.oauth.identity?.["projectId"];

  // OMP loadCodeAssist: an HTTP failure only logs a warning and leaves the
  // project id to the credential; transport/timeout/malformed bodies throw.
  let loadPayload: unknown;
  try {
    const loadResponse = await callProviderHttp({
      call: {
        url: LOAD_CODE_ASSIST_URL,
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(identityProjectId !== undefined ? { cloudaicompanionProject: identityProjectId } : {}),
          metadata: { ...CODE_ASSIST_METADATA },
        }),
      },
      fetcher,
      signal,
      endpointLabel: "Gemini CLI loadCodeAssist",
      extraSecrets: [accessToken],
    });
    loadPayload = await loadResponse.json();
  } catch (error) {
    if (!(error instanceof BridgeError) || !HTTP_STATUS_KINDS.has(error.kind)) {
      throw error;
    }
  }

  const projectId = identityProjectId ?? getProjectId(loadPayload);
  const quotaResponse = await callProviderHttp({
    call: {
      url: RETRIEVE_USER_QUOTA_URL,
      method: "POST",
      headers,
      body: JSON.stringify(projectId !== undefined ? { project: projectId } : {}),
    },
    fetcher,
    signal,
    endpointLabel: "Gemini CLI retrieveUserQuota",
    extraSecrets: [accessToken],
  });
  const quotaPayload = await quotaResponse.json();
  if (!isRecord(quotaPayload)) {
    throw new BridgeError("malformedPayload", "Gemini CLI retrieveUserQuota returned a non-object body");
  }
  const buckets = quotaPayload["buckets"] ?? [];
  if (!Array.isArray(buckets)) {
    throw new BridgeError("malformedPayload", "Gemini CLI retrieveUserQuota returned a non-array buckets field");
  }
  return buckets;
}

export type GoogleGeminiCliUsageInput = {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
};

export async function fetchGoogleGeminiCliUsage(input: GoogleGeminiCliUsageInput): Promise<BridgeSuccessResponse> {
  const { request, fetcher, nowMs } = input;
  if (request.providerId !== PROVIDER_ID) {
    throw new BridgeError("invalidProvider", `google-gemini-cli connector received providerId "${request.providerId}"`);
  }
  const credential = request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", "google-gemini-cli usage requires a credential");
  }
  if (credential.kind !== "oauth") {
    throw new BridgeError("invalidRequest", "google-gemini-cli usage requires an OAuth credential");
  }
  if (credential.oauth.access === "") {
    throw new BridgeError("missingCredential", "google-gemini-cli credential carries no access token");
  }
  const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));

  let active: OAuthCredential = credential;
  let refreshed: OAuthCredential | undefined;
  try {
    if (needsPreRotation(credential, nowMs)) {
      active = await rotateGeminiCredential(credential, fetcher, signal);
      refreshed = active;
    }

    let buckets: readonly unknown[];
    try {
      buckets = await fetchQuotaPayload(active, fetcher, signal);
    } catch (error) {
      // Bridge rotation contract: a mid-flow 401 rotates once and retries once.
      if (!(error instanceof BridgeError) || error.kind !== "authRequired" || refreshed !== undefined || !canRotate(active)) {
        throw error;
      }
      active = await rotateGeminiCredential(active, fetcher, signal);
      refreshed = active;
      buckets = await fetchQuotaPayload(active, fetcher, signal);
    }

    const windows = buckets.map(windowForBucket).filter((window): window is UsageWindow => window !== undefined);
    if (windows.length === 0) {
      throw new BridgeError("noData", "Gemini CLI retrieveUserQuota returned no quota buckets");
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
      ...(refreshed !== undefined ? { refreshedCredential: refreshed } : {}),
    };
  } catch (error) {
    // Rotation durability: Google burns the old refresh token on rotation, so
    // a rotated bundle must reach the caller even when the retried fetch fails.
    throw rethrowWithRefreshedCredential(error, refreshed);
  }
}

export const googleGeminiCliConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchGoogleGeminiCliUsage,
};

// ---------------------------------------------------------------------------
// Auth module (OMP registry/oauth/google-gemini-cli.ts + google-oauth-shared.ts)
// ---------------------------------------------------------------------------

const platformFetch: Fetcher = (url, init) => fetch(url, init);

export type GoogleGeminiCliLoginDeps = {
  readonly fetcher: Fetcher;
  /** Injectable browser opener; defaults to the macOS `open` spawn. */
  readonly openBrowser?: BrowserOpener;
};

function cancelledBridgeError(): BridgeError {
  return new BridgeError("timeout", "Google login was cancelled");
}

function throwIfLoginCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw cancelledBridgeError();
  }
}

/** Compose the login AbortSignal with OMP's 30s per-request timeout. */
function loginSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS)]);
}

function remapLoginError(error: unknown, signal: AbortSignal): never {
  if (error instanceof BridgeError) {
    if (error.kind === "timeout" && signal.aborted) {
      throw cancelledBridgeError();
    }
    throw error;
  }
  if (isAbortError(error)) {
    throw signal.aborted ? cancelledBridgeError() : new BridgeError("timeout", "Google login request timed out");
  }
  throw error;
}

/** provider-http default status map (401/403/429/5xx), for the raw fetch below. */
function kindForHttpStatus(status: number): BridgeErrorKind {
  if (status === 401) return "authRequired";
  if (status === 403) return "permissionDenied";
  if (status === 429) return "rateLimited";
  return "upstreamError";
}

/**
 * Raw fetch for the one login call that must read a FAILED body (the VPC-SC
 * branch). Abort/transport/status mapping mirrors callProviderHttp; messages
 * carry the URL/status only, never a body or credential material.
 */
async function fetchLoginResponse(
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string },
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(LOGIN_REQUEST_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  try {
    return await fetcher(url, { method: init.method, headers: init.headers, body: init.body, signal: requestSignal });
  } catch (error) {
    if (signal.aborted) {
      throw cancelledBridgeError();
    }
    if (timeoutSignal.aborted) {
      throw new BridgeError("timeout", `timed out after ${LOGIN_REQUEST_TIMEOUT_MS}ms waiting for ${url}`);
    }
    throw new BridgeError("transport", `network failure contacting ${url}`);
  }
}

/** OMP isVpcScAffectedUser: SECURITY_POLICY_VIOLATED in the rpc error details. */
function isVpcScAffectedUser(payload: unknown): boolean {
  if (!isRecord(payload) || !("error" in payload)) {
    return false;
  }
  const error = payload["error"];
  if (!isRecord(error) || !Array.isArray(error["details"])) {
    return false;
  }
  return error["details"].some((detail) => isRecord(detail) && detail["reason"] === "SECURITY_POLICY_VIOLATED");
}

type DiscoveryPayload = {
  readonly cloudaicompanionProject?: string;
  readonly hasCurrentTier: boolean;
  readonly allowedTiers: ReadonlyArray<{ readonly id?: string; readonly isDefault: boolean }>;
};

function parseDiscoveryPayload(payload: unknown): DiscoveryPayload {
  if (!isRecord(payload)) {
    return { hasCurrentTier: false, allowedTiers: [] };
  }
  const project = payload["cloudaicompanionProject"];
  const currentTier = isRecord(payload["currentTier"]) ? payload["currentTier"] : undefined;
  const allowedRaw = Array.isArray(payload["allowedTiers"]) ? payload["allowedTiers"] : [];
  const allowedTiers = allowedRaw
    .filter((entry): entry is Readonly<Record<string, unknown>> => isRecord(entry))
    .map((entry) => ({
      ...(typeof entry["id"] === "string" ? { id: entry["id"] } : {}),
      isDefault: entry["isDefault"] === true,
    }));
  return {
    ...(typeof project === "string" ? { cloudaicompanionProject: project } : {}),
    hasCurrentTier: currentTier !== undefined,
    allowedTiers,
  };
}

type LongRunningOperation = {
  readonly name?: string;
  readonly done: boolean;
  readonly projectId?: string;
};

function parseLongRunningOperation(payload: unknown): LongRunningOperation {
  if (!isRecord(payload)) {
    return { done: false };
  }
  const project = payload["response"];
  const projectId =
    isRecord(project) && isRecord(project["cloudaicompanionProject"]) && typeof project["cloudaicompanionProject"]["id"] === "string"
      ? project["cloudaicompanionProject"]["id"]
      : undefined;
  return {
    ...(typeof payload["name"] === "string" ? { name: payload["name"] } : {}),
    done: payload["done"] === true,
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

/** OMP getDefaultTier: the isDefault entry, else legacy-tier. */
function getDefaultTier(allowedTiers: ReadonlyArray<{ readonly id?: string; readonly isDefault: boolean }>): { id?: string } {
  if (allowedTiers.length === 0) {
    return { id: TIER_LEGACY };
  }
  return allowedTiers.find((tier) => tier.isDefault) ?? { id: TIER_LEGACY };
}

/** Abortable sleep for the onboarding LRO poll: Bun.sleep alone ignores the
 * login signal, so cancellation would linger on a poll interval. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(cancelledBridgeError());
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timer: Timer | undefined;
  const onAbort = (): void => {
    clearTimeout(timer);
    reject(cancelledBridgeError());
  };
  timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}

/** OMP pollOperation: GET the LRO until done, bounded at 24 attempts. */
async function pollProvisioning(
  operationName: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
  signal: AbortSignal,
  events: AuthEvents,
): Promise<LongRunningOperation> {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      events.onEvent({
        type: "waiting",
        detail: `Waiting for project provisioning (attempt ${attempt + 1}/${POLL_MAX_ATTEMPTS})...`,
      });
      throwIfLoginCancelled(signal);
      await sleepAbortable(POLL_INTERVAL_MS, signal);
    }
    throwIfLoginCancelled(signal);
    const response = await callProviderHttp({
      call: { url: `${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, method: "GET", headers },
      fetcher,
      signal: loginSignal(signal),
      endpointLabel: "Gemini CLI provisioning poll",
    });
    const operation = parseLongRunningOperation(await response.json());
    if (operation.done) {
      return operation;
    }
  }
  throw new BridgeError("timeout", `Project provisioning did not complete after ${POLL_MAX_ATTEMPTS} attempts`);
}

/**
 * OMP discoverProject: loadCodeAssist (with the login body shape, the
 * env-project passthrough and the VPC-SC fallback), then onboardUser + LRO
 * polling when the account has no current tier.
 */
async function discoverProject(
  accessToken: string,
  events: AuthEvents,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<string> {
  const envProject = envProjectId();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...geminiCliHeaders(),
  };

  events.onEvent({ type: "waiting", detail: "Checking for existing Cloud Code Assist project..." });
  const loadResponse = await fetchLoginResponse(
    LOAD_CODE_ASSIST_URL,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        cloudaicompanionProject: envProject,
        metadata: { ...CODE_ASSIST_METADATA, duetProject: envProject },
      }),
    },
    fetcher,
    signal,
  );

  let data: DiscoveryPayload;
  if (!loadResponse.ok) {
    let errorPayload: unknown;
    try {
      errorPayload = await loadResponse.clone().json();
    } catch {
      errorPayload = undefined;
    }
    if (isVpcScAffectedUser(errorPayload)) {
      // OMP synthesizes currentTier = standard-tier here; only its truthiness
      // matters downstream (no cloudaicompanionProject, no env project).
      data = { hasCurrentTier: true, allowedTiers: [] };
    } else {
      throw new BridgeError(
        kindForHttpStatus(loadResponse.status),
        `Gemini CLI loadCodeAssist returned HTTP ${loadResponse.status}`,
      );
    }
  } else {
    let parsed: unknown;
    try {
      parsed = await loadResponse.json();
    } catch {
      throw new BridgeError("malformedPayload", "Gemini CLI loadCodeAssist returned a non-JSON body");
    }
    data = parseDiscoveryPayload(parsed);
  }

  if (data.hasCurrentTier) {
    if (data.cloudaicompanionProject !== undefined) {
      return data.cloudaicompanionProject;
    }
    if (envProject !== undefined) {
      return envProject;
    }
    throw new BridgeError("invalidRequest", PROJECT_ENV_REQUIREMENT);
  }

  const tierId = getDefaultTier(data.allowedTiers).id ?? TIER_FREE;
  if (tierId !== TIER_FREE && envProject === undefined) {
    throw new BridgeError("invalidRequest", PROJECT_ENV_REQUIREMENT);
  }

  events.onEvent({ type: "waiting", detail: "Provisioning Cloud Code Assist project (this may take a moment)..." });
  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: { ...CODE_ASSIST_METADATA },
  };
  if (tierId !== TIER_FREE && envProject !== undefined) {
    onboardBody["cloudaicompanionProject"] = envProject;
    (onboardBody["metadata"] as Record<string, unknown>)["duetProject"] = envProject;
  }
  const onboardResponse = await callProviderHttp({
    call: { url: ONBOARD_USER_URL, method: "POST", headers, body: JSON.stringify(onboardBody) },
    fetcher,
    signal: loginSignal(signal),
    endpointLabel: "Gemini CLI onboarding",
    extraSecrets: [accessToken],
  });
  let operation = parseLongRunningOperation(await onboardResponse.json());
  if (!operation.done && operation.name !== undefined) {
    operation = await pollProvisioning(operation.name, headers, fetcher, signal, events);
  }
  if (operation.projectId !== undefined) {
    return operation.projectId;
  }
  if (envProject !== undefined) {
    return envProject;
  }
  throw new BridgeError(
    "invalidRequest",
    "Could not discover or provision a Google Cloud project. " +
      "Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
      "See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
  );
}

/** OMP getUserEmail: optional; any failure is swallowed, cancellation re-checked after. */
async function getUserEmail(accessToken: string, fetcher: Fetcher, signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await callProviderHttp({
      call: { url: USERINFO_URL, method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
      fetcher,
      signal: loginSignal(signal),
      endpointLabel: "Google user info",
      extraSecrets: [accessToken],
    });
    const data = await response.json();
    return isRecord(data) && typeof data["email"] === "string" && data["email"] !== "" ? data["email"] : undefined;
  } catch {
    return undefined;
  }
}

type GoogleTokenBundle = {
  readonly access: string;
  readonly refresh: string;
  readonly expiresAtMs: number;
};

/** OMP exchangeToken: authorization_code grant against oauth2.googleapis.com. */
async function exchangeToken(
  code: string,
  redirectUri: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<GoogleTokenBundle> {
  const response = await callProviderHttp({
    call: {
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
    },
    fetcher,
    signal: loginSignal(signal),
    endpointLabel: "Google token exchange",
    extraSecrets: [code],
  });
  const data = await response.json();
  if (!isRecord(data) || typeof data["access_token"] !== "string" || data["access_token"] === "") {
    throw new BridgeError("malformedPayload", "Google token response carried no access token");
  }
  if (typeof data["refresh_token"] !== "string" || data["refresh_token"] === "") {
    throw new BridgeError("malformedPayload", "No refresh token received. Please try again.");
  }
  if (typeof data["expires_in"] !== "number" || !Number.isFinite(data["expires_in"])) {
    throw new BridgeError("malformedPayload", "Google token response carried no expires_in");
  }
  return {
    access: data["access_token"],
    refresh: data["refresh_token"],
    expiresAtMs: Date.now() + data["expires_in"] * 1000 - EXPIRY_SAFETY_MS,
  };
}

async function waitForCallback(handle: LoopbackCallbackHandle, state: string, events: AuthEvents, signal: AbortSignal): Promise<string> {
  try {
    // OMP races the loopback callback against the manual paste channel
    // (onManualCodeInput / pasteCodeFlow fallback); the bridge routes the
    // paste through the duplex requestInput channel — never a tty.
    const callback = await waitForCallbackOrManualPaste({
      wait: handle.wait,
      expectedState: state,
      requestInput: events.requestInput,
      prompt: { prompt: BROWSER_PASTE_HINT, inputKind: "redirectUrl", sensitive: true },
      signal,
    });
    return callback.code;
  } catch (error) {
    if (error instanceof CallbackCancelledError) {
      throw new BridgeError(
        "timeout",
        signal.aborted
          ? "Google login cancelled while waiting for the browser callback"
          : "Google login timed out waiting for the browser callback",
      );
    }
    if (error instanceof CallbackFailedError) {
      // The redirect carried our state nonce: a provider-reported failure
      // such as the user denying the consent screen.
      throw new BridgeError("invalidRequest", error.message);
    }
    throw error;
  }
}

async function runBrowserLogin(
  events: AuthEvents,
  signal: AbortSignal,
  deps: GoogleGeminiCliLoginDeps,
): Promise<LoginResult> {
  const state = generateCallbackState();
  let handle: LoopbackCallbackHandle;
  try {
    handle = await startLoopbackCallback(state, {
      preferredPort: CALLBACK_PORT,
      callbackPath: CALLBACK_PATH,
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeError("transport", `unable to start the local Google OAuth callback server: ${message}`);
  }
  // The loopback deadline can reject this promise on paths that never await
  // it (e.g. an abort before the wait); keep that rejection observed.
  void handle.wait.catch(() => undefined);

  try {
    // OMP generateAuthUrl parameter set, verbatim (no PKCE for this flow).
    const authorizeUrl = `${AUTH_URL}?${new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: handle.redirectUri,
      scope: SCOPES.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    }).toString()}`;
    events.onEvent({ type: "openUrl", url: authorizeUrl });
    
    events.onEvent({ type: "pasteHint", detail: BROWSER_PASTE_HINT });
    events.onEvent({ type: "waiting", detail: "Waiting for browser authentication..." });

    const code = await waitForCallback(handle, state, events, signal);
    throwIfLoginCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Exchanging authorization code for tokens..." });
    const tokens = await exchangeToken(code, handle.redirectUri, deps.fetcher, signal);

    throwIfLoginCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Getting user info..." });
    const email = await getUserEmail(tokens.access, deps.fetcher, signal);
    throwIfLoginCancelled(signal);

    const projectId = await discoverProject(tokens.access, events, deps.fetcher, signal);
    const identity: Record<string, string> = { projectId, ...(email !== undefined ? { email } : {}) };
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
      ...(email !== undefined ? { accountLabel: email } : {}),
    };
  } finally {
    handle.stop();
  }
}

export async function loginGoogleGeminiCli(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: GoogleGeminiCliLoginDeps,
): Promise<LoginResult> {
  if (method !== "browser") {
    throw new BridgeError("invalidRequest", `provider "${PROVIDER_ID}" offers only the "browser" login method`);
  }
  throwIfLoginCancelled(signal);
  try {
    return await runBrowserLogin(events, signal, deps);
  } catch (error) {
    throw remapLoginError(error, signal);
  }
}

export const googleGeminiCliAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["browser"],
  login: (method, inputs, events, signal) =>
    loginGoogleGeminiCli(method, inputs, events, signal, { fetcher: platformFetch }),
};
