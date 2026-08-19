/**
 * Kimi Code provider module (device-flow auth + usage connector),
 * hand-ported from the pinned oh-my-pi checkout @ 8500092296621a6826b7136e840f8a59ea338958:
 *
 * - packages/ai/src/registry/oauth/kimi.ts  (device authorization grant, token
 *   refresh, JWT account-id parsing, X-Msh-* install headers)
 * - packages/ai/src/usage/kimi.ts           (usage fetch + normalization)
 * - packages/ai/src/usage/shared.ts         (usageStatus bands, parseIsoTimestamp)
 * - packages/ai/src/usage/minimax-code.ts   (the intervalWindowId convention
 *   kimi's canonicalWindowId mirrors)
 *
 * Kept from the OMP sources (same endpoints, client id, request bodies and
 * normalization boundaries):
 * - Auth: RFC 8628 device flow against https://auth.kimi.com/api/oauth/
 *   device_authorization + /token with client id
 *   17e5f671-d194-4dfb-9706-5516cb48c098 (verbatim), form-urlencoded bodies,
 *   the KimiCLI/17.3.7 + X-Msh-* install headers (platform kimi_cli, version,
 *   device name/model/os-version, install device id), the 15-min/5-s device
 *   flow defaults, and the 5-minute OAUTH_EXPIRY_SKEW_MS applied when minting
 *   absolute expiries. Account id is parsed from the access-token JWT
 *   (user_id || sub) and stored as identity/accountLabel.
 * - Refresh: POST /api/oauth/token with grant_type=refresh_token +
 *   refresh_token + client_id, refresh_token falling back to the previous one,
 *   access_token/expires_in required.
 * - Usage: GET https://api.kimi.com/coding/v1/usages with
 *   Authorization: Bearer <access> plus the X-Msh-* headers. The aggregate
 *   `usage` row becomes the canonical "7d" window; each `limits[]` row keeps
 *   its span canonicalized via duration/timeUnit (minute-multiples of whole
 *   hours collapse to Nh, whole days to Nd, else Nm, no duration -> default),
 *   with row-level reset times injected when the span window lacks one. Unit
 *   stays "unknown" (OMP never learns a unit for Kimi quotas); fractions are
 *   only ever used/limit (clamped), never invented; severity is translated to
 *   TokenMeter's protocol-wide fraction bands so Swift can enforce
 *   fraction/severity consistency.
 *
 * Deviations from the OMP sources (with reasons):
 * - OMP resolves the auth host and usage base URL from
 *   KIMI_CODE_OAUTH_HOST/KIMI_OAUTH_HOST and KIMI_CODE_BASE_URL; the bridge
 *   request carries no base URL and bridge providers own fixed endpoints, so
 *   both are pinned to https://auth.kimi.com / https://api.kimi.com/coding/v1.
 * - A successful rotation is never dropped: when the retried usage work
 *   fails after rotating (pre-flight or mid-flow 401), the failure carries
 *   refreshedCredential on the error envelope so the caller persists the
 *   rotated bundle before surfacing the error.
 * - OMP's null-report outcomes become typed BridgeErrors: HTTP failures map
 *   through callProviderHttp (401 -> authRequired, 429 -> rateLimited, ...),
 *   a non-object body -> malformedPayload, no usable rows -> noData. OMP's
 *   expired-token skip probe is replaced by the bridge rotation contract:
 *   rotate before the first call when expiresAtMs is missing/within 60s (and
 *   refresh material exists), rotate once and retry once on a mid-flow 401.
 * - OMP UsageLimit scope/metadata/raw and the amount remaining fields have no
 *   bridge UsageWindow equivalents and are dropped; window ids keep OMP's
 *   canonical span id ("kimi:7d", "kimi:5h", ...) instead of OMP's
 *   provider:index limit ids, which exist only for OMP's storage layer.
 * - OMP's non-oauth supports() gate becomes invalidRequest (the wire layer
 *   already selected this connector by providerId).
 * - The OMP agent dir resolver (XDG variants, profiles) is reduced to the
 *   PI_CODING_AGENT_DIR override plus the ~/.omp/agent default for the
 *   kimi-device-id install file; persistence stays best-effort with a
 *   per-process ephemeral fallback.
 * - Rotation computes expiresAtMs from the fetch's nowMs (deterministic for
 *   the bridge) instead of Date.now() at parse time.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeviceFlowCancelledError, DeviceFlowFailedError, runDeviceAuthorizationFlow } from "../auth/device";
import type { FetchLike } from "../auth/device";
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

const PROVIDER_ID = "kimi-code";
const CONNECTOR_VERSION = "kimi-code-1";

/** Fixed Kimi Code OAuth client id, verbatim from OMP registry/oauth/kimi.ts @ 8500092. */
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
/** OMP packages/ai/package.json version @ 8500092 (KimiCLI UA + X-Msh-Version). */
const KIMI_CLI_VERSION = "17.3.7";
const DEVICE_AUTHORIZATION_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1";
/** OMP normalizeBaseUrl + buildUsageUrl for the default base. */
const USAGE_URL = `${DEFAULT_BASE_URL.replace(/\/+$/, "")}/usages`;
const KIMI_QUOTA_EXHAUSTED_CODE = "1308";
const KIMI_FIVE_HOUR_EXHAUSTED_MESSAGE =
  /^Usage limit reached for 5 hour\. Your limit will reset at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** OMP OAUTH_EXPIRY_SKEW_MS: mint absolute expiries five minutes early. */
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Bridge wire contract: pre-rotate when expiry is missing or within 60s. */
const ROTATION_THRESHOLD_MS = 60 * 1000;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Kimi install headers (OMP registry/oauth/kimi.ts getKimiCommonHeaders)
// ---------------------------------------------------------------------------

