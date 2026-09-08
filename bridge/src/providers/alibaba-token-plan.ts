/**
 * Alibaba QwenCloud Token Plan provider: apiKey auth module plus a
 * browser-session usage connector, hand-ported from the pinned oh-my-pi
 * checkout (SHA 8500092296621a6826b7136e840f8a59ea338958). No OMP code is
 * imported or executed here; endpoints, headers, request bodies and
 * normalization boundaries mirror:
 *
 *   packages/ai/src/usage/alibaba-token-plan.ts
 *     Console session lookup (QwenCloud user/info.json secToken / China
 *     console page SEC_TOKEN), CSRF cookie derivation, the gateway POST to
 *     zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage, the gateway data
 *     unwrap, percent normalization and the 5h/7d window mapping.
 *   packages/ai/src/registry/alibaba-token-plan.ts
 *     The apiKey login flow: region selection, the subscribe/auth URL, key
 *     validation, the browser Cookie header paste step and credential
 *     serialization. OMP's onPrompt steps map onto the bridge's structured
 *     LoginInputs first and the duplex requestInput channel second (region
 *     menu, key paste, cookie paste).
 *   packages/ai/src/registry/api-key-validation.ts
 *     validateApiKeyAgainstModelsEndpoint (GET {baseUrl}/models, Bearer).
 *   packages/catalog/src/wire/alibaba-token-plan.ts
 *     The credential parse/serialize contract ({token, cookie?, baseUrl?}).
 *
 * OMP returns null on every soft failure; the bridge must fail typed
 * instead, so an unusable session or gateway payload and a payload with no
 * utilization windows map to noData. Severity follows the shared wire bands
 * (warning >=0.8, critical >=0.95), not OMP's provider-local ladder. Deviations from OMP are marked inline with "PORT NOTE".
 */

import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type { BridgeRequest, BridgeSuccessResponse, UsageReport, UsageWindow } from "../protocol";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";

const PROVIDER_ID = "alibaba-token-plan";
const CONNECTOR_VERSION = "alibaba-token-plan-1";

// --- Credential wire contract (catalog/src/wire/alibaba-token-plan.ts) ---

const TOKEN_PATTERN = /^sk-[A-Za-z0-9._~+/-]+={0,2}$/;

type AlibabaTokenPlanSecret = {
  readonly token: string;
  readonly cookie?: string;
  readonly baseUrl?: string;
};

/** Ported parseAlibabaTokenPlanCredential: bare sk- token or serialized JSON. */
function parseAlibabaTokenPlanCredential(value: string): AlibabaTokenPlanSecret | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) return TOKEN_PATTERN.test(trimmed) ? { token: trimmed } : null;
  let parsed: { token?: unknown; cookie?: unknown; baseUrl?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { token?: unknown; cookie?: unknown; baseUrl?: unknown };
  } catch {
    return null;
  }
  if (typeof parsed.token !== "string" || !TOKEN_PATTERN.test(parsed.token.trim())) return null;
  if (parsed.cookie !== undefined && typeof parsed.cookie !== "string") return null;
  if (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string") return null;
  const token = parsed.token.trim();
  const cookie = parsed.cookie?.trim();
  const baseUrl = parsed.baseUrl?.trim();
  if (baseUrl && !isHttpsBaseUrl(baseUrl)) return null;
  const credential: { token: string; cookie?: string; baseUrl?: string } = { token };
  if (cookie) credential.cookie = cookie;
  if (baseUrl) credential.baseUrl = baseUrl;
  return credential;
}

/** Ported serializeAlibabaTokenPlanCredential: bare token unless extra fields exist. */
function serializeAlibabaTokenPlanCredential(token: string, cookie: string, baseUrl?: string): string {
  const trimmedCookie = cookie.trim();
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedCookie && !trimmedBaseUrl) return token;
  const payload: { token: string; cookie?: string; baseUrl?: string } = { token };
  if (trimmedCookie) payload.cookie = trimmedCookie;
  if (trimmedBaseUrl) payload.baseUrl = trimmedBaseUrl;
  return JSON.stringify(payload);
}

