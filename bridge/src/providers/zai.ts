/**
 * Z.AI (GLM Coding Plan) provider: usage connector + auth module, hand-ported
 * from the pinned oh-my-pi checkout @ 8500092296621a6826b7136e840f8a59ea338958:
 *
 * - packages/ai/src/usage/zai.ts            (quota fetch + normalization)
 * - packages/ai/src/registry/zai.ts         (apiKey paste login config)
 * - packages/ai/src/registry/oauth/zai.ts   (ZCode-like browser mint flow)
 *
 * Kept from the OMP sources (same endpoints, client ids, request bodies and
 * normalization boundaries):
 * - Usage: GET https://api.z.ai/api/monitor/usage/quota/limit with the raw
 *   key as the Authorization value verbatim — no "Bearer" prefix (OMP sends
 *   the bare key for both the paste and the browser-minted id.secret key).
 * - Normalization: TOKENS_LIMIT -> "tokens" windows, TIME_LIMIT -> "requests"
 *   windows (feature rows whose usageDetails carry search-prime + web-reader
 *   + zread become separate "zread" rows), unit enums 3/4/5/6 -> `${n}h` /
 *   `${n}d` / `${n}mo` / `1w` windows, anything else -> opaque `${n}u${unit}`
 *   ids; fraction from `percentage` (clamped /100) else currentValue/usage;
 *   nextResetTime epoch coercion (seconds -> ms); OMP zai severity bands
 *   (>=1 exhausted, >=0.9 warning, else ok).
 * - Browser login: authorization-code flow against chat.z.ai with client id
 *   client_P8X5CMWmlaRO9gyO-KSqtg and NO PKCE (ZCode parity), non-standard
 *   token body {provider, code, redirect_uri, state} to zcode.z.ai, then the
 *   business-API key mint: POST /api/auth/z/login, GET /api/biz/customer/
 *   getCustomerInfo (default org/project), GET/POST .../api_keys (name
 *   "oh-my-pi"), GET .../api_keys/copy/{apiKey} -> `${apiKey}.${secretKey}`.
 *   OMP's manual paste race rides the duplex requestInput channel (see
 *   ../auth/refresh.ts waitForCallbackOrManualPaste) — never a tty.
 * - apiKey login: exact OMP validation request — POST
 *   https://api.z.ai/api/coding/paas/v4/chat/completions, model glm-5.2,
 *   messages [{role:"user",content:"ping"}], max_tokens 1, temperature 0.
 *
 * Deviations from the OMP sources (with reasons):
 * - OMP's secondary GET /api/monitor/usage/model-usage metadata fetch is not
 *   ported: the bridge UsageReport has no metadata/raw surface and model
 *   fields are forbidden on bridge reports.
 * - OMP window `durationMs` is dropped (no bridge field); the window id
 *   already encodes the duration.
 * - OMP's null-report outcomes (HTTP failure, success !== true, no usable
 *   rows) become typed BridgeErrors: HTTP status mapping via callProviderHttp
 *   (401 -> authRequired, 429 -> rateLimited, ...), envelope failures and
 *   empty row sets -> noData.
 * - OMP stores the minted key in OAuthCredentials.access with expires
 *   NEVER_EXPIRES and refresh ""; this module returns { kind: "apiKey",
 *   secret: "<id>.<secret>" } (bridge spec) and offers no refresh()/token
 *   rotation — the key is durable and OMP has no refresh path for it.
 * - OMP's interactive onPrompt paste becomes inputs.apiKey (the bridge wire
 *   carries the pasted key); the dashboard URL is surfaced via a pasteHint
 *   event instead of OMP's onAuth callback. OMP's onManualCodeInput callback
 *   race is ported onto AuthEvents.requestInput (see ../auth/refresh.ts).
 * - Mint helpers keep OMP's 30s per-request timeout but combine it with the
 *   login AbortSignal (the bridge contract requires honoring it); apiKey
 *   validation keeps OMP's 15s VALIDATION_TIMEOUT_MS.
 * - normalizeZaiBaseUrl is not ported: BridgeRequest carries no base URL, so
 *   the endpoints are pinned to https://api.z.ai.
 */