const DEVICE_ID_FILENAME = "kimi-device-id";

/**
 * OMP resolves the agent dir through its DirResolver (PI_CODING_AGENT_DIR
 * override, ~/.omp/agent default; XDG variants only apply after a config
 * migration). Only the override + default are ported.
 */
function resolveAgentDir(): string {
  const override = process.env["PI_CODING_AGENT_DIR"]?.trim();
  if (override !== undefined && override !== "") {
    return override;
  }
  return path.join(os.homedir(), ".omp", "agent");
}

let deviceIdCache: string | undefined;

/**
 * Install device id, ported from OMP getDeviceId: read
 * <agentDir>/kimi-device-id, else mint a hyphenless UUID and persist it
 * best-effort (0o600). A missing/unwritable agent dir falls back to a
 * per-process ephemeral id and must never break header construction.
 */
function getDeviceId(): string {
  if (deviceIdCache !== undefined) {
    return deviceIdCache;
  }
  const deviceIdPath = path.join(resolveAgentDir(), DEVICE_ID_FILENAME);
  try {
    const existing = fs.readFileSync(deviceIdPath, "utf-8").trim();
    if (existing !== "") {
      deviceIdCache = existing;
      return existing;
    }
  } catch {
    // Unreadable device-id file: regenerate below.
  }

  const deviceId = crypto.randomUUID().replace(/-/g, "");
  try {
    fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });
    fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
  } catch {
    // Persist failure -> ephemeral id for this process.
  }
  deviceIdCache = deviceId;
  return deviceId;
}

/** OMP sanitizeHeaderValue: printable ASCII only, trimmed, with fallback. */
function sanitizeHeaderValue(value: string, fallback = ""): string {
  const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
  return sanitized !== "" ? sanitized : fallback;
}

/** OMP formatDeviceModel/getDeviceModel. */
function formatDeviceModel(system: string, release: string, arch: string): string {
  return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
  if (platform === "win32") return formatDeviceModel("Windows", release, arch);
  const label = platform === "linux" ? "Linux" : platform;
  return formatDeviceModel(label, release, arch);
}

let kimiHeadersCache: Readonly<Record<string, string>> | undefined;

/** X-Msh-* install headers + KimiCLI User-Agent, memoized per process. */
export function getKimiCommonHeaders(): Readonly<Record<string, string>> {
  if (kimiHeadersCache === undefined) {
    kimiHeadersCache = Object.freeze({
      "User-Agent": `KimiCLI/${KIMI_CLI_VERSION}`,
      "X-Msh-Platform": "kimi_cli",
      "X-Msh-Version": KIMI_CLI_VERSION,
      "X-Msh-Device-Name": sanitizeHeaderValue(os.hostname(), "unknown"),
      "X-Msh-Device-Model": sanitizeHeaderValue(getDeviceModel(), "unknown"),
      "X-Msh-Os-Version": sanitizeHeaderValue(os.version(), "unknown"),
      "X-Msh-Device-Id": sanitizeHeaderValue(getDeviceId(), "unknown"),
    });
  }
  return kimiHeadersCache;
}

