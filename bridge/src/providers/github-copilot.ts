/**
 * GitHub Copilot provider module (auth + usage).
 *
 * Usage routing by credential origin:
 * - OAuth credentials (the device flow below) route to OMP's internal quota
 *   endpoint GET {githubApi}/copilot_internal/user with the quota/reset
 *   normalization from packages/ai/src/usage/github-copilot.ts @ 8500092.
 * - apiKey/bearer credentials (a pasted PAT) route to the documented user
 *   billing connector in `../connectors/github-copilot.ts` (unchanged).
 *
 * Device login is hand-ported from OMP
 * `packages/ai/src/registry/oauth/github-copilot.ts`
 * @ 8500092296621a6826b7136e840f8a59ea338958.
 *
 * Kept from the OMP sources:
 * - OpenCode-owned GitHub OAuth App client id (verbatim).
 * - Device-code and access-token endpoints on github.com (or an enterprise
 *   host), JSON POST bodies (`client_id` + `scope: "read:user"`; then
 *   `device_code` + `grant_type=urn:ietf:params:oauth:grant-type:device_code`),
 *   `Accept`/`Content-Type: application/json` plus the OpenCode User-Agent.
 * - The OMP polling cadence: deadline = now + expires_in; wait FIRST for
 *   min(ceil(interval x 1.2), remaining) with a 1000ms floor and 1000ms
 *   scale; `authorization_pending` keeps polling; `slow_down` switches the
 *   interval to the response's seconds (or +5s when absent) and the
 *   multiplier to 1.4; the deadline expiry yields "Device flow timed out"
 *   (clock-drift variant after any slow_down).
 * - The minted credential mirrors OMP's OAuthCredentials: the GitHub token
 *   doubles as access and refresh with a 10-year far-future expiry and the
 *   normalized enterprise domain as identity.
 * - The quota route (OMP fetchInternalUsage + normalizeQuotaSnapshots +
 *   buildLimitFromQuota + deriveStatus): Bearer refresh??access with JSON
 *   accepts and the OpenCode User-Agent on /copilot_internal/user; premium /
 *   chat / completions snapshots become copilot:{premium,chat,completions}
 *   request windows (chat/completions only when not unlimited); used =
 *   max(0, entitlement - remaining), limit = entitlement, fraction =
 *   used/limit (nil when unlimited or unknown), resetsAtMs from
 *   quota_reset_date; unlimited -> ok, no fraction -> unknown,
 *   remainingFraction <= 0 -> exhausted, <= 0.1 -> warning, else ok.
 * - The GitHub API base URL resolves from identity.enterpriseUrl exactly
 *   like OMP resolveGitHubApiBaseUrl (http(s) verbatim, api.* host kept,
 *   else api. prefix; default https://api.github.com).
 *
 * Deviations from the OMP sources (with reasons):
 * - Enterprise host comes from `LoginInputs.enterpriseHost` because bridge
 *   login is non-interactive over the duplex session (OMP prompts with
 *   onPrompt); the bridge never reads /dev/tty.
 * - OMP resolves the login username and calls the copilot_internal endpoint
 *   discovery + model-policy enablement after login; those feed OMP's model
 *   catalog and metadata surfaces, which the bridge does not have, so login
 *   mints the credential and stops.
 * - OMP's null-report outcomes become typed BridgeErrors (HTTP failures via
 *   callProviderHttp's status map, a non-object body -> malformedPayload, no
 *   usable snapshots -> noData); OMP UsageLimit scope/metadata/raw, notes
 *   (overage counts) and window labels have no bridge surface.
 * - OMP's OAuth supports() gate (refreshToken || accessToken) becomes
 *   missingCredential when neither is present.
 * - The OMP `pollIntervalFloorMs`/`pollIntervalScaleMs` test knobs become
 *   injectable now/sleep dependencies (defaults pinned to OMP's 1000/1000);
 *   the scheduler wait keeps OMP's abort-on-signal semantics, so every
 *   request and wait is deadline-abortable end to end.
 */

import { scheduler } from "node:timers/promises";
import { verificationUriWithUserCode } from "../auth/device";
import { fetchGitHubCopilotUsage } from "../connectors/github-copilot";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION, isRecord } from "../protocol";
import type { BridgeCredential, BridgeSuccessResponse, UsageReport, UsageWindow } from "../protocol";