import { defaultBrowserOpener, openInBrowser } from "../auth/open-browser";
import type { BrowserOpener } from "../auth/open-browser";
import { CallbackCancelledError, CallbackFailedError, generateCallbackState, startLoopbackCallback } from "../auth/loopback";
import type { LoopbackCallbackHandle } from "../auth/loopback";
import { waitForCallbackOrManualPaste } from "../auth/refresh";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord } from "../protocol";
import type { BridgeRequest, BridgeSuccessResponse, Severity, UsageReport, UsageWindow } from "../protocol";

// ---------------------------------------------------------------------------
// Usage connector (OMP packages/ai/src/usage/zai.ts)
// ---------------------------------------------------------------------------

const CONNECTOR_VERSION = "zai-1";
const QUOTA_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";
const USER_AGENT = "token-meter-bridge/1.0.0";

export type ZaiUsageInput = {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
};

export async function fetchZaiUsage(input: ZaiUsageInput): Promise<BridgeSuccessResponse> {
  if (input.request.providerId !== "zai") {
    throw new BridgeError("invalidProvider", `zai connector received providerId "${input.request.providerId}"`);
  }
  const credential = input.request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", "zai usage requires a credential");
  }
  // OMP: oauth credentials keep the raw key in accessToken, paste keys in
  // apiKey; both are sent verbatim as the Authorization value (no Bearer).
  const token = credential.kind === "oauth" ? credential.oauth.access : credential.secret;
  const signal = AbortSignal.timeout(Math.max(1, input.request.deadlineAtMs - input.nowMs));

  const response = await callProviderHttp({
    call: {
      url: QUOTA_ENDPOINT,
      method: "GET",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    fetcher: input.fetcher,
    signal,
    endpointLabel: "zai quota endpoint",
    extraSecrets: [token],
  });

  const payload = await response.json();
  if (!isRecord(payload)) {
    throw new BridgeError("malformedPayload", "zai quota endpoint returned a non-object body");
  }
  if (payload["success"] !== true) {
    const msg = typeof payload["msg"] === "string" ? `: ${payload["msg"]}` : "";
    throw new BridgeError("noData", `zai quota response did not report success${msg}`);
  }
  const data = payload["data"];
  const rawLimits = isRecord(data) && Array.isArray(data["limits"]) ? data["limits"] : [];

  const windows: UsageWindow[] = [];
  for (const rawLimit of rawLimits) {
    const parsed = parseZaiLimitItem(rawLimit);
    if (parsed === null) {
      continue;
    }
    const window = windowForZaiLimit(parsed);
    if (window !== undefined) {
      windows.push(window);
    }
  }
  if (windows.length === 0) {
    throw new BridgeError("noData", "zai quota response contained no usable quota rows");
  }

  const report: UsageReport = {
    productKind: "quota",
    sourceKind: "privateApi",
    fetchedAtMs: input.nowMs,
    connectorVersion: CONNECTOR_VERSION,
    windows,
  };
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId: input.request.requestId,
    providerId: input.request.providerId,
    connectorId: input.request.connectorId,
    accountRef: input.request.accountRef,
    status: "ok",
    completedAtMs: input.nowMs,
    report,
  };
}

export const zaiConnector: ConnectorModule = {
  providerId: "zai",
  connectorVersion: CONNECTOR_VERSION,
  fetchUsage: fetchZaiUsage,
};

/** OMP ZaiUsageLimitItem; toNumber coerces finite numbers and numeric strings. */
interface ZaiLimitItem {
  readonly type: string;
  readonly usage?: number;
  readonly currentValue?: number;
  readonly percentage?: number;
  readonly remaining?: number;
  readonly nextResetTime?: number;
  readonly unit?: number;
  readonly number?: number;
  readonly usageDetails: readonly string[];
}

function toZaiNumber(value: unknown): number | undefined {
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

/** OMP parseMillis: values above 1e12 are already epoch ms, else seconds. */
function parseZaiMillis(value: unknown): number | undefined {
  const parsed = toZaiNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function parseZaiModelCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const codes: string[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item["modelCode"] === "string" && item["modelCode"] !== "") {
      codes.push(item["modelCode"]);
    }
  }
  return codes;
}