// --- Shared numeric normalizers (usage/shared.ts, catalog utils.ts) ---

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/** Ported parsePositiveTimestamp: seconds or milliseconds epoch, positive only. */
function parsePositiveTimestamp(value: unknown): number | undefined {
  const parsed = toNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

// --- Console configs (usage/alibaba-token-plan.ts) ---

const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const ALIBABA_TOKEN_PLAN_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const ALIBABA_TOKEN_PLAN_CN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const INTERNATIONAL_AUTH_URL = "https://home.qwencloud.com/billing/subscription/token-plan-individual";
const CHINA_AUTH_URL = "https://www.aliyun.com/benefit/scene/tokenplan";
const JSON_ACCEPT = "application/json, text/plain, */*";

const INTERNATIONAL_CONSOLE = {
  origin: "https://home.qwencloud.com",
  dashboardUrl: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
  sessionUrl: "https://home.qwencloud.com/tool/user/info.json",
  gatewayAction: "IntlBroadScopeAspnGateway",
  region: "ap-southeast-1",
  usageUrl: `https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=${encodeURIComponent(USAGE_API)}`,
  cornerstoneParam: {
    domain: "home.qwencloud.com",
    consoleSite: "QWENCLOUD",
    console: "ONE_CONSOLE",
    xsp_lang: "en-US",
    protocol: "V2",
    productCode: "p_efm",
  },
} as const;

const CHINA_CONSOLE = {
  origin: "https://bailian.console.aliyun.com",
  dashboardUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
  sessionUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan",
  gatewayAction: "BroadScopeAspnGateway",
  region: "cn-beijing",
  usageUrl: `https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(USAGE_API)}`,
  cornerstoneParam: {
    feURL: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
    protocol: "V2",
    console: "ONE_CONSOLE",
    productCode: "p_efm",
    switchAgent: 12608464,
    switchUserType: 3,
    domain: "bailian.console.aliyun.com",
    consoleSite: "BAILIAN_ALIYUN",
    userNickName: "",
    userPrincipalName: "",
    xsp_lang: "zh-CN",
  },
} as const;

type ConsoleConfig = typeof INTERNATIONAL_CONSOLE | typeof CHINA_CONSOLE;

// --- Gateway payload normalization (usage/alibaba-token-plan.ts) ---

function extractCookieValue(header: string, name: string): string | undefined {
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    const value = segment.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function unwrapGatewayData(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  let current = value;
  const data = current["Data"];
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) current = parsed;
    } catch {
      // OMP keeps the envelope as-is when the inner Data string is not JSON.
    }
  }
  const dataV2 = current["DataV2"];
  if (isRecord(dataV2) && isRecord(dataV2["data"])) current = dataV2["data"];
  const nested = current["data"];
  if (isRecord(nested)) current = nested;
  return current;
}

/** Ported parseUsedFraction: percent (or already-fractional) value, clamped to [0, 1]. */
function parseUsedFraction(value: unknown): number | undefined {
  const parsed = toNumber(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return Math.min(1, parsed > 1 ? parsed / 100 : parsed);
}

function buildWindow(
  id: string,
  label: string,
  usedFraction: number | undefined,
  resetsAtMs: number | undefined,
): UsageWindow | undefined {
  if (usedFraction === undefined) return undefined;
  return {
    id,
    label,
    unit: "percent",
    resolvedFraction: usedFraction,
    used: usedFraction * 100,
    severity: severityForFraction(usedFraction),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
  };
}

// --- Usage connector ---

export const alibabaTokenPlanConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchAlibabaTokenPlanUsage,
};