// ---------------------------------------------------------------------------
// Token helpers (OMP registry/oauth/kimi.ts parseTokenPayload)
// ---------------------------------------------------------------------------

/**
 * Account id from the access-token JWT payload (user_id || sub, trimmed).
 * Opaque access tokens remain valid credentials without account metadata.
 */
function parseJwtAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  const payloadPart = parts.length === 3 ? parts[1] : undefined;
  if (payloadPart === undefined) {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!isRecord(decoded)) {
      return undefined;
    }
    const userId = typeof decoded["user_id"] === "string" ? decoded["user_id"].trim() : "";
    const subject = typeof decoded["sub"] === "string" ? decoded["sub"].trim() : "";
    return userId !== "" ? userId : subject !== "" ? subject : undefined;
  } catch {
    return undefined;
  }
}

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

// ---------------------------------------------------------------------------
// Usage normalization (OMP usage/kimi.ts + usage/shared.ts)
// ---------------------------------------------------------------------------

/** OMP usage/shared.ts parseIsoTimestamp. */
function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** OMP usage/kimi.ts parseResetTime: absolute keys first, then seconds keys. */
function parseResetTime(data: Record<string, unknown>, nowMs: number): number | undefined {
  const timeKeys = ["reset_at", "resetAt", "reset_time", "resetTime"] as const;
  for (const key of timeKeys) {
    const value = data[key];
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = parseIsoTimestamp(value);
      if (parsed !== undefined) {
        return parsed;
      }
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 1_000_000_000_000 ? value : value * 1000;
    }
  }

  const secondsKeys = ["reset_in", "resetIn", "ttl", "window"] as const;
  for (const key of secondsKeys) {
    const seconds = toNumber(data[key]);
    if (seconds !== undefined) {
      return nowMs + seconds * 1000;
    }
  }

  return undefined;
}

/** OMP formatDurationLabel. */
function formatDurationLabel(duration: number, timeUnit: string): string | undefined {
  const upper = timeUnit.toUpperCase();
  if (upper.includes("MINUTE")) {
    if (duration >= 60 && duration % 60 === 0) return `${duration / 60}h limit`;
    return `${duration}m limit`;
  }
  if (upper.includes("HOUR")) return `${duration}h limit`;
  if (upper.includes("DAY")) return `${duration}d limit`;
  if (upper.includes("SECOND")) return `${duration}s limit`;
  return undefined;
}

/** OMP buildWindow durationMs computation (minute/hour/day/week/second). */
function durationToMs(duration: number | undefined, timeUnit: string): number | undefined {
  if (duration === undefined) {
    return undefined;
  }
  const upper = timeUnit.toUpperCase();
  if (upper.includes("MINUTE")) return duration * MINUTE_MS;
  if (upper.includes("HOUR")) return duration * HOUR_MS;
  if (upper.includes("DAY")) return duration * DAY_MS;
  if (upper.includes("WEEK")) return duration * 7 * DAY_MS;
  if (upper.includes("SECOND")) return duration * 1000;
  return undefined;
}

/** OMP canonicalWindowId: whole days -> Nd, whole hours -> Nh, else Nm/default. */
function canonicalWindowId(durationMs: number): string {
  if (durationMs > 0 && durationMs % DAY_MS === 0) return `${durationMs / DAY_MS}d`;
  if (durationMs > 0 && durationMs % HOUR_MS === 0) return `${durationMs / HOUR_MS}h`;
  const minutes = Math.round(durationMs / MINUTE_MS);
  return minutes > 0 ? `${minutes}m` : "default";
}

/** One OMP-normalized usage row (OMP KimiUsageRow minus window durationMs). */
type KimiUsageRow = {
  readonly label: string;
  readonly used?: number;
  readonly limit?: number;
  readonly resetsAtMs?: number;
};

