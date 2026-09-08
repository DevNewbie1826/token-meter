/**
 * Antigravity quota/control-plane port from OMP d720e81fb747132f0b6c6c0f44eafc887552ec7f:
 * packages/ai/src/usage/google-antigravity.ts and registry/oauth/google-antigravity.ts.
 * Summary-first with legacy backend-counter fallback; one row per shared bucket,
 * not OMP's duplicated model-ranking scopes. Unknown remaining amounts have no
 * invented denominator and all severity uses the shared Swift-compatible bands.
 * Native daily control plane hydrates eligibility, posts free-tier onboarding once,
 * polls named GET operations within 30s, then refreshes project discovery.
 * Existing Google OAuth client/scopes/callback/refresh constants remain unchanged.
 * Bridge deviations: strict malformed-payload errors; terminal auth/throttle/abort
 * failures are not hidden by optional summary fallback; all-disabled summary is
 * noData. Rotated credentials survive every typed failure. No model catalog,
 * external OMP runtime, automatic version discovery, or release test controls.
 */

import { defaultBrowserOpener, openInBrowser } from "../auth/open-browser";
import type { BrowserOpener } from "../auth/open-browser";
import {
  CallbackCancelledError,
  CallbackFailedError,
  generateCallbackState,
  startLoopbackCallback,
} from "../auth/loopback";
import type { LoopbackCallbackHandle } from "../auth/loopback";
import { rotateOAuthToken, rethrowWithRefreshedCredential, waitForCallbackOrManualPaste } from "../auth/refresh";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction, redactSecrets } from "../protocol";
import type {
  BridgeCredential,
  BridgeRequest,
  BridgeSuccessResponse,
  OAuthCredential,
  UsageReport,
  UsageWindow,
} from "../protocol";

const PROVIDER_ID = "google-antigravity";
const CONNECTOR_VERSION = "google-antigravity-1";

// OMP packages/ai/src/registry/oauth/google-antigravity.ts, verbatim.
const CLIENT_ID = atob(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50" +
    "LmNvbQ==",
);
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";

const BROWSER_PASTE_HINT =
  "Complete the sign-in in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const DAILY_CLOUD_CODE_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const DAILY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const FETCH_AVAILABLE_MODELS_PATH = "/v1internal:fetchAvailableModels";
const RETRIEVE_USER_QUOTA_SUMMARY_PATH = "/v1internal:retrieveUserQuotaSummary";
const TIER_FREE = "free-tier";
const PROJECT_ONBOARD_TIMEOUT_MS = 30_000;
const PROJECT_ONBOARD_INTERVAL_MS = 1000;
/** OMP google-oauth-shared.ts OAUTH_REQUEST_TIMEOUT_MS. */
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;
/** OMP 5-minute early expiry skew applied to expires_in. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** Bridge pre-rotation window: rotate when expiry is missing or this close. */
const ROTATION_WINDOW_MS = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// OMP packages/catalog/src/wire/gemini-headers.ts (offline-default path).
const DEFAULT_ANTIGRAVITY_VERSION = "2.8.0";

function getAntigravityVersion(): string {
  return process.env["PI_AI_ANTIGRAVITY_VERSION"] || DEFAULT_ANTIGRAVITY_VERSION;
}

