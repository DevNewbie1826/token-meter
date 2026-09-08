/**
 * MiniMax Token Plan (international) provider, hand-ported from
 *   packages/ai/src/registry/oauth/minimax-code.ts
 *   packages/ai/src/registry/api-key-login.ts
 *   packages/ai/src/registry/api-key-validation.ts
 *   packages/ai/src/usage/minimax-code.ts
 *   packages/ai/src/usage/shared.ts
 * @ 8500092296621a6826b7136e840f8a59ea338958.
 *
 * Auth is not OAuth: open the Token Plan subscribe page and paste the API
 * key, then validate it exactly like OMP's createApiKeyLogin with a
 * chat-completions probe (validateOpenAICompatibleApiKey: POST
 * https://api.minimax.io/v1/chat/completions, model MiniMax-M3, one "ping"
 * user message, max_tokens 1, temperature 0, 15s timeout) before the
 * credential is returned. Usage is GET
 * https://api.minimax.io/v1/token_plan/remains with Bearer auth. MiniMax
 * answers HTTP 200 even for rejected credentials, so `base_resp.status_code`
 * is the real success signal.
 *
 * PORT NOTE: China endpoints and a configurable base URL are out of scope for
 * this international provider. OMP limit notes, model scope, and
 * metadata.models are dropped because UsageWindow has no such fields (and
 * model-catalog keys are forbidden on the wire).
 */
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { callProviderHttp, type Fetcher } from "../connectors/provider-http";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type { BridgeSuccessResponse, UsageWindow } from "../protocol";

const PROVIDER_ID = "minimax-code";
const CONNECTOR_VERSION = "minimax-code-1";
const AUTH_URL = "https://platform.minimax.io/subscribe/token-plan";
const REMAINS_URL = "https://api.minimax.io/v1/token_plan/remains";
/** OMP API_BASE_URL_INTL + the chat-completions path appended by validateOpenAICompatibleApiKey. */
const VALIDATION_URL = "https://api.minimax.io/v1/chat/completions";
/** OMP VALIDATION_MODEL in packages/ai/src/registry/oauth/minimax-code.ts. */
const VALIDATION_MODEL = "MiniMax-M3";
/** OMP VALIDATION_TIMEOUT_MS in packages/ai/src/registry/api-key-validation.ts. */
const VALIDATION_TIMEOUT_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;
/** `current_*_status` enum: 1 normal, 2 exhausted, 3 unlimited. */
const STATUS_EXHAUSTED = 2;
const STATUS_UNLIMITED = 3;

const platformFetch: Fetcher = (url, init) => fetch(url, init);

/** Injectable login dependencies; unit tests supply a recording fetcher. */
export type MiniMaxLoginDeps = {
  readonly fetcher?: Fetcher;
};

type TokenPlanBucket = {
  readonly modelName: string;
  readonly intervalStart?: number;
  readonly intervalEnd?: number;
  readonly intervalRemainingPercent?: number;
  readonly intervalTotalCount?: number;
  readonly intervalStatus?: number;
  readonly weeklyStart?: number;
  readonly weeklyEnd?: number;
  readonly weeklyRemainingPercent?: number;
  readonly weeklyTotalCount?: number;
  readonly weeklyStatus?: number;
};

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