export async function fetchAlibabaTokenPlanUsage(input: {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
}): Promise<BridgeSuccessResponse> {
  const { request, fetcher, nowMs } = input;
  if (request.providerId !== PROVIDER_ID) {
    throw new BridgeError("invalidProvider", `connector "${CONNECTOR_VERSION}" only serves providerId "${PROVIDER_ID}"`);
  }
  const credential = request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", `${PROVIDER_ID} usage requires a credential`);
  }
  if (credential.kind !== "apiKey") {
    throw new BridgeError("invalidPolicy", `${PROVIDER_ID} usage requires an apiKey credential`);
  }
  const parsed = parseAlibabaTokenPlanCredential(credential.secret);
  if (parsed === null) {
    throw new BridgeError("invalidPolicy", `${PROVIDER_ID} credential secret is not a token-plan credential`);
  }
  const cookie = parsed.cookie;
  if (cookie === undefined) {
    throw new BridgeError("invalidPolicy", "alibaba-token-plan usage requires the browser cookie credential");
  }

  const isChina = parsed.baseUrl === ALIBABA_TOKEN_PLAN_CN_BASE_URL;
  const consoleConfig: ConsoleConfig = isChina ? CHINA_CONSOLE : INTERNATIONAL_CONSOLE;
  const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));

  // The China session endpoint answers with the console HTML page, whose raw
  // text callProviderHttp does not expose; the fetcher below tees the body so
  // the SEC_TOKEN regex can run while the call still goes through
  // callProviderHttp. Keep OMP's manual redirects on both cookie-bearing calls.
  let sessionText: string | undefined;
  const sessionFetcher: Fetcher = async (url, init) => {
    const response = await fetcher(url, init);
    const text = await response.text();
    sessionText = text;
    return text === "" ? new Response(null, { status: response.status }) : new Response(text, { status: response.status, headers: response.headers });
  };

  const session = await callProviderHttp({
    call: {
      url: consoleConfig.sessionUrl,
      redirect: "manual",
      headers: {
        Accept: isChina ? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" : JSON_ACCEPT,
        Cookie: cookie,
        Referer: `${consoleConfig.origin}/`,
        "User-Agent": BROWSER_USER_AGENT,
      },
    },
    fetcher: sessionFetcher,
    signal,
    endpointLabel: "token-plan console session",
    extraSecrets: [cookie],
  });

  const secToken = isChina ? secTokenFromChinaPage(sessionText) : await secTokenFromQwenCloudSession(session);

  const csrf = extractCookieValue(cookie, "login_aliyunid_csrf") ?? extractCookieValue(cookie, "csrf");
  const gatewayHeaders: Record<string, string> = {
    Accept: JSON_ACCEPT,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookie,
    Origin: consoleConfig.origin,
    Referer: consoleConfig.dashboardUrl,
    "User-Agent": BROWSER_USER_AGENT,
    "X-Requested-With": "XMLHttpRequest",
  };
  if (csrf !== undefined) {
    gatewayHeaders["x-xsrf-token"] = csrf;
    gatewayHeaders["x-csrf-token"] = csrf;
  }
  const body = new URLSearchParams({
    product: "sfm_bailian",
    action: consoleConfig.gatewayAction,
    region: consoleConfig.region,
    sec_token: secToken,
    params: JSON.stringify({
      Api: USAGE_API,
      Data: {
        cornerstoneParam: {
          ...(isChina ? { feTraceId: crypto.randomUUID() } : {}),
          ...consoleConfig.cornerstoneParam,
        },
      },
      V: "1.0",
    }),
  }).toString();

  const usage = await callProviderHttp({
    call: { url: consoleConfig.usageUrl, method: "POST", headers: gatewayHeaders, body, redirect: "manual" },
    fetcher,
    signal,
    endpointLabel: "token-plan usage gateway",
    extraSecrets: [cookie],
  });

  const payload = await usage.json();
  if (!isRecord(payload) || payload["successResponse"] === false || !isRecord(payload["data"])) {
    throw new BridgeError("noData", "token-plan usage gateway returned an unusable payload");
  }
  const responseData = unwrapGatewayData(payload["data"]);
  // PORT NOTE: OMP also extracts an accountId for its limit scope/metadata;
  // the bridge UsageWindow has no such field, so it is dropped here.
  const windows = [
    buildWindow(
      "credits:5h",
      "5 Hour Credits",
      parseUsedFraction(responseData["per5HourPercentage"]),
      parsePositiveTimestamp(responseData["per5HourResetTime"]),
    ),
    buildWindow(
      "credits:7d",
      "7 Day Credits",
      parseUsedFraction(responseData["per1WeekPercentage"]),
      parsePositiveTimestamp(responseData["per1WeekResetTime"]),
    ),
  ].filter((window): window is UsageWindow => window !== undefined);
  if (windows.length === 0) {
    throw new BridgeError("noData", "token-plan usage payload carried no utilization windows");
  }

  const report: UsageReport = {
    productKind: "quota",
    sourceKind: "browserSession",
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
  };
}