/** OMP getAntigravityUserAgent: pinned darwin/arm64 reference client. */
function getAntigravityUserAgent(): string {
  const cl = process.env["PI_AI_ANTIGRAVITY_CL"] || "963137146";
  const os = process.env["PI_AI_ANTIGRAVITY_OS"] || "darwin";
  const arch = process.env["PI_AI_ANTIGRAVITY_ARCH"] || "arm64";
  return `antigravity/hub/${getAntigravityVersion()} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function throwIfAntigravityCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("timeout", "Antigravity login was cancelled");
  }
}

function antigravityRequestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)]);
}

// ---------------------------------------------------------------------------
// Usage connector (OMP packages/ai/src/usage/google-antigravity.ts)
// ---------------------------------------------------------------------------

interface AntigravityQuotaInfo {
  readonly remainingFraction?: number;
  readonly resetTime?: string;
  readonly tier?: string;
  readonly windowId?: string;
  readonly windowLabel?: string;
  readonly apiProvider?: string;
  readonly modelProvider?: string;
}

type AntigravityQuotaInfoList = AntigravityQuotaInfo | AntigravityQuotaInfo[];

interface AntigravityModelInfo {
  readonly quotaInfo?: AntigravityQuotaInfoList;
  readonly quotaInfos?: AntigravityQuotaInfo[];
  readonly dailyQuotaInfo?: AntigravityQuotaInfoList;
  readonly dailyQuotaInfos?: AntigravityQuotaInfo[];
  readonly weeklyQuotaInfo?: AntigravityQuotaInfoList;
  readonly weeklyQuotaInfos?: AntigravityQuotaInfo[];
  readonly quotaInfoByTier?: Readonly<Record<string, AntigravityQuotaInfoList>>;
  readonly quotaInfoByWindow?: Readonly<Record<string, AntigravityQuotaInfoList>>;
  readonly quotaInfosByWindow?: Readonly<Record<string, AntigravityQuotaInfoList>>;
  readonly apiProvider?: string;
  readonly modelProvider?: string;
}

function parseQuotaInfo(value: unknown): AntigravityQuotaInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const remainingFraction = value["remainingFraction"];
  const resetTime = value["resetTime"];
  const tier = value["tier"];
  const windowId = value["windowId"];
  const windowLabel = value["windowLabel"];
  const apiProvider = value["apiProvider"];
  const modelProvider = value["modelProvider"];
  return {
    ...(typeof remainingFraction === "number" && Number.isFinite(remainingFraction)
      ? { remainingFraction }
      : {}),
    ...(typeof resetTime === "string" ? { resetTime } : {}),
    ...(typeof tier === "string" ? { tier } : {}),
    ...(typeof windowId === "string" ? { windowId } : {}),
    ...(typeof windowLabel === "string" ? { windowLabel } : {}),
    ...(typeof apiProvider === "string" ? { apiProvider } : {}),
    ...(typeof modelProvider === "string" ? { modelProvider } : {}),
  };
}

function parseQuotaInfoList(value: unknown): AntigravityQuotaInfoList | undefined {
  const single = parseQuotaInfo(value);
  if (single !== undefined) {
    return single;
  }
  if (Array.isArray(value)) {
    const entries = value
      .map((entry) => parseQuotaInfo(entry))
      .filter((entry): entry is AntigravityQuotaInfo => entry !== undefined);
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
}

function parseQuotaInfoArray(value: unknown): AntigravityQuotaInfo[] | undefined {
  const parsed = parseQuotaInfoList(value);
  return parsed === undefined ? undefined : Array.isArray(parsed) ? parsed : [parsed];
}

function parseQuotaInfoMap(value: unknown): Readonly<Record<string, AntigravityQuotaInfoList>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: Record<string, AntigravityQuotaInfoList> = {};
  for (const [key, raw] of Object.entries(value)) {
    const parsed = parseQuotaInfoList(raw);
    if (parsed !== undefined) {
      entries[key] = parsed;
    }
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function parseModelInfo(value: unknown): AntigravityModelInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const quotaInfo = parseQuotaInfoList(value["quotaInfo"]);
  const quotaInfos = parseQuotaInfoArray(value["quotaInfos"]);
  const dailyQuotaInfo = parseQuotaInfoList(value["dailyQuotaInfo"]);
  const dailyQuotaInfos = parseQuotaInfoArray(value["dailyQuotaInfos"]);
  const weeklyQuotaInfo = parseQuotaInfoList(value["weeklyQuotaInfo"]);
  const weeklyQuotaInfos = parseQuotaInfoArray(value["weeklyQuotaInfos"]);
  const quotaInfoByTier = parseQuotaInfoMap(value["quotaInfoByTier"]);
  const quotaInfoByWindow = parseQuotaInfoMap(value["quotaInfoByWindow"]);
  const quotaInfosByWindow = parseQuotaInfoMap(value["quotaInfosByWindow"]);
  const info: AntigravityModelInfo = {
    ...(quotaInfo !== undefined ? { quotaInfo } : {}),
    ...(quotaInfos !== undefined ? { quotaInfos } : {}),
    ...(dailyQuotaInfo !== undefined ? { dailyQuotaInfo } : {}),
    ...(dailyQuotaInfos !== undefined ? { dailyQuotaInfos } : {}),
    ...(weeklyQuotaInfo !== undefined ? { weeklyQuotaInfo } : {}),
    ...(weeklyQuotaInfos !== undefined ? { weeklyQuotaInfos } : {}),
    ...(quotaInfoByTier !== undefined ? { quotaInfoByTier } : {}),
    ...(quotaInfoByWindow !== undefined ? { quotaInfoByWindow } : {}),
    ...(quotaInfosByWindow !== undefined ? { quotaInfosByWindow } : {}),
    ...(typeof value["apiProvider"] === "string" ? { apiProvider: value["apiProvider"] } : {}),
    ...(typeof value["modelProvider"] === "string" ? { modelProvider: value["modelProvider"] } : {}),
  };
  return Object.keys(info).length > 0 ? info : undefined;
}

interface AntigravityWindowDescriptor {
  readonly id: string;
  readonly label: string;
  readonly durationMs?: number;
}

function classifyWindow(id: string | undefined, label: string | undefined): AntigravityWindowDescriptor | undefined {
  const source = `${id ?? ""} ${label ?? ""}`.toLowerCase();
  if (source.includes("week") || source.includes("7d") || /7[\s_-]*day/.test(source)) {
    return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
  }
  if (source.includes("day") || source.includes("daily") || source.includes("24h")) {
    return { id: "daily", label: "Daily", durationMs: DAY_MS };
  }
  if (id || label) {
    return { id: id ?? label ?? "default", label: label ?? id ?? "Default" };
  }
  return undefined;
}

function inferWindowFromReset(resetAt: number | undefined, nowMs: number): AntigravityWindowDescriptor {
  if (resetAt !== undefined && resetAt - nowMs > DAY_MS) {
    return { id: "weekly", label: "Weekly", durationMs: WEEK_MS };
  }
  return { id: "daily", label: "Daily", durationMs: DAY_MS };
}

/** OMP parseIsoTimestamp: ISO string -> epoch ms. */
function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quotaInferenceKey(info: AntigravityQuotaInfo): string {
  return [info.modelProvider ?? "", info.apiProvider ?? "", info.tier ?? ""].join("|");
}

function inferWindowDescriptors(
  quotaInfos: readonly AntigravityQuotaInfo[],
  nowMs: number,
): WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor> {
  const descriptors = new WeakMap<AntigravityQuotaInfo, AntigravityWindowDescriptor>();
  const groups = new Map<string, { info: AntigravityQuotaInfo; resetAt: number | undefined }[]>();

  for (const info of quotaInfos) {
    const explicitDescriptor = classifyWindow(info.windowId, info.windowLabel);
    if (explicitDescriptor !== undefined) {
      descriptors.set(info, explicitDescriptor);
      continue;
    }
    const group = groups.get(quotaInferenceKey(info)) ?? [];
    group.push({ info, resetAt: parseIsoTimestamp(info.resetTime) });
    groups.set(quotaInferenceKey(info), group);
  }

  for (const group of groups.values()) {
    const resetTimes = [...new Set(group.map((entry) => entry.resetAt).filter((resetAt) => resetAt !== undefined))].sort(
      (a, b) => a - b,
    );
    const latestReset = resetTimes.length > 1 ? resetTimes.at(-1) : undefined;
    for (const entry of group) {
      const descriptor =
        latestReset !== undefined && entry.resetAt === latestReset
          ? { id: "weekly", label: "Weekly", durationMs: WEEK_MS }
          : inferWindowFromReset(entry.resetAt, nowMs);
      descriptors.set(entry.info, descriptor);
    }
  }

  return descriptors;
}

function withWindowDescriptor(
  info: AntigravityQuotaInfo,
  descriptor: AntigravityWindowDescriptor | undefined,
): AntigravityQuotaInfo {
  if (descriptor === undefined) {
    return info;
  }
  return {
    ...info,
    windowId: info.windowId ?? descriptor.id,
    windowLabel: info.windowLabel ?? descriptor.label,
  };
}

function clampFraction(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

interface ParsedWindow {
  readonly id: string;
  readonly label: string;
  readonly resetsAt?: number;
}

function parseWindow(info: AntigravityQuotaInfo, descriptor: AntigravityWindowDescriptor | undefined): ParsedWindow | undefined {
  const resetAt = parseIsoTimestamp(info.resetTime);
  const hasResetAt = resetAt !== undefined;
  if (descriptor === undefined && !hasResetAt) {
    return undefined;
  }
  return {
    id: descriptor?.id ?? info.windowId ?? "default",
    label: info.windowLabel ?? descriptor?.label ?? "Default",
    ...(hasResetAt ? { resetsAt: resetAt } : {}),
  };
}

type AntigravityAmount = {
  readonly remainingFraction?: number;
  readonly usedFraction?: number;
  readonly remaining?: number;
  readonly used?: number;
  readonly limit?: number;
};

/**
 * OMP buildAmount: percent-remaining counter. Observed Antigravity responses
 * omit remainingFraction for exhausted counters and keep only resetTime —
 * that shape counts as exhausted-until-reset, not unknown.
 */
function buildAmount(info: AntigravityQuotaInfo): AntigravityAmount {
  const apiRemainingFraction = clampFraction(info.remainingFraction);
  const remainingFraction = apiRemainingFraction ?? (parseIsoTimestamp(info.resetTime) !== undefined ? 0 : undefined);
  if (remainingFraction === undefined) {
    return {};
  }
  const usedFraction = 1 - remainingFraction;
  return {
    remainingFraction,
    usedFraction,
    remaining: remainingFraction * 100,
    used: usedFraction * 100,
    limit: 100,
  };
}

function formatCounterName(info: AntigravityQuotaInfo): string | undefined {
  switch (info.modelProvider ?? info.apiProvider) {
    case "MODEL_PROVIDER_ANTHROPIC":
    case "API_PROVIDER_ANTHROPIC_VERTEX":
      return "Anthropic";
    case "MODEL_PROVIDER_GOOGLE":
    case "API_PROVIDER_GOOGLE_GEMINI":
      return "Google";
    case "MODEL_PROVIDER_OPENAI":
    case "API_PROVIDER_OPENAI_VERTEX":
      return "OpenAI";
    default:
      return undefined;
  }
}

function normalizeQuotaInfos(info: AntigravityModelInfo): AntigravityQuotaInfo[] {
  const results: AntigravityQuotaInfo[] = [];
  const source = {
    ...(info.apiProvider !== undefined ? { apiProvider: info.apiProvider } : {}),
    ...(info.modelProvider !== undefined ? { modelProvider: info.modelProvider } : {}),
  };
  const addInfo = (value: AntigravityQuotaInfo, tier?: string, windowDescriptor?: AntigravityWindowDescriptor) => {
    results.push({ ...source, ...withWindowDescriptor(value, windowDescriptor), ...(tier !== undefined ? { tier } : {}) });
  };
  const addValue = (
    value: AntigravityQuotaInfoList | AntigravityQuotaInfo[] | undefined,
    tier?: string,
    windowDescriptor?: AntigravityWindowDescriptor,
  ) => {
    if (value === undefined) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        addInfo(entry, tier, windowDescriptor);
      }
      return;
    }
    addInfo(value, tier, windowDescriptor);
  };

  addValue(info.quotaInfo);
  addValue(info.quotaInfos);
  addValue(info.dailyQuotaInfo, undefined, classifyWindow("daily", "Daily"));
  addValue(info.dailyQuotaInfos, undefined, classifyWindow("daily", "Daily"));
  addValue(info.weeklyQuotaInfo, undefined, classifyWindow("weekly", "Weekly"));
  addValue(info.weeklyQuotaInfos, undefined, classifyWindow("weekly", "Weekly"));

  if (info.quotaInfoByTier !== undefined) {
    for (const [tier, value] of Object.entries(info.quotaInfoByTier)) {
      addValue(value, tier);
    }
  }

  const addWindowMap = (values: Readonly<Record<string, AntigravityQuotaInfoList>> | undefined) => {
    if (values === undefined) {
      return;
    }
    for (const [windowId, value] of Object.entries(values)) {
      addValue(value, undefined, classifyWindow(windowId, undefined));
    }
  };
  addWindowMap(info.quotaInfoByWindow);
  addWindowMap(info.quotaInfosByWindow);

  return results;
}

type DedupeEntry = {
  amount: AntigravityAmount;
  window: ParsedWindow | undefined;
  tier: string | undefined;
  tierKey: string;
  windowId: string;
  counterName: string | undefined;
  counterKey: string;
  bareFullRemaining: boolean;
};

/**
 * OMP dedupe: quota is shared across models within the same backend counter,
 * tier and reset window; keep Google/Anthropic/OpenAI counters separate so a
 * healthy counter cannot mask an exhausted one. Merge keeps a fraction when
 * one exists (preferring lower remaining) and any window with a reset time.
 */
function dedupeAntigravityLimits(modelInfos: readonly AntigravityModelInfo[], nowMs: number): DedupeEntry[] {
  const deduped = new Map<string, DedupeEntry>();
  for (const modelInfo of modelInfos) {
    const quotaInfos = normalizeQuotaInfos(modelInfo);
    const inferredDescriptors = inferWindowDescriptors(quotaInfos, nowMs);
    for (const quotaInfo of quotaInfos) {
      const amount = buildAmount(quotaInfo);
      if (amount.remainingFraction === undefined) continue;
      const window = parseWindow(quotaInfo, inferredDescriptors.get(quotaInfo));
      const tierKey = (quotaInfo.tier ?? "default").toLowerCase();
      const counterName = formatCounterName(quotaInfo);
      const counterKey = counterName?.toLowerCase() ?? "default";
      const windowId = window?.id ?? quotaInfo.windowId ?? "default";
      // Capture before inferred daily descriptors erase the distinction between
      // bare autocomplete counters and explicitly identified independent windows.
      const bareFullRemaining = quotaInfo.remainingFraction === 1 && quotaInfo.resetTime === undefined &&
        quotaInfo.windowId === undefined && quotaInfo.windowLabel === undefined;
      const key = `${counterKey}|${tierKey}|${windowId}`;
      const existing = deduped.get(key);
      if (existing === undefined) {
        deduped.set(key, { amount, window, tier: quotaInfo.tier, tierKey, windowId, counterName, counterKey, bareFullRemaining });
        continue;
      }
      const eFrac = existing.amount.remainingFraction;
      const cFrac = amount.remainingFraction;
      const eHasFrac = eFrac !== undefined;
      const cHasFrac = cFrac !== undefined;

      let bestAmount = existing.amount;
      let bestWindow = existing.window?.resetsAt !== undefined ? existing.window : window ?? existing.window;
      let bestTier = existing.tier ?? quotaInfo.tier;

      if (!eHasFrac && cHasFrac) {
        bestAmount = amount;
        bestTier = quotaInfo.tier ?? existing.tier;
      } else if (eFrac !== undefined && cFrac !== undefined && cFrac < eFrac) {
        bestAmount = amount;
        bestTier = quotaInfo.tier ?? existing.tier;
      }
      if (bestWindow?.resetsAt === undefined && window?.resetsAt !== undefined) {
        bestWindow = window;
      }
      deduped.set(key, {
        amount: bestAmount,
        window: bestWindow,
        tier: bestTier,
        tierKey: existing.tierKey,
        windowId: existing.windowId,
        counterName: existing.counterName,
        counterKey: existing.counterKey,
        bareFullRemaining: existing.bareFullRemaining && bareFullRemaining,
      });
    }
  }
  const meteredCounters = new Set([...deduped.values()]
    .filter(entry => entry.window?.resetsAt !== undefined)
    .map(entry => `${entry.counterKey}|${entry.tierKey}`));
  // A missing reset alone is not phantom evidence. Suppress only bare unused
  // duplicates beside a metered sibling, retaining consumed or explicit windows.
  return [...deduped.values()].filter(entry => !entry.bareFullRemaining ||
    !meteredCounters.has(`${entry.counterKey}|${entry.tierKey}`));
}

/** One bridge UsageWindow per OMP-normalized limit, sorted ascending by remaining. */
function buildUsageWindows(modelInfos: readonly AntigravityModelInfo[], nowMs: number): UsageWindow[] {
  const entries = dedupeAntigravityLimits(modelInfos, nowMs).map((entry) => ({
    remainingFraction: entry.amount.remainingFraction,
    window: {
      id: `${PROVIDER_ID}:${entry.counterKey}:${entry.tierKey}:${entry.windowId}`,
      label: entry.counterName !== undefined ? `Usage (${entry.counterName})` : "Usage",
      unit: "percent" as const,
      severity: severityForFraction(entry.amount.usedFraction),
      ...(entry.amount.usedFraction !== undefined
        ? { resolvedFraction: entry.amount.usedFraction, used: entry.amount.used, limit: entry.amount.limit }
        : {}),
      ...(entry.window?.resetsAt !== undefined ? { resetsAtMs: entry.window.resetsAt } : {}),
    },
  }));
  entries.sort((a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1));
  return entries.map((entry) => entry.window);
}

/** OMP refreshAntigravityToken request shape (refresh grant + client secret). */
function mapAntigravityTokenResponse(json: unknown): { access: string; refresh?: string; expiresInMs?: number } {
  if (!isRecord(json)) {
    return { access: "" };
  }
  const access = typeof json["access_token"] === "string" ? json["access_token"] : "";
  const refresh = typeof json["refresh_token"] === "string" ? json["refresh_token"] : undefined;
  const expiresIn = typeof json["expires_in"] === "number" && Number.isFinite(json["expires_in"]) ? json["expires_in"] : undefined;
  return {
    access,
    ...(refresh !== undefined && refresh !== "" ? { refresh } : {}),
    ...(expiresIn !== undefined ? { expiresInMs: expiresIn * 1000 - EXPIRY_SKEW_MS } : {}),
  };
}

/**
 * Rotate an Antigravity OAuth credential exactly like OMP
 * refreshAntigravityToken: the pinned token endpoint and client id/secret,
 * keeping the prior refresh token when the response omits one.
 */
export async function refreshAntigravityCredential(
  credential: BridgeCredential,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  if (credential.kind !== "oauth" || credential.oauth.refresh === undefined) {
    throw new BridgeError("authRequired", "Antigravity token refresh requires an OAuth credential with a refresh token");
  }
  const normalized: OAuthCredential = {
    ...credential,
    oauth: {
      ...credential.oauth,
      refreshEndpoint: credential.oauth.refreshEndpoint ?? TOKEN_URL,
      clientId: credential.oauth.clientId ?? CLIENT_ID,
    },
  };
  return await rotateOAuthToken({
    credential: normalized,
    fetcher,
    signal,
    extraBody: { client_secret: CLIENT_SECRET },
    mapResponse: mapAntigravityTokenResponse,
  });
}

async function postAntigravityQuota(
  path: string,
  accessToken: string,
  projectId: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<unknown> {
  const endpoints = [DAILY_CLOUD_CODE_ENDPOINT, DAILY_SANDBOX_ENDPOINT];
  for (let index = 0; index < endpoints.length; index += 1) {
    const endpoint = endpoints[index];
    if (endpoint === undefined) {
      break;
    }
    try {
      const response = await callProviderHttp({
        call: {
          url: `${endpoint}${path}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            "User-Agent": getAntigravityUserAgent(),
          },
          body: JSON.stringify({ project: projectId }),
        },
        fetcher,
        signal,
        endpointLabel: "antigravity usage endpoint",
        extraSecrets: [accessToken],
        acceptedStatuses: path === RETRIEVE_USER_QUOTA_SUMMARY_PATH ? [404, 405] : [],
      });
      if (response.status === 404 || response.status === 405) return undefined;
      return await response.json();
    } catch (error) {
      // OMP endpoint fallback: transient statuses (408/429/5xx via the shared
      // status map) and network failures move on to the sandbox endpoint;
      // every other failure is final.
      const last = index === endpoints.length - 1;
      if (
        error instanceof BridgeError &&
        !last &&
        (error.kind === "rateLimited" || error.kind === "upstreamError" || error.kind === "transport")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new BridgeError("upstreamError", "antigravity usage endpoints exhausted");
}

/** Parse only the upstream quota summary fields, never its model/ranking catalog. */
function summaryWindows(payload: unknown): UsageWindow[] | undefined {
  if (!isRecord(payload)) throw new BridgeError("malformedPayload", "antigravity summary must be an object");
  const groups = summaryArray(payload["groups"]);
  const topLevel = summaryArray(payload["buckets"]);
  const grouped = groups.map(group => {
    if (!isRecord(group)) throw new BridgeError("malformedPayload", "antigravity summary group must be an object");
    return { label: summaryString(group, "displayName"), buckets: summaryArray(group["buckets"]) };
  });
  const sources = grouped.some(group => group.buckets.length > 0) ? grouped : [{ label: undefined, buckets: topLevel }];
  if (!sources.some(group => group.buckets.length > 0)) return undefined;
  const windows: UsageWindow[] = [];
  for (const [groupIndex, group] of sources.entries()) {
    for (const [bucketIndex, bucket] of group.buckets.entries()) {
      if (!isRecord(bucket)) throw new BridgeError("malformedPayload", "antigravity summary bucket must be an object");
      const disabled = bucket["disabled"];
      if (disabled !== undefined && typeof disabled !== "boolean") {
        throw new BridgeError("malformedPayload", "antigravity disabled must be boolean");
      }
      if (disabled === true) continue;
      const id = summaryString(bucket, "bucketId");
      const label = summaryString(bucket, "displayName");
      const window = summaryString(bucket, "window");
      const reset = parseIsoTimestamp(summaryString(bucket, "resetTime"));
      const rawFraction = bucket["remainingFraction"];
      if (rawFraction !== undefined && (typeof rawFraction !== "number" || !Number.isFinite(rawFraction))) {
        throw new BridgeError("malformedPayload", "antigravity remainingFraction must be finite");
      }
      const fraction = clampFraction(rawFraction);
      const remaining = bucket["remainingAmount"];
      const amount = typeof remaining === "number" ? remaining :
        typeof remaining === "string" && remaining.trim() !== "" ? Number(remaining) : undefined;
      if (remaining !== undefined && (amount === undefined || !Number.isFinite(amount) || amount < 0)) {
        throw new BridgeError("malformedPayload", "antigravity remainingAmount must be nonnegative and finite");
      }
      // Enabled buckets without a usable amount cannot cross the closed Swift
      // utilization contract; keep valid siblings and let an all-empty summary
      // produce noData rather than resurrecting the legacy catalog.
      if (fraction === undefined && amount === undefined) continue;
      const usedFraction = fraction === undefined ? undefined : 1 - fraction;
      windows.push({
        id: `${PROVIDER_ID}:summary:${groupIndex}:${id ?? window ?? bucketIndex}:${bucketIndex}`,
        label: [group.label ?? label ?? "Usage", window].filter(value => value !== undefined).join(" - "),
        unit: fraction === undefined ? "unknown" : "percent",
        severity: severityForFraction(usedFraction),
        ...(fraction !== undefined && usedFraction !== undefined ? {
          remainingFraction: fraction, remaining: fraction * 100, used: usedFraction * 100,
          limit: 100, resolvedFraction: usedFraction,
        } : amount !== undefined ? { remaining: amount } : {}),
        ...(reset !== undefined ? { resetsAtMs: reset } : {}),
      });
    }
  }
  return windows.sort((a, b) => (a.remainingFraction ?? 1) - (b.remainingFraction ?? 1));
}

function summaryArray(value: unknown): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BridgeError("malformedPayload", "antigravity quota list must be an array");
  return value;
}