/** Ported from OMP usage/shared.ts: seconds or milliseconds epoch, positive only. */
function parsePositiveTimestamp(value: unknown): number | undefined {
  const parsed = toNumber(value);
  if (parsed === undefined || parsed <= 0) {
    return undefined;
  }
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

function parseBucket(value: unknown): TokenPlanBucket | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const modelName = typeof value["model_name"] === "string" ? value["model_name"].trim() : "";
  if (modelName === "") {
    return undefined;
  }
  const intervalStart = parsePositiveTimestamp(value["start_time"]);
  const intervalEnd = parsePositiveTimestamp(value["end_time"]);
  const intervalRemainingPercent = toNumber(value["current_interval_remaining_percent"]);
  const intervalTotalCount = toNumber(value["current_interval_total_count"]);
  const intervalStatus = toNumber(value["current_interval_status"]);
  const weeklyStart = parsePositiveTimestamp(value["weekly_start_time"]);
  const weeklyEnd = parsePositiveTimestamp(value["weekly_end_time"]);
  const weeklyRemainingPercent = toNumber(value["current_weekly_remaining_percent"]);
  const weeklyTotalCount = toNumber(value["current_weekly_total_count"]);
  const weeklyStatus = toNumber(value["current_weekly_status"]);
  return {
    modelName,
    ...(intervalStart !== undefined ? { intervalStart } : {}),
    ...(intervalEnd !== undefined ? { intervalEnd } : {}),
    ...(intervalRemainingPercent !== undefined ? { intervalRemainingPercent } : {}),
    ...(intervalTotalCount !== undefined ? { intervalTotalCount } : {}),
    ...(intervalStatus !== undefined ? { intervalStatus } : {}),
    ...(weeklyStart !== undefined ? { weeklyStart } : {}),
    ...(weeklyEnd !== undefined ? { weeklyEnd } : {}),
    ...(weeklyRemainingPercent !== undefined ? { weeklyRemainingPercent } : {}),
    ...(weeklyTotalCount !== undefined ? { weeklyTotalCount } : {}),
    ...(weeklyStatus !== undefined ? { weeklyStatus } : {}),
  };
}

/**
 * Both windows unlimited with zero totals means the model is not in the plan
 * (MiniMax-AI/cli#173). Ported from OMP `isUnavailablePlan`.
 */
function isUnavailablePlan(bucket: TokenPlanBucket): boolean {
  return (
    bucket.intervalTotalCount === 0 &&
    bucket.weeklyTotalCount === 0 &&
    bucket.intervalStatus === STATUS_UNLIMITED &&
    bucket.weeklyStatus === STATUS_UNLIMITED
  );
}

/**
 * Interval length varies per bucket, so the window id follows the reported
 * span. Whole hours stay `Nh`; anything else is labelled in minutes.
 */
function intervalWindowId(durationMs: number | undefined): { readonly id: string; readonly label: string } {
  if (durationMs === undefined || durationMs <= 0) {
    return { id: "interval", label: "Interval" };
  }
  if (durationMs % HOUR_MS === 0) {
    const hours = durationMs / HOUR_MS;
    return { id: `${hours}h`, label: `${hours} Hour` };
  }
  const minutes = Math.round(durationMs / 60_000);
  if (minutes <= 0) {
    return { id: "interval", label: "Interval" };
  }
  return { id: `${minutes}m`, label: `${minutes} Minute` };
}

function capitalizeName(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * Remaining percent -> used = 100 - remaining, clamped to [0, 100].
 * Status 2 forces exhausted; status 3 is unlimited (fraction 0, ok).
 */
function buildWindow(args: {
  readonly bucket: TokenPlanBucket;
  readonly windowId: string;
  readonly windowLabel: string;
  readonly remainingPercent: number | undefined;
  readonly windowStatus: number | undefined;
  readonly resetsAtMs: number | undefined;
}): UsageWindow | undefined {
  let used: number;
  if (args.windowStatus === STATUS_EXHAUSTED) {
    used = 100;
  } else if (args.windowStatus === STATUS_UNLIMITED) {
    used = 0;
  } else if (args.remainingPercent === undefined) {
    return undefined;
  } else {
    used = Math.min(100, Math.max(0, 100 - args.remainingPercent));
  }
  const resolvedFraction = used / 100;
  const severity = severityForFraction(resolvedFraction);
  return {
    id: `${args.bucket.modelName}:${args.windowId}`,
    label: `${capitalizeName(args.bucket.modelName)} ${args.windowLabel}`,
    unit: "percent",
    resolvedFraction,
    severity,
    used,
    ...(args.resetsAtMs !== undefined ? { resetsAtMs: args.resetsAtMs } : {}),
  };
}

function buildBucketWindows(bucket: TokenPlanBucket): readonly UsageWindow[] {
  const intervalDuration =
    bucket.intervalStart !== undefined && bucket.intervalEnd !== undefined
      ? bucket.intervalEnd - bucket.intervalStart
      : undefined;
  const interval = intervalWindowId(intervalDuration);
  return [
    buildWindow({
      bucket,
      windowId: interval.id,
      windowLabel: interval.label,
      remainingPercent: bucket.intervalRemainingPercent,
      windowStatus: bucket.intervalStatus,
      resetsAtMs: bucket.intervalEnd,
    }),
    buildWindow({
      bucket,
      windowId: "7d",
      windowLabel: "7 Day",
      remainingPercent: bucket.weeklyRemainingPercent,
      windowStatus: bucket.weeklyStatus,
      resetsAtMs: bucket.weeklyEnd,
    }),
  ].filter((window): window is UsageWindow => window !== undefined);
}

function throwIfLoginCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BridgeError("timeout", "MiniMax Token Plan login cancelled");
  }
}