const PROVIDER_ID = "github-copilot";
const CONNECTOR_VERSION = "github-copilot-1";

/** OpenCode-owned GitHub OAuth App client id, copied verbatim from OMP github-copilot.ts @ 8500092. */
const CLIENT_ID = "Ov23li8tweQw6odWQebz";

/** `OPENCODE_HEADERS.User-Agent` from packages/catalog/src/wire/github-copilot.ts @ 8500092. */
const OPENCODE_USER_AGENT = "opencode/1.3.15";

const DEVICE_SCOPE = "read:user";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const PUBLIC_GITHUB_HOSTS = new Set(["api.github.com", "github.com", "www.github.com"]);

// OMP pollForGitHubAccessToken cadence constants.
const POLL_INTERVAL_FLOOR_MS = 1000;
const POLL_INTERVAL_SCALE_MS = 1000;
const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5 * POLL_INTERVAL_SCALE_MS;
const DEVICE_FLOW_TIMEOUT_MESSAGE = "Device flow timed out";
const DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE =
  "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
/** OMP FAR_FUTURE_MS: GitHub OAuth tokens are long-lived (10 years). */
const FAR_FUTURE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

/** OMP default GitHub API base for the quota route. */
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";

const JSON_HEADERS: Readonly<Record<string, string>> = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": OPENCODE_USER_AGENT,
};

export type GitHubCopilotLoginDeps = {
  readonly fetcher?: Fetcher;
  /** Injectable clock; defaults to Date.now (OMP Date.now). */
  readonly now?: () => number;
  /** Injectable sleep; defaults to the abortable node scheduler wait (OMP scheduler.wait). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export const githubCopilotConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage(input) {
    if (input.request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${input.request.providerId}`);
    }
    const credential = input.request.credential;
    if (credential === undefined) {
      throw new BridgeError("missingCredential", "github-copilot usage requires a credential");
    }
    if (credential.kind === "oauth") {
      return await fetchCopilotQuotaUsage(credential, input);
    }
    // OMP PAT path: prefer the documented billing endpoint, then fall back
    // to the Copilot quota endpoint when billing is unavailable for this
    // otherwise-authenticated GitHub token.
    try {
      return await fetchGitHubCopilotUsage(input);
    } catch {
      return await fetchCopilotQuotaUsage(credential, input);
    }
  },
};

export async function loginGitHubCopilot(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: GitHubCopilotLoginDeps = {},
): Promise<LoginResult> {
  if (signal.aborted) {
    throw cancelled();
  }
  if (method === "apiKey") {
    return loginApiKey(inputs, events, signal);
  }
  if (method === "device") {
    return await loginDevice(inputs, events, signal, deps).catch(error => remapDeviceError(error, signal));
  }
  throw new BridgeError("invalidRequest", "GitHub Copilot supports apiKey and device login only");
}

/** A timeout under an aborted login signal is a cancellation (OMP LoginCancelledError). */
function remapDeviceError(error: unknown, signal: AbortSignal): never {
  if (error instanceof BridgeError && error.kind === "timeout" && signal.aborted) {
    throw cancelled();
  }
  throw error;
}

export const githubCopilotAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey", "device"],
  login: loginGitHubCopilot,
};

function loginApiKey(inputs: LoginInputs, events: AuthEvents, signal: AbortSignal): LoginResult {
  events.onEvent({
    type: "pasteHint",
    detail: "Paste a GitHub personal access token with Copilot access.",
  });
  if (signal.aborted) {
    throw cancelled();
  }
  const secret = inputs.apiKey?.trim() ?? "";
  if (secret === "") {
    throw new BridgeError("invalidRequest", "GitHub Copilot API key is required");
  }
  return { credential: { kind: "bearer", secret } };
}

// ---------------------------------------------------------------------------
// Device login (OMP loginGitHubCopilot + pollForGitHubAccessToken)
// ---------------------------------------------------------------------------

type GitHubDeviceCode = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: number;
  readonly expiresIn: number;
};