function summaryString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new BridgeError("malformedPayload", `antigravity ${key} must be a string`);
  return value.trim() || undefined;
}

async function fetchAntigravityWindows(
  access: string, projectId: string, fetcher: Fetcher, signal: AbortSignal, nowMs: number,
): Promise<UsageWindow[]> {
  let summary: unknown;
  try {
    summary = await postAntigravityQuota(RETRIEVE_USER_QUOTA_SUMMARY_PATH, access, projectId, fetcher, signal);
  } catch (error) {
    // An unavailable optional summary can fall back; auth, throttling, malformed
    // data and cancellation remain typed failures, including after rotation.
    if (!(error instanceof BridgeError) || (error.kind !== "upstreamError" && error.kind !== "transport")) throw error;
  }
  if (summary !== undefined) {
    const windows = summaryWindows(summary);
    if (windows !== undefined) return windows;
  }
  const payload = await postAntigravityQuota(FETCH_AVAILABLE_MODELS_PATH, access, projectId, fetcher, signal);
  if (!isRecord(payload) || (payload["models"] !== undefined && !isRecord(payload["models"]))) {
    throw new BridgeError("malformedPayload", "antigravity legacy quota response must contain a models object");
  }
  const modelInfos = Object.values(payload["models"] ?? {}).map(parseModelInfo)
    .filter((info): info is AntigravityModelInfo => info !== undefined);
  return buildUsageWindows(modelInfos, nowMs);
}