function secTokenFromChinaPage(pageText: string | undefined): string {
  const secToken = /\bSEC_TOKEN\s*:\s*"([^"]+)"/.exec(pageText ?? "")?.[1];
  if (secToken === undefined) {
    throw new BridgeError("noData", "China console session page carried no SEC_TOKEN");
  }
  return secToken;
}

async function secTokenFromQwenCloudSession(
  session: { readonly json: () => Promise<unknown> },
): Promise<string> {
  const userPayload = await session.json();
  if (!isRecord(userPayload) || !isRecord(userPayload["data"])) {
    throw new BridgeError("noData", "QwenCloud session response carried no secToken");
  }
  const secToken = userPayload["data"]["secToken"];
  if (typeof secToken !== "string" || secToken === "") {
    throw new BridgeError("noData", "QwenCloud session response carried no secToken");
  }
  return secToken;
}

// --- Auth module (registry/alibaba-token-plan.ts, apiKey flow) ---

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_FETCHER: Fetcher = (url, init) => fetch(url, init);

// OMP onPrompt messages, verbatim; the duplex requestInput channel is the
// bridge's stand-in for OMP's interactive prompts.
const REGION_PROMPT =
  "Select QwenCloud Token Plan region: 1=International (default), 2=China (Beijing), 3=Custom — enter 1, 2, or 3";
const CUSTOM_URL_PROMPT = "Enter custom Token Plan base URL";
const API_KEY_PROMPT = "Paste your QwenCloud Token Plan API key";
const INTL_COOKIE_PROMPT =
  "Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the cs-data.qwencloud.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.";
const CHINA_COOKIE_PROMPT =
  "Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the bailian-cs.console.aliyun.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.";

export const alibabaTokenPlanAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  login: loginAlibabaTokenPlan,
};

export async function loginAlibabaTokenPlan(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
): Promise<LoginResult> {
  if (method !== "apiKey") {
    throw new BridgeError("invalidRequest", `${PROVIDER_ID} login only supports the apiKey method`);
  }
  try {
    return await runLogin(inputs, events, signal);
  } catch (error) {
    if (error instanceof BridgeError) {
      throw error;
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new BridgeError("timeout", `${PROVIDER_ID} login was cancelled before completing`);
    }
    throw error;
  }
}

async function runLogin(inputs: LoginInputs, events: AuthEvents, signal: AbortSignal): Promise<LoginResult> {
  throwIfLoginAborted(signal);

  // OMP prompts for the region (1=International default, 2=China, 3=Custom);
  // the bridge first honors a structured apiBaseUrl input, then falls back to
  // the duplex prompt, then to the international default (OMP's !onPrompt
  // callers cannot exist here because the region is optional).
  const baseUrl = await resolveBaseUrl(inputs, events, signal);
  const isChina = baseUrl === ALIBABA_TOKEN_PLAN_CN_BASE_URL;
  events.onEvent({ type: "openUrl", url: isChina ? CHINA_AUTH_URL : INTERNATIONAL_AUTH_URL });

  const apiKey = await resolveApiKey(inputs, events, signal);
  if (apiKey === "") {
    throw new BridgeError("invalidRequest", "QwenCloud Token Plan login requires an API key");
  }

  events.onEvent({ type: "waiting", detail: "Validating API key..." });
  await validateApiKeyAgainstModelsEndpoint(apiKey, baseUrl, signal);

  const cookiePrompt = isChina ? CHINA_COOKIE_PROMPT : INTL_COOKIE_PROMPT;
  events.onEvent({ type: "pasteHint", detail: cookiePrompt });
  const rawCookie = await resolveCookieHeader(inputs, events, signal, cookiePrompt);
  const cookie = rawCookie.trim().replace(/^Cookie:\s*/i, "").trim();
  const cookieRequestHost = isChina ? "bailian-cs.console.aliyun.com" : "cs-data.qwencloud.com";
  if (
    cookie &&
    !cookie.split(";").some((segment) => {
      const separator = segment.indexOf("=");
      return separator > 0 && Boolean(segment.slice(0, separator).trim() && segment.slice(separator + 1).trim());
    })
  ) {
    throw new BridgeError(
      "invalidRequest",
      `Invalid QwenCloud Cookie header. Copy the complete Cookie request header from the ${cookieRequestHost} usage request, not a single cookie value.`,
    );
  }
  throwIfLoginAborted(signal);

  // Only a region diverging from the default international endpoint is
  // persisted, exactly like OMP's regionUrl.
  const regionUrl = baseUrl === ALIBABA_TOKEN_PLAN_BASE_URL ? undefined : baseUrl;
  return {
    credential: {
      kind: "apiKey",
      secret: serializeAlibabaTokenPlanCredential(apiKey, cookie, regionUrl),
    },
  };
}