function parseZaiLimitItem(value: unknown): ZaiLimitItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const type = typeof value["type"] === "string" ? value["type"] : undefined;
  if (type === undefined || type === "") {
    return null;
  }
  const usage = toZaiNumber(value["usage"]);
  const currentValue = toZaiNumber(value["currentValue"]);
  const percentage = toZaiNumber(value["percentage"]);
  const remaining = toZaiNumber(value["remaining"]);
  const nextResetTime = parseZaiMillis(value["nextResetTime"]);
  const unit = toZaiNumber(value["unit"]);
  const number = toZaiNumber(value["number"]);
  return {
    type,
    ...(usage !== undefined ? { usage } : {}),
    ...(currentValue !== undefined ? { currentValue } : {}),
    ...(percentage !== undefined ? { percentage } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(nextResetTime !== undefined ? { nextResetTime } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(number !== undefined ? { number } : {}),
    usageDetails: parseZaiModelCodes(value["usageDetails"]),
  };
}

/** OMP formatCountedUnit: "5 Hours", "1 Hour". */
function formatCountedUnit(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

type ZaiWindowIdentity = { readonly id: string; readonly label: string };

/** OMP buildZaiWindow: unit enum -> window id/label (3 h, 4 d, 5 mo, 6 w). */
function buildZaiWindowIdentity(parsed: ZaiLimitItem): ZaiWindowIdentity {
  const count = parsed.number !== undefined && parsed.number > 0 ? parsed.number : 1;
  switch (parsed.unit) {
    case 3:
      return { id: `${count}h`, label: formatCountedUnit(count, "Hour") };
    case 4:
      return { id: `${count}d`, label: formatCountedUnit(count, "Day") };
    case 5:
      return { id: `${count}mo`, label: count === 1 ? "Monthly" : formatCountedUnit(count, "Month") };
    case 6:
      return { id: "1w", label: "Weekly" };
    default:
      return parsed.unit !== undefined
        ? { id: `${count}u${parsed.unit}`, label: "Quota" }
        : { id: "quota", label: "Quota" };
  }
}

/** OMP isZaiFeatureRequestLimit: all three feature modelCodes present. */
function isZaiFeatureRequestLimit(parsed: ZaiLimitItem): boolean {
  const codes = new Set(parsed.usageDetails);
  return codes.has("search-prime") && codes.has("web-reader") && codes.has("zread");
}

/** OMP usedFraction: percentage/100 clamped, else used/limit clamped. */
function zaiFractionFor(parsed: ZaiLimitItem): number | undefined {
  if (parsed.percentage !== undefined) {
    return Math.min(Math.max(parsed.percentage / 100, 0), 1);
  }
  if (parsed.currentValue !== undefined && parsed.usage !== undefined && parsed.usage > 0) {
    return Math.min(parsed.currentValue / parsed.usage, 1);
  }
  return undefined;
}

/** OMP getUsageStatus: >=1 exhausted, >=0.9 warning, else ok; undefined -> unknown. */
function zaiSeverityFor(fraction: number | undefined): Severity {
  if (fraction === undefined) {
    return "unknown";
  }
  if (fraction >= 1) {
    return "exhausted";
  }
  if (fraction >= 0.9) {
    return "warning";
  }
  return "ok";
}

/**
 * One bridge UsageWindow per OMP-normalized limit: TOKENS_LIMIT -> tokens
 * quota, TIME_LIMIT -> requests quota (zread feature rows separated).
 */
function windowForZaiLimit(parsed: ZaiLimitItem): UsageWindow | undefined {
  const identity = buildZaiWindowIdentity(parsed);
  const fraction = zaiFractionFor(parsed);
  const severity = zaiSeverityFor(fraction);
  const amounts = {
    ...(fraction !== undefined ? { resolvedFraction: fraction } : {}),
    ...(parsed.currentValue !== undefined ? { used: parsed.currentValue } : {}),
    ...(parsed.usage !== undefined ? { limit: parsed.usage } : {}),
    ...(parsed.nextResetTime !== undefined ? { resetsAtMs: parsed.nextResetTime } : {}),
  };
  if (parsed.type === "TOKENS_LIMIT") {
    return {
      id: `zai:tokens:${identity.id}`,
      label: `ZAI ${identity.label} Token Quota`,
      unit: "tokens",
      severity,
      ...amounts,
    };
  }
  if (parsed.type === "TIME_LIMIT") {
    const featureLimit = isZaiFeatureRequestLimit(parsed);
    return {
      id: featureLimit ? `zai:features:zread:${identity.id}` : `zai:requests:${identity.id}`,
      label: featureLimit ? "ZAI Zread Quota" : "ZAI Request Quota",
      unit: "requests",
      severity,
      ...amounts,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Auth module (OMP packages/ai/src/registry/zai.ts + registry/oauth/zai.ts)
// ---------------------------------------------------------------------------

const API_KEY_DASHBOARD_URL = "https://z.ai/manage-apikey/apikey-list";
const VALIDATION_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const VALIDATION_MODEL = "glm-5.2";
/** OMP VALIDATION_TIMEOUT_MS. */
const VALIDATION_TIMEOUT_MS = 15_000;

const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = "https://api.z.ai";
const BUSINESS_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
/** OMP's own key name so sign-in never mutates ZCode's `zcode-api-key`. */
const KEY_NAME = "oh-my-pi";
const CALLBACK_PORT = 54548;
const CALLBACK_PATH = "/callback";
/** OMP getJson/postJson per-request timeout. */
const BIZ_REQUEST_TIMEOUT_MS = 30_000;

const BROWSER_PASTE_HINT =
  "Complete Z.ai login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.";

const platformZaiFetch: Fetcher = (url, init) => fetch(url, init);

export type ZaiLoginDeps = {
  readonly fetcher: Fetcher;
  /** Injectable browser opener; defaults to the macOS `open` spawn. */
  readonly openBrowser?: BrowserOpener;
};

/** Dispatch a zai login by method (tests inject deps; production uses fetch). */
export async function loginZai(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: ZaiLoginDeps,
): Promise<LoginResult> {
  if (method === "apiKey") {
    return await loginZaiApiKey(inputs, events, signal, deps);
  }
  if (method === "browser") {
    return await loginZaiBrowser(inputs, events, signal, deps);
  }
  throw new BridgeError("invalidRequest", `provider "zai" does not offer login method "${method}"`);
}

export const zaiAuth: AuthModule = {
  providerId: "zai",
  methods: ["apiKey", "browser"],
  login: (method, inputs, events, signal) => loginZai(method, inputs, events, signal, { fetcher: platformZaiFetch }),
};

/** OMP trimmedString: non-empty trimmed string or undefined. */
function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function recordField(data: unknown, field: string): unknown {
  return isRecord(data) ? data[field] : undefined;
}

/**
 * OMP apiKey login: the pasted key arrives via inputs (the bridge wire
 * replaces OMP's interactive prompt), then the exact OMP validation request
 * runs against the coding-plan chat-completions endpoint.
 */
async function loginZaiApiKey(
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: ZaiLoginDeps,
): Promise<LoginResult> {
  const apiKey = inputs.apiKey?.trim() ?? "";
  if (apiKey === "") {
    throw new BridgeError("invalidRequest", "inputs.apiKey must carry the pasted Z.AI API key");
  }
  events.onEvent({
    type: "pasteHint",
    detail: `Copy your API key from the dashboard (${API_KEY_DASHBOARD_URL}) and paste it when prompted.`,
  });
  events.onEvent({ type: "waiting", detail: "Validating API key..." });

  await callProviderHttp({
    call: {
      url: `${VALIDATION_BASE_URL}/chat/completions`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // OMP validateOpenAICompatibleApiKey body, verbatim.
      body: JSON.stringify({
        model: VALIDATION_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    },
    fetcher: deps.fetcher,
    signal: AbortSignal.any([signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)]),
    endpointLabel: "zai API key validation endpoint",
    extraSecrets: [apiKey],
  });

  return { credential: { kind: "apiKey", secret: apiKey } };
}

/**
 * OMP ZaiOAuthFlow: loopback callback on port 54548, authorize URL without
 * PKCE, non-standard token exchange, then the business-API key mint.
 */
async function loginZaiBrowser(
  _inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: ZaiLoginDeps,
): Promise<LoginResult> {
  const state = generateCallbackState();
  let handle: LoopbackCallbackHandle;
  try {
    handle = await startLoopbackCallback(state, { preferredPort: CALLBACK_PORT, callbackPath: CALLBACK_PATH, signal });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BridgeError("transport", `unable to start the local Z.ai OAuth callback server: ${message}`);
  }
  // The 300s loopback deadline can reject this promise on paths that never
  // await it (e.g. an abort before the wait); keep that rejection observed.
  void handle.wait.catch(() => undefined);

  try {
    // OMP generateAuthUrl parameter order: redirect_uri, response_type,
    // client_id, state — and no PKCE (matches ZCode's authorize request).
    const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
      redirect_uri: handle.redirectUri,
      response_type: "code",
      client_id: CLIENT_ID,
      state,
    }).toString()}`;
    events.onEvent({ type: "openUrl", url: authorizeUrl });
    
    events.onEvent({ type: "pasteHint", detail: BROWSER_PASTE_HINT });
    events.onEvent({ type: "waiting", detail: "Waiting for browser authentication..." });

    const code = await waitForZaiCallback(handle, state, events, signal);
    throwIfZaiCancelled(signal);
    events.onEvent({ type: "waiting", detail: "Exchanging authorization code for tokens..." });

    const exchanged = await exchangeZaiToken(code, state, handle.redirectUri, deps.fetcher, signal);
    const mintedKey = await mintZaiApiKey(exchanged.access, deps.fetcher, signal);
    const accountLabel = exchanged.email ?? exchanged.accountId;
    return {
      credential: { kind: "apiKey", secret: mintedKey },
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    };
  } finally {
    handle.stop();
  }
}

async function waitForZaiCallback(
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
          ? "Z.ai login cancelled while waiting for the browser callback"
          : "Z.ai login timed out waiting for the browser callback",
      );
    }
    if (error instanceof CallbackFailedError) {
      // The redirect carried our state nonce: a genuine provider-reported
      // authorization failure (e.g. the user denied the consent screen).
      throw new BridgeError("invalidRequest", error.message);
    }
    throw error;
  }
}

function throwIfZaiCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("timeout", "Z.ai login cancelled before token exchange");
  }
}

function zaiRequestSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(BIZ_REQUEST_TIMEOUT_MS)]);
}

async function getZaiJson(
  url: string,
  headers: Readonly<Record<string, string>>,
  fetcher: Fetcher,
  signal: AbortSignal,
  endpointLabel: string,
  extraSecrets: readonly string[],
): Promise<unknown> {
  const response = await callProviderHttp({
    call: { url, method: "GET", headers: { ...headers } },
    fetcher,
    signal: zaiRequestSignal(signal),
    endpointLabel,
    extraSecrets,
  });
  return await response.json();
}

async function postZaiJson(
  url: string,
  body: Record<string, string | number>,
  headers: Readonly<Record<string, string>>,
  fetcher: Fetcher,
  signal: AbortSignal,
  endpointLabel: string,
  extraSecrets: readonly string[],
): Promise<unknown> {
  const response = await callProviderHttp({
    call: { url, method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    fetcher,
    signal: zaiRequestSignal(signal),
    endpointLabel,
    extraSecrets,
  });
  return await response.json();
}

/**
 * Z.ai's { code, msg, data, success } envelope: the token endpoint signals
 * success with code 0, the biz endpoints with code 200 / success true.
 * Accept both (OMP isSuccessCode); failure throws the envelope msg.
 */
function isSuccessCode(code: unknown): boolean {
  if (code == null) return true;
  if (typeof code === "number") return code === 0 || code === 200;
  if (typeof code === "string") return code === "0" || code === "200";
  return false;
}

function unwrapZaiEnvelope(body: unknown, operation: string): unknown {
  if (isRecord(body) && ("code" in body || "success" in body)) {
    if (body["success"] === false || !isSuccessCode(body["code"])) {
      const msg = typeof body["msg"] === "string" ? body["msg"] : `code ${String(body["code"])}`;
      throw new BridgeError("upstreamError", `Z.ai ${operation} failed: ${msg}`);
    }
    return "data" in body ? body["data"] : body;
  }
  return body;
}

type ZaiTokenExchange = {
  readonly access: string;
  readonly email?: string;
  readonly accountId?: string;
};

/** OMP exchangeToken: non-standard body (no grant_type/code_verifier). */
async function exchangeZaiToken(
  code: string,
  state: string,
  redirectUri: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<ZaiTokenExchange> {
  const body = await postZaiJson(
    TOKEN_URL,
    { provider: "zai", code, redirect_uri: redirectUri, state },
    {},
    fetcher,
    signal,
    "zai token exchange endpoint",
    [],
  );
  const data = unwrapZaiEnvelope(body, "token exchange");
  const access = trimmedString(recordField(recordField(data, "zai"), "access_token"));
  if (access === undefined) {
    throw new BridgeError("malformedPayload", "Z.ai token response missing access token");
  }
  const user = recordField(data, "user");
  const rawEmail = recordField(user, "email");
  const email = typeof rawEmail === "string" ? rawEmail : undefined;
  const rawId = recordField(user, "id");
  const accountId =
    typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : undefined;
  return {
    access,
    ...(email !== undefined ? { email } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
  };
}

/** OMP businessLogin: exchange the OAuth access token for a biz token. */
async function zaiBusinessLogin(oauthAccessToken: string, fetcher: Fetcher, signal: AbortSignal): Promise<string> {
  const body = await postZaiJson(
    BUSINESS_LOGIN_URL,
    { token: oauthAccessToken },
    {},
    fetcher,
    signal,
    "zai business login endpoint",
    [oauthAccessToken],
  );
  const data = unwrapZaiEnvelope(body, "business login");
  const bizToken = trimmedString(recordField(data, "access_token")) ?? trimmedString(recordField(data, "accessToken"));
  if (bizToken === undefined) {
    throw new BridgeError("malformedPayload", "Z.ai business login returned no access token");
  }
  return bizToken;
}

/**
 * OMP mintZaiApiKey: business-login -> default org/project from
 * getCustomerInfo -> find/create the "oh-my-pi" key -> copy its secret ->
 * `${apiKey}.${secretKey}`. List entries mask the secret, so the copy
 * endpoint is always used (OMP comment kept in spirit).
 */
async function mintZaiApiKey(oauthAccessToken: string, fetcher: Fetcher, signal: AbortSignal): Promise<string> {
  const bizToken = await zaiBusinessLogin(oauthAccessToken, fetcher, signal);
  const auth: Readonly<Record<string, string>> = { Authorization: `Bearer ${bizToken}` };
  const secrets = [oauthAccessToken, bizToken];

  const customerBody = await getZaiJson(
    `${BIZ_BASE}/api/biz/customer/getCustomerInfo`,
    auth,
    fetcher,
    signal,
    "zai customer lookup endpoint",
    secrets,
  );
  const customer = unwrapZaiEnvelope(customerBody, "customer lookup");
  const organizations =
    isRecord(customer) && Array.isArray(customer["organizations"]) ? customer["organizations"] : [];
  const organization = organizations.find((org) => isRecord(org) && org["isDefault"]) ?? organizations[0];
  const projects =
    isRecord(organization) && Array.isArray(organization["projects"]) ? organization["projects"] : [];
  const project = projects.find((entry) => isRecord(entry) && entry["isDefault"]) ?? projects[0];
  const organizationId = trimmedString(recordField(organization, "organizationId"));
  const projectId = trimmedString(recordField(project, "projectId"));
  if (organizationId === undefined || projectId === undefined) {
    throw new BridgeError("malformedPayload", "Z.ai key provisioning failed: no organization/project on account");
  }

  const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
  const listedKeys = asZaiKeyArray(
    unwrapZaiEnvelope(
      await getZaiJson(keysUrl, auth, fetcher, signal, "zai api key list endpoint", secrets),
      "api key list",
    ),
  );
  const existing = listedKeys.find((key) => key["name"] === KEY_NAME);
  let keyRecord: Record<string, unknown> | undefined = existing;
  if (keyRecord === undefined) {
    const createdBody = await postZaiJson(
      keysUrl,
      { name: KEY_NAME },
      auth,
      fetcher,
      signal,
      "zai api key create endpoint",
      secrets,
    );
    const created = unwrapZaiEnvelope(createdBody, "api key create");
    if (isRecord(created)) {
      keyRecord = created;
    }
  }

  const apiKey = trimmedString(recordField(keyRecord, "apiKey"));
  if (apiKey === undefined) {
    throw new BridgeError("malformedPayload", "Z.ai key provisioning returned no apiKey");
  }

  const copiedBody = await getZaiJson(
    `${keysUrl}/copy/${encodeURIComponent(apiKey)}`,
    auth,
    fetcher,
    signal,
    "zai api key copy endpoint",
    [...secrets, apiKey],
  );
  const copied = unwrapZaiEnvelope(copiedBody, "api key copy");
  const secretKey = trimmedString(recordField(copied, "secretKey"));
  if (secretKey === undefined) {
    throw new BridgeError("malformedPayload", "Z.ai key provisioning returned no secretKey");
  }

  return `${apiKey}.${secretKey}`;
}

/** OMP asKeyArray: bare array or common wrappers (list/keys/apiKeys/records). */
function asZaiKeyArray(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  }
  if (isRecord(value)) {
    for (const field of ["list", "keys", "apiKeys", "records"]) {
      const entries = value[field];
      if (Array.isArray(entries)) {
        return entries.filter((entry): entry is Record<string, unknown> => isRecord(entry));
      }
    }
  }
  return [];
}