export async function fetchAntigravityUsage(input: {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
}): Promise<BridgeSuccessResponse> {
  const { request, fetcher, nowMs } = input;
  if (request.providerId !== PROVIDER_ID) {
    throw new BridgeError("invalidProvider", `antigravity connector received providerId "${request.providerId}"`);
  }
  const credential = request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", "antigravity usage requires a credential");
  }
  if (credential.kind !== "oauth") {
    // OMP needs the OAuth credential's projectId; without it the fetch
    // short-circuits to a null report.
    throw new BridgeError("noData", "antigravity usage requires an OAuth credential with a project id");
  }

  const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
  let refreshed: OAuthCredential | undefined;
  try {
    const oauth = credential.oauth;
    const canRotate = oauth.refresh !== undefined && oauth.refreshEndpoint !== undefined && oauth.clientId !== undefined;
    const expiresSoon =
      oauth.expiresAtMs === undefined || oauth.expiresAtMs - nowMs <= ROTATION_WINDOW_MS;

    let current: OAuthCredential = credential;
    if (expiresSoon && canRotate) {
      current = await refreshAntigravityCredential(credential, fetcher, signal);
      refreshed = current;
    } else if (oauth.expiresAtMs !== undefined && oauth.expiresAtMs <= nowMs && !canRotate) {
      // OMP resolveAccessToken: never POST an expired token without a refresh
      // path — the fetch short-circuits to a null report instead.
      throw new BridgeError("noData", "antigravity access token is expired and no refresh token is available");
    }

    const projectId = oauth.identity?.["projectId"];
    if (projectId === undefined || projectId === "") {
      throw new BridgeError("noData", "antigravity usage requires a project id on the credential");
    }

    let windows: UsageWindow[];
    try {
      windows = await fetchAntigravityWindows(current.oauth.access, projectId, fetcher, signal, nowMs);
    } catch (error) {
      if (error instanceof BridgeError && error.kind === "authRequired" && refreshed === undefined && canRotate) {
        current = await refreshAntigravityCredential(credential, fetcher, signal);
        refreshed = current;
        windows = await fetchAntigravityWindows(current.oauth.access, projectId, fetcher, signal, nowMs);
      } else {
        throw error;
      }
    }

    if (windows.length === 0) {
      throw new BridgeError("noData", "antigravity usage response contained no usable quota counters");
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

export const googleAntigravityConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchAntigravityUsage,
};

// ---------------------------------------------------------------------------
// Auth module (OMP google-antigravity.ts + google-oauth-shared.ts)
// ---------------------------------------------------------------------------

interface LoadCodeAssistPayload {
  readonly projectId?: string;
  readonly hasCurrentTier: boolean;
  readonly hasPaidTier: boolean;
  readonly freeTierAllowed: boolean;
  readonly ineligibility?: string;
}

function parseLoadCodeAssistPayload(payload: unknown): LoadCodeAssistPayload {
  if (!isRecord(payload)) throw new BridgeError("malformedPayload", "antigravity loadCodeAssist must be an object");
  for (const key of ["currentTier", "paidTier"]) {
    const tier = payload[key];
    if (tier !== undefined && tier !== null) {
      if (!isRecord(tier)) throw new BridgeError("malformedPayload", "antigravity tier must be an object");
      summaryString(tier, "id");
    }
  }
  const project = payload["cloudaicompanionProject"];
  // Preserve the older object-id response supported by existing credentials.
  const projectId = isRecord(project) ? summaryString(project, "id") : summaryString(payload, "cloudaicompanionProject");
  const allowed = summaryArray(payload["allowedTiers"]).map(tier => {
    if (!isRecord(tier)) throw new BridgeError("malformedPayload", "antigravity allowed tier must be an object");
    return summaryString(tier, "id");
  });
  let ineligibility: string | undefined;
  for (const tier of summaryArray(payload["ineligibleTiers"])) {
    if (!isRecord(tier)) throw new BridgeError("malformedPayload", "antigravity ineligible tier must be an object");
    const tierId = summaryString(tier, "tierId");
    const reason = summaryString(tier, "reasonMessage");
    const validationUrl = summaryString(tier, "validationUrl");
    if (tierId === TIER_FREE && reason !== undefined) {
      ineligibility = [reason, validationUrl].filter(value => value !== undefined).join("\n");
    }
  }
  return {
    ...(projectId !== undefined ? { projectId } : {}),
    hasCurrentTier: payload["currentTier"] !== undefined && payload["currentTier"] !== null,
    hasPaidTier: payload["paidTier"] !== undefined && payload["paidTier"] !== null,
    freeTierAllowed: allowed.includes(TIER_FREE),
    ...(ineligibility !== undefined ? { ineligibility } : {}),
  };
}

export type AntigravityLoginDeps = {
  readonly fetcher: Fetcher;
  readonly openBrowser?: BrowserOpener;
  /** Injectable clock and abortable wait for the single 30s onboarding budget. */
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly timeoutSignal?: (ms: number) => AbortSignal;
};

const defaultAntigravitySleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal === undefined) return Bun.sleep(ms);
  if (signal.aborted) return Promise.reject(new BridgeError("timeout", "Antigravity login was cancelled"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new BridgeError("timeout", "Antigravity login was cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

type ControlPlaneRequest = (path: string, method: "POST" | "GET", body?: unknown, timeoutMs?: number) => Promise<unknown>;

async function onboardAntigravityProject(
  request: ControlPlaneRequest, signal: AbortSignal, deps: AntigravityLoginDeps,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const deadline = now() + PROJECT_ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    throwIfAntigravityCancelled(signal);
    const ms = deadline - now();
    if (ms <= 0) throw new BridgeError("timeout", "Antigravity onboarding timed out after 30000ms");
    return ms;
  };
  let operation = await request(":onboardUser", "POST", {
    tierId: TIER_FREE, metadata: { ideType: "ANTIGRAVITY" },
  }, remaining());
  while (true) {
    remaining();
    if (!isRecord(operation) || (operation["done"] !== undefined && typeof operation["done"] !== "boolean")) {
      throw new BridgeError("malformedPayload", "antigravity onboarding operation is malformed");
    }
    const name = summaryString(operation, "name");
    const error = operation["error"];
    if (error !== undefined && error !== null) {
      if (!isRecord(error) || (error["code"] !== undefined &&
        (typeof error["code"] !== "number" || !Number.isFinite(error["code"])))) {
        throw new BridgeError("malformedPayload", "antigravity operation error is malformed");
      }
      summaryString(error, "message");
    }
    if (operation["done"] === true) {
      // Do not echo untrusted operation messages containing credential material.
      if (error !== undefined && error !== null) throw new BridgeError("upstreamError", "Antigravity onboarding operation failed");
      const response = operation["response"];
      if (!isRecord(response) || summaryString(response, "@type") === undefined) {
        throw new BridgeError("malformedPayload", "antigravity onboarding response is malformed");
      }
      summaryString(response, "cloudaicompanionProject");
      return;
    }
    if (name === undefined || !/^operations\/[^?#\s]+$/.test(name) || name.split("/").includes("..")) {
      throw new BridgeError("malformedPayload", "antigravity pending operation has no valid name");
    }
    await (deps.sleep ?? defaultAntigravitySleep)(Math.min(PROJECT_ONBOARD_INTERVAL_MS, remaining()), signal);
    operation = await request("/" + name, "GET", undefined, remaining());
  }
}

async function discoverAntigravityProject(
  accessToken: string, signal: AbortSignal, events: AuthEvents, deps: AntigravityLoginDeps,
): Promise<string> {
  const request: ControlPlaneRequest = async (path, method, body, timeoutMs = OAUTH_REQUEST_TIMEOUT_MS) => {
    throwIfAntigravityCancelled(signal);
    const response = await callProviderHttp({
      call: {
        url: DAILY_CLOUD_CODE_ENDPOINT + "/v1internal" + path, method,
        headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json", "User-Agent": getAntigravityUserAgent() },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      fetcher: deps.fetcher,
      signal: AbortSignal.any([signal, (deps.timeoutSignal ?? AbortSignal.timeout)(timeoutMs)]),
      endpointLabel: "antigravity control-plane endpoint", extraSecrets: [accessToken],
    });
    if (response.status !== 200) throw new BridgeError("upstreamError", "Antigravity control plane requires HTTP 200");
    return await response.json();
  };
  const load = async (): Promise<LoadCodeAssistPayload> => {
    const initial = parseLoadCodeAssistPayload(await request(":loadCodeAssist", "POST", { metadata: { ideType: "ANTIGRAVITY" } }));
    if (!initial.hasPaidTier && initial.projectId !== undefined) {
      return parseLoadCodeAssistPayload(await request(":loadCodeAssist", "POST", {
        cloudaicompanionProject: initial.projectId, metadata: { ideType: "ANTIGRAVITY" },
      }));
    }
    return initial;
  };
  events.onEvent({ type: "waiting", detail: "Checking Cloud Code Assist account status..." });
  const initial = await load();
  if (!initial.freeTierAllowed && initial.ineligibility !== undefined) {
    throw new BridgeError("permissionDenied", redactSecrets(initial.ineligibility, [accessToken]));
  }
  if (!initial.hasCurrentTier) {
    events.onEvent({ type: "waiting", detail: "Provisioning the Antigravity free tier..." });
    await onboardAntigravityProject(request, signal, deps);
  }
  events.onEvent({ type: "waiting", detail: "Refreshing Cloud Code Assist project..." });
  const refreshed = await load();
  if (refreshed.projectId === undefined) throw new BridgeError("upstreamError", "Antigravity project discovery returned no project");
  return refreshed.projectId;
}

type AntigravityTokens = {
  readonly access: string;
  readonly refresh: string;
  readonly expiresIn: number;
};

async function exchangeAntigravityToken(
  code: string,
  redirectUri: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<AntigravityTokens> {
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
    signal: antigravityRequestSignal(signal),
    endpointLabel: "antigravity token endpoint",
    extraSecrets: [code],
  });

  const data = await response.json();
  if (!isRecord(data)) {
    throw new BridgeError("malformedPayload", "antigravity token response was not a JSON object");
  }
  const access = typeof data["access_token"] === "string" ? data["access_token"] : "";
  if (access === "") {
    throw new BridgeError("malformedPayload", "antigravity token response missing access_token");
  }
  const refresh = typeof data["refresh_token"] === "string" ? data["refresh_token"] : "";
  if (refresh === "") {
    // OMP message, verbatim.
    throw new BridgeError("authRequired", "No refresh token received. Please try again.");
  }
  const expiresIn = data["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    throw new BridgeError("malformedPayload", "antigravity token response missing expires_in");
  }
  return { access, refresh, expiresIn };
}

async function getAntigravityUserEmail(
  accessToken: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await callProviderHttp({
      call: {
        url: USERINFO_URL,
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      fetcher,
      signal: antigravityRequestSignal(signal),
      endpointLabel: "antigravity userinfo endpoint",
      extraSecrets: [accessToken],
    });
    const data = await response.json();
    const email = isRecord(data) && typeof data["email"] === "string" ? data["email"] : undefined;
    return email !== undefined && email.length > 0 ? email : undefined;
  } catch {
    // OMP: the email is optional and every lookup failure is ignored.
    return undefined;
  }
}

async function waitForAntigravityCallback(
  handle: LoopbackCallbackHandle,
  state: string,
  events: AuthEvents,
  signal: AbortSignal,
): Promise<string> {
  try {
    // OMP races the loopback callback against the manual paste channel
    // (onManualCodeInput); the bridge routes the paste through the duplex
    // requestInput channel — never a tty.
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
          ? "Antigravity login cancelled while waiting for the browser callback"
          : "Antigravity login timed out waiting for the browser callback",
      );
    }
    if (error instanceof CallbackFailedError) {
      throw new BridgeError("invalidRequest", error.message);
    }
    throw error;
  }
}

async function loginAntigravityBrowser(
  events: AuthEvents,
  signal: AbortSignal,
  deps: AntigravityLoginDeps,
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
    throw new BridgeError("transport", `unable to start the local Antigravity OAuth callback server: ${message}`);
  }
  // The 300s loopback deadline can reject this promise on paths that never
  // await it; keep that rejection observed.
  void handle.wait.catch(() => undefined);

  try {
    // OMP GoogleOAuthFlow.generateAuthUrl parameter set, no PKCE.
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

    const code = await waitForAntigravityCallback(handle, state, events, signal);
    throwIfAntigravityCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Exchanging authorization code for tokens..." });

    const tokens = await exchangeAntigravityToken(code, handle.redirectUri, deps.fetcher, signal);
    throwIfAntigravityCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Getting user info..." });
    const email = await getAntigravityUserEmail(tokens.access, deps.fetcher, signal);
    throwIfAntigravityCancelled(signal);
    const projectId = await discoverAntigravityProject(tokens.access, signal, events, deps);

    // OMP expiry: now + expires_in - 5 minutes.
    const expiresAtMs = Date.now() + tokens.expiresIn * 1000 - EXPIRY_SKEW_MS;
    const credential: OAuthCredential = {
      kind: "oauth",
      secret: tokens.access,
      oauth: {
        access: tokens.access,
        refresh: tokens.refresh,
        expiresAtMs,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: {
          projectId,
          ...(email !== undefined ? { email } : {}),
        },
      },
    };
    return { credential, ...(email !== undefined ? { accountLabel: email } : {}) };
  } finally {
    handle.stop();
  }
}