export const minimaxCodeConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    if (request.credential === undefined) {
      throw new BridgeError("missingCredential", "minimax-code usage requires a credential");
    }
    const secret = request.credential.secret;
    const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
    const response = await callProviderHttp({
      call: {
        url: REMAINS_URL,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${secret}`,
        },
      },
      fetcher,
      signal,
      endpointLabel: "MiniMax Token Plan remains",
      extraSecrets: [secret],
    });
    const payload = await response.json();
    if (!isRecord(payload)) {
      throw new BridgeError("malformedPayload", "MiniMax Token Plan remains returned a non-object body");
    }
    const baseResp = payload["base_resp"];
    if (!isRecord(baseResp)) {
      throw new BridgeError("malformedPayload", "MiniMax Token Plan remains returned no base_resp envelope");
    }
    const statusCode = toNumber(baseResp["status_code"]);
    if (statusCode !== 0) {
      // HTTP 200 with a non-zero envelope is MiniMax's rejected-credential signal.
      throw new BridgeError("authRequired", "MiniMax Token Plan rejected the credential");
    }
    if (!Array.isArray(payload["model_remains"])) {
      throw new BridgeError("malformedPayload", "MiniMax Token Plan remains returned no model_remains array");
    }
    const windows: UsageWindow[] = [];
    for (const entry of payload["model_remains"]) {
      const bucket = parseBucket(entry);
      if (bucket === undefined || isUnavailablePlan(bucket)) {
        continue;
      }
      windows.push(...buildBucketWindows(bucket));
    }
    if (windows.length === 0) {
      throw new BridgeError("noData", "MiniMax Token Plan remains contained no usable quota windows");
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
        sourceKind: "firstPartyApi",
        fetchedAtMs: nowMs,
        connectorVersion: CONNECTOR_VERSION,
        windows,
      },
    };
  },
};

export async function loginMiniMaxCode(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: MiniMaxLoginDeps = {},
): Promise<LoginResult> {
  throwIfLoginCancelled(signal);
  if (method !== "apiKey") {
    throw new BridgeError("invalidRequest", "MiniMax Token Plan supports only apiKey login");
  }
  events.onEvent({ type: "openUrl", url: AUTH_URL });
  events.onEvent({
    type: "pasteHint",
    detail: "Subscribe to Token Plan and copy your API key. Paste your MiniMax Token Plan API key.",
  });
  throwIfLoginCancelled(signal);
  const secret = inputs.apiKey?.trim() ?? "";
  if (secret === "") {
    throw new BridgeError("invalidRequest", "MiniMax Token Plan API key is required");
  }

  // OMP createApiKeyLogin -> validateOpenAICompatibleApiKey, exact request shape.
  events.onEvent({ type: "waiting", detail: "Validating API key..." });
  await callProviderHttp({
    call: {
      url: VALIDATION_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        model: VALIDATION_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
        temperature: 0,
      }),
    },
    fetcher: deps.fetcher ?? platformFetch,
    signal: AbortSignal.any([signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)]),
    endpointLabel: "MiniMax Token Plan key validation",
    extraSecrets: [secret],
  });

  return { credential: { kind: "apiKey", secret } };
}

export const minimaxCodeAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  login: loginMiniMaxCode,
};