/**
 * Resolves the region endpoint: structured apiBaseUrl input first, then OMP's
 * duplex region menu (1 default / 2 China / 3 custom URL follow-up). PORT NOTE:
 * a pasted HTTPS URL is accepted as the custom region directly; every other
 * unrecognized answer falls back to International exactly like OMP's else
 * branch.
 */
async function resolveBaseUrl(inputs: LoginInputs, events: AuthEvents, signal: AbortSignal): Promise<string> {
  const structured = normalizeBaseUrl(inputs.apiBaseUrl);
  if (structured !== undefined) {
    return structured;
  }
  if (events.requestInput === undefined) {
    return ALIBABA_TOKEN_PLAN_BASE_URL;
  }
  const choice = (
    await events.requestInput({ prompt: REGION_PROMPT, inputKind: "apiBaseUrl", sensitive: false }, signal)
  ).trim();
  throwIfLoginAborted(signal);
  if (choice === "2") {
    return ALIBABA_TOKEN_PLAN_CN_BASE_URL;
  }
  if (choice === "3") {
    const customUrl = (
      await events.requestInput({ prompt: CUSTOM_URL_PROMPT, inputKind: "apiBaseUrl", sensitive: false }, signal)
    )
      .trim()
      .replace(/\/+$/, "");
    throwIfLoginAborted(signal);
    if (customUrl === "") {
      throw new BridgeError("invalidRequest", "Custom URL is required for option 3");
    }
    return normalizeBaseUrl(customUrl) ?? ALIBABA_TOKEN_PLAN_BASE_URL;
  }
  if (/^https?:\/\//i.test(choice)) {
    return normalizeBaseUrl(choice) ?? ALIBABA_TOKEN_PLAN_BASE_URL;
  }
  return ALIBABA_TOKEN_PLAN_BASE_URL;
}

/** Structured apiKey input first; a missing/blank key falls back to the duplex paste prompt. */
async function resolveApiKey(inputs: LoginInputs, events: AuthEvents, signal: AbortSignal): Promise<string> {
  const structured = inputs.apiKey?.trim() ?? "";
  if (structured !== "" || events.requestInput === undefined) {
    return structured;
  }
  const pasted = (await events.requestInput({ prompt: API_KEY_PROMPT, inputKind: "text", sensitive: true }, signal)).trim();
  throwIfLoginAborted(signal);
  return pasted;
}

/**
 * Structured cookieHeader first (an explicitly blank string is a deliberate
 * skip, like OMP's allowEmpty answer); a missing input falls back to the
 * duplex cookie prompt where one is available.
 */
async function resolveCookieHeader(
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  cookiePrompt: string,
): Promise<string> {
  if (inputs.cookieHeader !== undefined || events.requestInput === undefined) {
    return inputs.cookieHeader ?? "";
  }
  const pasted = await events.requestInput({ prompt: cookiePrompt, inputKind: "cookieHeader", sensitive: true }, signal);
  throwIfLoginAborted(signal);
  return pasted;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (trimmed === undefined || trimmed === "") return undefined;
  if (!isHttpsBaseUrl(trimmed)) {
    throw new BridgeError("invalidRequest", "Alibaba Token Plan base URL must use HTTPS");
  }
  return trimmed;
}

function isHttpsBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Ported validateApiKeyAgainstModelsEndpoint: GET {baseUrl}/models with Bearer. */
async function validateApiKeyAgainstModelsEndpoint(apiKey: string, baseUrl: string, signal: AbortSignal): Promise<void> {
  await callProviderHttp({
    call: {
      url: `${baseUrl}/models`,
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    fetcher: VALIDATION_FETCHER,
    signal: AbortSignal.any([signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)]),
    endpointLabel: "QwenCloud Token Plan key validation",
    extraSecrets: [apiKey],
  });
}

function throwIfLoginAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("timeout", `${PROVIDER_ID} login was cancelled before completing`);
  }
}