function remapAntigravityLoginError(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof BridgeError) {
    if (error.kind === "timeout" && signal.aborted) {
      throw new BridgeError("timeout", "Antigravity login was cancelled");
    }
    throw error;
  }
  if (isAbortError(error)) {
    throw new BridgeError("timeout", "Antigravity login was cancelled");
  }
  throw error;
}

/** Dispatch an Antigravity login by method (tests inject deps; production uses fetch). */
export async function loginAntigravity(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: AntigravityLoginDeps,
): Promise<LoginResult> {
  if (method !== "browser") {
    throw new BridgeError("invalidRequest", `provider "google-antigravity" does not offer login method "${method}"`);
  }
  if (signal.aborted) {
    throw new BridgeError("timeout", "Antigravity login was cancelled");
  }
  try {
    return await loginAntigravityBrowser(events, signal, deps);
  } catch (error) {
    throw remapAntigravityLoginError(error, signal);
  }
}

const platformAntigravityFetch: Fetcher = (url, init) => fetch(url, init);

export const googleAntigravityAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["browser"],
  login: (method, inputs, events, signal) =>
    loginAntigravity(method, inputs, events, signal, { fetcher: platformAntigravityFetch }),
  refresh: (credential, signal) => refreshAntigravityCredential(credential, platformAntigravityFetch, signal),
};