/** OMP KimiUsageRow.window reduced to the fields the bridge window needs. */
type KimiUsageWindow = {
  readonly id: string;
  readonly resetsAtMs?: number;
};

/** OMP buildUsageRow: used (or limit - remaining), limit, label, reset time. */
function buildUsageRow(data: Record<string, unknown>, defaultLabel: string, nowMs: number): KimiUsageRow | undefined {
  const limit = toNumber(data["limit"]);
  let used = toNumber(data["used"]);
  const remaining = toNumber(data["remaining"]);
  if (used === undefined && remaining !== undefined && limit !== undefined) {
    used = limit - remaining;
  }
  if (used === undefined && limit === undefined) {
    return undefined;
  }
  const resetsAtMs = parseResetTime(data, nowMs);
  const name = typeof data["name"] === "string" && data["name"] !== "" ? data["name"] : undefined;
  const title = typeof data["title"] === "string" && data["title"] !== "" ? data["title"] : undefined;
  return {
    label: name ?? title ?? defaultLabel,
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

/** OMP buildWindow: undefined when the span carries no duration/label/reset. */
function buildLimitWindow(windowData: Record<string, unknown>, nowMs: number): KimiUsageWindow | undefined {
  const duration = toNumber(windowData["duration"]);
  const timeUnit = typeof windowData["timeUnit"] === "string" ? windowData["timeUnit"] : "";
  const label = duration !== undefined && timeUnit !== "" ? formatDurationLabel(duration, timeUnit) : undefined;
  const resetsAtMs = parseResetTime(windowData, nowMs);
  if (duration === undefined && label === undefined && resetsAtMs === undefined) {
    return undefined;
  }
  const durationMs = durationToMs(duration, timeUnit);
  return {
    id: durationMs !== undefined ? canonicalWindowId(durationMs) : "default",
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

/**
 * OMP limits[] label chain: item.name/title/scope, detail.name/title, the
 * duration-derived label, then `Limit #N`.
 */
function limitRowLabel(
  item: Record<string, unknown>,
  detail: Record<string, unknown>,
  windowData: Record<string, unknown>,
  index: number,
): string {
  const candidates = [item["name"], item["title"], item["scope"], detail["name"], detail["title"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate !== "") {
      return candidate;
    }
  }
  const durationLabel = formatDurationLabel(toNumber(windowData["duration"]) ?? 0, String(windowData["timeUnit"] || ""));
  if (durationLabel !== undefined) {
    return durationLabel;
  }
  return `Limit #${index + 1}`;
}

/**
 * One bridge UsageWindow per OMP-normalized limit: id keeps OMP's canonical
 * span id, the fraction is used/limit clamped to [0, 1] (never invented) and
 * severity follows TokenMeter's protocol-wide fraction bands.
 */
function toUsageWindow(row: KimiUsageRow, window: KimiUsageWindow | undefined): UsageWindow {
  const resetsAtMs = window !== undefined ? (window.resetsAtMs ?? row.resetsAtMs) : row.resetsAtMs;
  let resolvedFraction: number | undefined;
  if (row.used !== undefined && row.limit !== undefined && row.limit > 0) {
    resolvedFraction = Math.min(Math.max(row.used / row.limit, 0), 1);
  }
  return {
    id: `kimi:${window?.id ?? "default"}`,
    label: row.label,
    unit: "unknown",
    ...(resolvedFraction !== undefined ? { resolvedFraction } : {}),
    severity: severityForFraction(resolvedFraction),
    ...(row.used !== undefined ? { used: row.used } : {}),
    ...(row.limit !== undefined ? { limit: row.limit } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

/** OMP parseUsagePayload: aggregate `usage` row + canonicalized `limits` spans. */
function windowsFromPayload(payload: unknown, nowMs: number): UsageWindow[] {
  if (!isRecord(payload)) {
    throw new BridgeError("malformedPayload", "Kimi usage endpoint returned a non-object body");
  }
  const windows: UsageWindow[] = [];

  const usage = payload["usage"];
  if (isRecord(usage)) {
    const row = buildUsageRow(usage, "Total quota", nowMs);
    if (row !== undefined) {
      // Kimi Code's aggregate quota resets weekly but the payload carries only
      // a reset time and no duration, so the canonical weekly window is
      // attached explicitly (OMP parseUsagePayload).
      windows.push(toUsageWindow(row, { id: "7d", ...(row.resetsAtMs !== undefined ? { resetsAtMs: row.resetsAtMs } : {}) }));
    }
  }

  const limits = payload["limits"];
  if (Array.isArray(limits)) {
    limits.forEach((item, index) => {
      if (!isRecord(item)) {
        return;
      }
      const detail = isRecord(item["detail"]) ? item["detail"] : item;
      const windowData = isRecord(item["window"]) ? item["window"] : {};
      const row = buildUsageRow(detail, limitRowLabel(item, detail, windowData, index), nowMs);
      if (row !== undefined) {
        windows.push(toUsageWindow(row, buildLimitWindow(windowData, nowMs)));
      }
    });
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Usage connector (OMP usage/kimi.ts fetchUsage)
// ---------------------------------------------------------------------------

const platformFetch: Fetcher = (url, init) => fetch(url, init);

function requestDeadlineSignal(request: BridgeRequest, nowMs: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
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

/** GET the usages endpoint with Bearer access (OMP fetchUsage call shape). */
type KimiUsageFetchResult =
  | { readonly kind: "payload"; readonly payload: unknown }
  | { readonly kind: "quotaWindow"; readonly window: UsageWindow };

async function fetchKimiUsageBody(
  accessToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<KimiUsageFetchResult> {
  const response = await callProviderHttp({
    call: {
      url: USAGE_URL,
      method: "GET",
      headers: {
        ...getKimiCommonHeaders(),
        Authorization: `Bearer ${accessToken}`,
      },
    },
    fetcher,
    signal,
    endpointLabel: "Kimi usage endpoint",
    acceptedStatuses: [429],
    extraSecrets: [accessToken],
  });
  if (response.status !== 429) {
    return { kind: "payload", payload: await response.json() };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw kimiRateLimited(response.headers);
  }
  const exhaustedWindow = kimiExhaustedWindow(payload);
  if (exhaustedWindow === undefined) {
    throw kimiRateLimited(response.headers);
  }
  return { kind: "quotaWindow", window: exhaustedWindow };
}

function kimiExhaustedWindow(payload: unknown): UsageWindow | undefined {
  if (!isRecord(payload) || payload["code"] !== KIMI_QUOTA_EXHAUSTED_CODE) {
    return undefined;
  }
  const message = payload["message"];
  if (typeof message !== "string") return undefined;
  const match = KIMI_FIVE_HOUR_EXHAUSTED_MESSAGE.exec(message);
  if (match === null) return undefined;
  const resetsAtMs = localDateTimeMs(match.slice(1));
  if (resetsAtMs === undefined) return undefined;
  return {
    id: "kimi:5h",
    label: "5h limit",
    unit: "unknown",
    resolvedFraction: 1,
    severity: "exhausted",
    resetsAtMs,
  };
}

function localDateTimeMs(parts: readonly string[]): number | undefined {
  if (parts.length !== 6) return undefined;
  const values = parts.map(Number);
  if (values.some(value => !Number.isInteger(value))) return undefined;
  const [year, month, day, hour, minute, second] = values;
  if (
    year === undefined
    || month === undefined
    || day === undefined
    || hour === undefined
    || minute === undefined
    || second === undefined
  ) {
    return undefined;
  }
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
  ) {
    return undefined;
  }
  return date.getTime();
}

function kimiRateLimited(headers: Headers): BridgeError {
  const rawRetryAfter = headers.get("retry-after");
  const seconds = rawRetryAfter === null ? Number.NaN : Number(rawRetryAfter);
  const retryAfterMs = Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : undefined;
  return new BridgeError(
    "rateLimited",
    "Kimi usage endpoint returned HTTP 429",
    { retryAfterMs },
  );
}

/**
 * Rotate the OAuth token via OMP refreshKimiToken's request shape:
 * form-urlencoded grant_type=refresh_token + refresh_token + client_id, with
 * refresh_token falling back to the previous one and the 5-minute skew on the
 * new absolute expiry.
 */
async function rotateKimiToken(input: {
  readonly credential: OAuthCredential;
  readonly fetcher: Fetcher;
  readonly signal: AbortSignal;
  readonly nowMs: number;
}): Promise<OAuthCredential> {
  const oauth = input.credential.oauth;
  const refreshToken = oauth.refresh;
  const refreshEndpoint = oauth.refreshEndpoint;
  if (refreshToken === undefined || refreshEndpoint === undefined) {
    throw new BridgeError("authRequired", "Kimi token refresh requires a refresh token and refresh endpoint");
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const response = await callProviderHttp({
    call: {
      url: refreshEndpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...getKimiCommonHeaders(),
      },
      body: body.toString(),
    },
    fetcher: input.fetcher,
    signal: input.signal,
    endpointLabel: "Kimi token refresh",
    extraSecrets: [oauth.access, refreshToken],
  });

  const payload = await response.json();
  if (!isRecord(payload)) {
    throw new BridgeError("malformedPayload", "Kimi token refresh returned a non-object body");
  }
  const access = typeof payload["access_token"] === "string" ? payload["access_token"] : "";
  if (access === "") {
    throw new BridgeError("authRequired", "Kimi token response missing access token");
  }
  const expiresIn = payload["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new BridgeError("authRequired", "Kimi token response missing expires_in");
  }
  // OMP parseTokenPayload: payload refresh wins, previous one is the fallback.
  const refresh = typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : refreshToken;
  if (refresh === "") {
    throw new BridgeError("authRequired", "Kimi token response missing refresh token");
  }
  const accountId = parseJwtAccountId(access) ?? oauth.identity?.["accountId"];

  return {
    kind: "oauth",
    secret: access,
    oauth: {
      access,
      refresh,
      expiresAtMs: input.nowMs + expiresIn * 1000 - OAUTH_EXPIRY_SKEW_MS,
      refreshEndpoint,
      clientId: oauth.clientId ?? CLIENT_ID,
      ...(accountId !== undefined ? { identity: { accountId } } : {}),
    },
  };
}

export const kimiCodeConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    const credential = request.credential;
    if (credential === undefined) {
      throw new BridgeError("missingCredential", "kimi-code usage requires a credential");
    }
    if (credential.kind !== "oauth" && credential.kind !== "apiKey") {
      throw new BridgeError("invalidRequest", 'kimi-code usage requires an "oauth" or "apiKey" credential');
    }
    if (credential.secret === "") {
      throw new BridgeError("authRequired", "kimi-code credential carries no access token");
    }

    const signal = requestDeadlineSignal(request, nowMs);
    let active: BridgeCredential = credential;
    let refreshedCredential: BridgeCredential | undefined;

    try {
      if (active.kind === "oauth" && needsPreRotation(active.oauth, nowMs)) {
        active = await rotateKimiToken({ credential: active, fetcher, signal, nowMs });
        refreshedCredential = active;
      }

      let usageResult: KimiUsageFetchResult;
      try {
        usageResult = await fetchKimiUsageBody(active.secret, fetcher, signal);
      } catch (error) {
        const retryWithRotation =
          active.kind === "oauth"
          && error instanceof BridgeError
          && error.kind === "authRequired"
          && refreshedCredential === undefined
          && hasRefreshMaterial(active.oauth);
        if (!retryWithRotation) {
          throw error;
        }
        if (active.kind !== "oauth") {
          throw error;
        }
        // 401 mid-flow: rotate once, retry the usage call once.
        active = await rotateKimiToken({ credential: active, fetcher, signal, nowMs });
        refreshedCredential = active;
        usageResult = await fetchKimiUsageBody(active.secret, fetcher, signal);
      }

      const windows = usageResult.kind === "quotaWindow"
        ? [usageResult.window]
        : windowsFromPayload(usageResult.payload, nowMs);
      if (windows.length === 0) {
        throw new BridgeError("noData", "Kimi usage response contained no usable quota rows");
      }

      const report: UsageReport = {
        productKind: "quota",
        sourceKind: "firstPartyApi",
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
      // Rotation durability: Kimi's refresh grant burns the old refresh
      // token, so a rotated bundle must reach the caller even when the
      // retried usage work fails.
      throw rethrowWithRefreshedCredential(error, refreshedCredential);
    }
  },
};

// ---------------------------------------------------------------------------
// Auth module (OMP registry/oauth/kimi.ts loginKimi via the shared engine)
// ---------------------------------------------------------------------------

function cancelled(): BridgeError {
  return new BridgeError("timeout", "Kimi Code login was cancelled");
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

/**
 * The shared device-flow engine posts form bodies without provider headers
 * (see auth/device.ts); Kimi requires the X-Msh-* install headers on every
 * call, so the injected fetcher merges them in.
 */
function withKimiHeaders(fetcher: Fetcher): FetchLike {
  return (input, init) => {
    const mergedHeaders: Record<string, string> = {
      // The engine always passes a plain header record.
      ...(init?.headers as Record<string, string> | undefined),
      ...getKimiCommonHeaders(),
    };
    return fetcher(input as string, { ...init, headers: mergedHeaders });
  };
}

export type KimiCodeLoginDeps = {
  readonly fetcher?: Fetcher;
  /** Injectable clock; forwarded to the device-flow engine for deterministic expiry. */
  readonly now?: () => number;
  /** Injectable sleep; forwarded to the device-flow engine for deterministic polling tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/**
 * Device-authorization login against auth.kimi.com. Emits openUrl
 * (verification_uri_complete), code (user_code) and waiting events from the
 * shared engine, then stores access/refresh/expiry (with the 5-minute skew)
 * plus the JWT-derived account id.
 */
export async function loginKimiCode(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: KimiCodeLoginDeps = {},
): Promise<LoginResult> {
  if (signal.aborted) {
    throw cancelled();
  }
  if (method === "apiKey") {
    let rawAPIKey = inputs.apiKey;
    if (rawAPIKey === undefined) {
      const requestInput = events.requestInput;
      if (requestInput === undefined) {
        throw new BridgeError("missingCredential", "Kimi Code API key is required");
      }
      rawAPIKey = await requestInput(
        {
          prompt: "Kimi Code API 키를 입력하세요.",
          inputKind: "text",
          sensitive: true,
        },
        signal,
      );
    }
    const apiKey = rawAPIKey.trim();
    if (apiKey === "") {
      throw new BridgeError("missingCredential", "Kimi Code API key is required");
    }
    await fetchKimiUsageBody(apiKey, deps.fetcher ?? platformFetch, signal);
    return {
      credential: { kind: "apiKey", secret: apiKey },
      accountLabel: "Kimi Code API key",
    };
  }
  if (method !== "device") {
    throw new BridgeError("invalidRequest", `kimi-code does not support auth method "${method}"`);
  }
  try {
    const tokens = await runDeviceAuthorizationFlow(
      {
        deviceAuthorizationUrl: DEVICE_AUTHORIZATION_URL,
        tokenUrl: TOKEN_URL,
        clientId: CLIENT_ID,
      },
      {
        fetchImpl: withKimiHeaders(deps.fetcher ?? platformFetch),
        signal,
        events,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      },
    );

    const accountId = parseJwtAccountId(tokens.access);
    const credential: BridgeCredential = {
      kind: "oauth",
      secret: tokens.access,
      oauth: {
        access: tokens.access,
        ...(tokens.refresh !== undefined && tokens.refresh !== "" ? { refresh: tokens.refresh } : {}),
        ...(tokens.expiresAtMs !== undefined ? { expiresAtMs: tokens.expiresAtMs } : {}),
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        ...(accountId !== undefined ? { identity: { accountId } } : {}),
      },
    };
    return {
      credential,
      ...(accountId !== undefined ? { accountLabel: accountId } : {}),
    };
  } catch (error) {
    throw remapLoginError(error, signal);
  }
}

export const kimiCodeAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["device", "apiKey"],
  login: (method, inputs, events, signal) => loginKimiCode(method, inputs, events, signal),
  /** OMP refreshKimiToken via global fetch; the connector rotates with its own fetcher. */
  refresh: (credential, signal) => {
    if (credential.kind !== "oauth") {
      throw new BridgeError("invalidRequest", 'kimi-code refresh requires an "oauth" credential');
    }
    return rotateKimiToken({ credential, fetcher: platformFetch, signal, nowMs: Date.now() });
  },
};