async function loginDevice(
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: GitHubCopilotLoginDeps,
): Promise<LoginResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultCopilotSleep;
  const domain = resolveGitHubDomain(inputs.enterpriseHost);

  const device = await awaitGitHubDeviceStep(
    requestDeviceCode(domain, deps.fetcher ?? platformFetch, signal),
    signal,
  );
  events.onEvent({
    type: "openUrl",
    url: verificationUriWithUserCode(device.verificationUri, device.userCode),
  });
  events.onEvent({ type: "code", code: device.userCode, verificationUrl: device.verificationUri });
  events.onEvent({ type: "waiting", detail: `Enter code: ${device.userCode}` });

  const accessToken = await pollForGitHubAccessToken({ device, domain, now, sleep, signal, fetcher: deps.fetcher ?? platformFetch });

  // OMP credentials: the GitHub token doubles as refresh, far-future expiry,
  // and the normalized enterprise domain rides the identity.
  const identity: Record<string, string> = {};
  if (domain !== "github.com") {
    identity["enterpriseUrl"] = domain;
  }
  return {
    credential: {
      kind: "oauth",
      secret: accessToken,
      oauth: {
        access: accessToken,
        refresh: accessToken,
        expiresAtMs: now() + FAR_FUTURE_MS,
        clientId: CLIENT_ID,
        ...(Object.keys(identity).length > 0 ? { identity } : {}),
      },
    },
  };
}

/** OMP default sleep: the abortable node scheduler wait. */
const defaultCopilotSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await scheduler.wait(ms, signal === undefined ? undefined : { signal });
};

/**
 * OMP pollForGitHubAccessToken, verbatim cadence: wait first at
 * ceil(interval * multiplier) capped by the remaining deadline, then poll;
 * pending continues, slow_down re-times the interval, terminal errors fail.
 */
async function pollForGitHubAccessToken(input: {
  readonly device: GitHubDeviceCode;
  readonly domain: string;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
  readonly fetcher: Fetcher;
}): Promise<string> {
  const { device, now, sleep, signal, fetcher } = input;
  const urls = getUrls(input.domain);
  const deadline = now() + device.expiresIn * 1000;
  let intervalMs = Math.max(POLL_INTERVAL_FLOOR_MS, Math.floor(device.interval * POLL_INTERVAL_SCALE_MS));
  let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
  let slowDownResponses = 0;

  while (now() < deadline) {
    if (signal.aborted) {
      throw cancelled();
    }

    const remainingMs = deadline - now();
    const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
    try {
      await sleep(waitMs, signal);
    } catch {
      throw cancelled();
    }

    const raw = await awaitGitHubDeviceStep(
      pollDeviceToken(urls.accessTokenUrl, device.deviceCode, fetcher, signal),
      signal,
    );
    if (isRecord(raw) && typeof raw["access_token"] === "string") {
      return raw["access_token"];
    }
    if (isRecord(raw) && typeof raw["error"] === "string") {
      const errorCode = raw["error"];
      if (errorCode === "authorization_pending") {
        continue;
      }
      if (errorCode === "slow_down") {
        slowDownResponses += 1;
        const interval = raw["interval"];
        intervalMs =
          typeof interval === "number" && interval > 0
            ? Math.max(POLL_INTERVAL_FLOOR_MS, interval * POLL_INTERVAL_SCALE_MS)
            : Math.max(POLL_INTERVAL_FLOOR_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
        intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
        continue;
      }
      const description = typeof raw["error_description"] === "string" ? raw["error_description"] : "";
      const descriptionSuffix = description !== "" ? `: ${description}` : "";
      throw new BridgeError("authRequired", `Device flow failed: ${errorCode}${descriptionSuffix}`);
    }
    throw new BridgeError("malformedPayload", "Invalid device token response");
  }

  throw new BridgeError(
    "timeout",
    slowDownResponses > 0 ? DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE : DEVICE_FLOW_TIMEOUT_MESSAGE,
  );
}

function getUrls(domain: string): { deviceCodeUrl: string; accessTokenUrl: string } {
  return {
    deviceCodeUrl: `https://${domain}/login/device/code`,
    accessTokenUrl: `https://${domain}/login/oauth/access_token`,
  };
}

async function requestDeviceCode(domain: string, fetcher: Fetcher, signal: AbortSignal): Promise<GitHubDeviceCode> {
  const response = await callProviderHttp({
    call: {
      url: getUrls(domain).deviceCodeUrl,
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: DEVICE_SCOPE }),
    },
    fetcher,
    signal,
    endpointLabel: "GitHub device code",
  });
  return parseDeviceCodeResponse(await response.json());
}

function parseDeviceCodeResponse(data: unknown): GitHubDeviceCode {
  if (!isRecord(data)) {
    throw new BridgeError("malformedPayload", "Invalid device code response");
  }
  const deviceCode = data["device_code"];
  const userCode = data["user_code"];
  const verificationUri = data["verification_uri"];
  const interval = data["interval"];
  const expiresIn = data["expires_in"];
  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    typeof interval !== "number" ||
    typeof expiresIn !== "number"
  ) {
    throw new BridgeError("malformedPayload", "Invalid device code response fields");
  }
  return { deviceCode, userCode, verificationUri, interval, expiresIn };
}

async function pollDeviceToken(
  accessTokenUrl: string,
  deviceCode: string,
  fetcher: Fetcher,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await callProviderHttp({
    call: {
      url: accessTokenUrl,
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: DEVICE_CODE_GRANT_TYPE,
      }),
    },
    fetcher,
    signal,
    endpointLabel: "GitHub device token",
  });
  return await response.json();
}

/**
 * `normalizeDomain` from packages/catalog/src/wire/github-copilot.ts @ 8500092.
 * Enterprise host is optional; blank input is github.com.
 */
function resolveGitHubDomain(enterpriseHost: string | undefined): string {
  const trimmed = enterpriseHost?.trim() ?? "";
  if (trimmed === "") {
    return "github.com";
  }
  const normalized = normalizeDomain(trimmed);
  if (normalized === null) {
    throw new BridgeError("invalidRequest", "Invalid GitHub Enterprise URL/domain");
  }
  return isPublicGitHubHost(normalized) ? "github.com" : normalized;
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function isPublicGitHubHost(host: string): boolean {
  return PUBLIC_GITHUB_HOSTS.has(host.trim().toLowerCase());
}

function cancelled(): BridgeError {
  return new BridgeError("timeout", "GitHub Copilot login was cancelled");
}

/**
 * A fetch implementation is expected to honor AbortSignal, but the login
 * session must still settle when an upstream runtime leaves a fetch promise
 * pending after abort. Keep a rejection handler attached to the operation so
 * a late failure is consumed after the deadline wins.
 */
function awaitGitHubDeviceStep<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(cancelled());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      value => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// OAuth usage route (OMP packages/ai/src/usage/github-copilot.ts)
// ---------------------------------------------------------------------------

/** OMP pi-catalog toNumber. */
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

/** OMP parseIsoTimestamp. */
function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** OMP CopilotQuotaDetail (minus the note-only overage fields). */
type CopilotQuotaDetail = {
  readonly entitlement: number;
  readonly remaining: number;
  readonly unlimited: boolean;
};

/** OMP parseQuotaDetail: every driver field must parse or the snapshot drops. */
function parseCopilotQuotaDetail(value: unknown): CopilotQuotaDetail | null {
  if (!isRecord(value)) {
    return null;
  }
  const entitlement = toNumber(value["entitlement"]);
  const remaining = toNumber(value["remaining"]);
  const percentRemaining = toNumber(value["percent_remaining"]);
  const unlimited = value["unlimited"];
  if (
    entitlement === undefined ||
    remaining === undefined ||
    percentRemaining === undefined ||
    typeof unlimited !== "boolean"
  ) {
    return null;
  }
  return { entitlement, remaining, unlimited };
}

/** OMP deriveStatus via remainingFraction. */
function copilotQuotaSeverity(quota: CopilotQuotaDetail, usedFraction: number | undefined): UsageWindow["severity"] {
  if (quota.unlimited) {
    return "ok";
  }
  if (usedFraction === undefined) {
    return "unknown";
  }
  const remainingFraction = Math.max(0, 1 - usedFraction);
  if (remainingFraction <= 0) {
    return "exhausted";
  }
  if (remainingFraction <= 0.1) {
    return "warning";
  }
  return "ok";
}

/** OMP buildLimitFromQuota mapped onto a bridge UsageWindow. */
function buildCopilotQuotaWindow(args: {
  readonly id: string;
  readonly label: string;
  readonly quota: CopilotQuotaDetail;
  readonly resetsAtMs: number | undefined;
}): UsageWindow {
  const used = args.quota.unlimited ? undefined : Math.max(0, args.quota.entitlement - args.quota.remaining);
  const limit = args.quota.unlimited ? undefined : args.quota.entitlement;
  const resolvedFraction =
    used !== undefined && limit !== undefined && limit > 0 ? used / limit : undefined;
  return {
    id: args.id,
    label: args.label,
    unit: "requests",
    ...(resolvedFraction !== undefined ? { resolvedFraction } : {}),
    severity: copilotQuotaSeverity(args.quota, resolvedFraction),
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(args.resetsAtMs !== undefined ? { resetsAtMs: args.resetsAtMs } : {}),
  };
}

/** OMP resolveGitHubApiBaseUrl (enterprise branch; bridge has no config baseUrl). */
function resolveCopilotApiBaseUrl(identity: Readonly<Record<string, string>> | undefined): string {
  const enterpriseUrl = identity?.["enterpriseUrl"]?.trim();
  if (enterpriseUrl === undefined || enterpriseUrl === "") {
    return DEFAULT_GITHUB_API_BASE;
  }
  if (enterpriseUrl.startsWith("http://") || enterpriseUrl.startsWith("https://")) {
    return enterpriseUrl.replace(/\/$/, "");
  }
  if (enterpriseUrl.startsWith("api.")) {
    return `https://${enterpriseUrl}`;
  }
  return `https://api.${enterpriseUrl}`;
}

async function fetchCopilotQuotaUsage(
  credential: BridgeCredential,
  input: { readonly request: Parameters<ConnectorModule["fetchUsage"]>[0]["request"]; readonly fetcher: Fetcher; readonly nowMs: number },
): Promise<BridgeSuccessResponse> {
  const oauth = credential.kind === "oauth" ? credential.oauth : undefined;
  const token = oauth === undefined
    ? (credential.kind === "none" ? "" : credential.secret)
    : (oauth.refresh ?? oauth.access);
  if (token === "") {
    throw new BridgeError("missingCredential", "github-copilot oauth credential carries no GitHub token");
  }
  const signal = AbortSignal.timeout(Math.max(1, input.request.deadlineAtMs - input.nowMs));
  const baseUrl = resolveCopilotApiBaseUrl(oauth?.identity);

  // OMP fetchInternalUsage: Bearer token, JSON accepts, OpenCode UA.
  const response = await callProviderHttp({
    call: {
      url: `${baseUrl}/copilot_internal/user`,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": OPENCODE_USER_AGENT,
      },
    },
    fetcher: input.fetcher,
    signal,
    endpointLabel: "GitHub Copilot quota endpoint",
    extraSecrets: [
      ...(credential.kind === "none" ? [] : [credential.secret]),
      ...(oauth === undefined ? [] : [oauth.access, oauth.refresh ?? ""]),
    ],
  });
  const data = await response.json();
  if (!isRecord(data)) {
    throw new BridgeError("malformedPayload", "Invalid Copilot usage response");
  }

  // OMP normalizeQuotaSnapshots: reset window shared by every limit.
  const resetsAtMs = parseIsoTimestamp(data["quota_reset_date"]);
  const snapshots = isRecord(data["quota_snapshots"]) ? data["quota_snapshots"] : {};
  const windows: UsageWindow[] = [];
  const premium = parseCopilotQuotaDetail(snapshots["premium_interactions"]);
  if (premium !== null) {
    windows.push(buildCopilotQuotaWindow({ id: "copilot:premium", label: "Premium Requests", quota: premium, resetsAtMs }));
  }
  const chat = parseCopilotQuotaDetail(snapshots["chat"]);
  if (chat !== null && !chat.unlimited) {
    windows.push(buildCopilotQuotaWindow({ id: "copilot:chat", label: "Chat Requests", quota: chat, resetsAtMs }));
  }
  const completions = parseCopilotQuotaDetail(snapshots["completions"]);
  if (completions !== null && !completions.unlimited) {
    windows.push(
      buildCopilotQuotaWindow({ id: "copilot:completions", label: "Completions", quota: completions, resetsAtMs }),
    );
  }
  if (windows.length === 0) {
    throw new BridgeError("noData", "github-copilot usage response contained no usable quota snapshots");
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

const platformFetch: Fetcher = (url, init) => fetch(url, init);
