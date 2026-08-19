/**
 * Umans provider, hand-ported from
 * packages/ai/src/registry/umans.ts,
 * packages/ai/src/registry/api-key-login.ts and
 * packages/ai/src/registry/api-key-validation.ts,
 * packages/ai/src/usage/umans.ts
 * @ 8500092296621a6826b7136e840f8a59ea338958.
 *
 * Auth is a dashboard API key from https://app.umans.ai/billing, validated
 * exactly like OMP's createApiKeyLogin with the Anthropic-compatible probe
 * (validateAnthropicCompatibleApiKey: POST
 * https://api.code.umans.ai/v1/messages, x-api-key + anthropic-version
 * 2023-06-01 headers, model umans-coder, one "ping" user message,
 * max_tokens 1, 15s timeout) before the credential is returned. Usage is GET
 * https://api.code.umans.ai/v1/usage with Bearer auth.
 *
 * Weighted usage is utilization against the soft cap; raw counts are
 * utilization against the hard burst ceiling. Concurrency is instantaneous.
 * Incremental `resets_at` ticks are omitted (protocol 1.1 has no resetKind).
 */
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { callProviderHttp, type Fetcher } from "../connectors/provider-http";
import { BridgeError, PROTOCOL_VERSION, isRecord } from "../protocol";
import type { BridgeSuccessResponse, Severity, UsageWindow } from "../protocol";

const PROVIDER_ID = "umans";
const CONNECTOR_VERSION = "umans-1";
const AUTH_URL = "https://app.umans.ai/billing";
const USAGE_URL = "https://api.code.umans.ai/v1/usage";
/**
 * OMP validation baseUrl "https://api.code.umans.ai" + "/v1/messages"; the
 * trailing-/v1 strip in normalizeAnthropicCompatibleBaseUrl is a no-op for
 * this fixed host.
 */
const VALIDATION_URL = "https://api.code.umans.ai/v1/messages";
/** OMP validation model in packages/ai/src/registry/umans.ts. */
const VALIDATION_MODEL = "umans-coder";
/** OMP VALIDATION_TIMEOUT_MS in packages/ai/src/registry/api-key-validation.ts. */
const VALIDATION_TIMEOUT_MS = 15_000;
const PASTE_HINT = "Create or copy your Umans API key from Dashboard → API Keys.";

const platformFetch: Fetcher = (url, init) => fetch(url, init);

/** Injectable login dependencies; unit tests supply a recording fetcher. */
export type UmansLoginDeps = {
  readonly fetcher?: Fetcher;
};

function cancelled(): never {
  throw new BridgeError("timeout", "Umans login cancelled");
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function recordAt(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function usedFractionOf(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return Math.min(used / limit, 1);
}

/** Port of OMP `resolveStatus` in packages/ai/src/usage/umans.ts. */
function resolveStatus(usedFraction: number | undefined): Severity {
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

/**
 * Port of OMP `softCapStatus`. Hitting the effective-request cap only means
 * burst headroom is in use; exhausted is reserved for the hard row.
 */
function softCapStatus(usedFraction: number | undefined): Severity {
  if (usedFraction === undefined) {
    return "unknown";
  }
  if (usedFraction >= 0.9) {
    return "warning";
  }
  return "ok";
}

function windowFrom(args: {
  readonly id: string;
  readonly label: string;
  readonly used: number | undefined;
  readonly limit: number | undefined;
  readonly severity: Severity;
}): UsageWindow | undefined {
  if (args.used === undefined && args.limit === undefined) {
    return undefined;
  }
  const resolvedFraction = usedFractionOf(args.used, args.limit);
  return {
    id: args.id,
    label: args.label,
    unit: "requests",
    ...(resolvedFraction !== undefined ? { resolvedFraction } : {}),
    severity: args.severity,
    ...(args.used !== undefined ? { used: args.used } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  };
}

/** Port of OMP `buildRequestsLimits` — tick `resetsAt` omitted on purpose. */
function requestWindows(payload: unknown): UsageWindow[] {
  const limits = recordAt(payload, "limits");
  const usage = recordAt(payload, "usage");
  const requests = recordAt(limits, "requests");
  const limit = toFiniteNumber(requests?.["limit"]);
  const hardCap = toFiniteNumber(requests?.["hard_cap"]);
  const rawUsed = toFiniteNumber(usage?.["requests_in_window"]);
  const weightedUsed = toFiniteNumber(usage?.["weighted_in_window"]);
  if (limit === undefined && rawUsed === undefined && weightedUsed === undefined) {
    return [];
  }

  if (weightedUsed === undefined || hardCap === undefined) {
    const used = weightedUsed ?? rawUsed;
    const resolvedFraction = usedFractionOf(used, limit);
    const window = windowFrom({
      id: "umans:requests",
      label: "Requests (rolling 5h)",
      used,
      limit,
      severity: resolveStatus(resolvedFraction),
    });
    return window === undefined ? [] : [window];
  }

  const windows: UsageWindow[] = [];
  const soft = windowFrom({
    id: "umans:requests:soft",
    label: "Requests (soft cap)",
    used: weightedUsed,
    limit,
    severity: softCapStatus(usedFractionOf(weightedUsed, limit)),
  });
  if (soft !== undefined) {
    windows.push(soft);
  }
  if (rawUsed !== undefined) {
    const hard = windowFrom({
      id: "umans:requests:hard",
      label: "Requests (burst ceiling)",
      used: rawUsed,
      limit: hardCap,
      severity: resolveStatus(usedFractionOf(rawUsed, hardCap)),
    });
    if (hard !== undefined) {
      windows.push(hard);
    }
  }
  return windows;
}

/** Port of OMP `buildConcurrencyLimit`. Instantaneous; used-only when no cap. */
function concurrencyWindow(payload: unknown): UsageWindow | undefined {
  const concurrency = recordAt(recordAt(payload, "limits"), "concurrency");
  const usage = recordAt(payload, "usage");
  const used = toFiniteNumber(usage?.["concurrent_sessions"]);
  const limit = toFiniteNumber(concurrency?.["limit"]);
  return windowFrom({
    id: "umans:concurrency",
    label: "Concurrency",
    used,
    limit,
    severity: resolveStatus(usedFractionOf(used, limit)),
  });
}

function windowsFrom(payload: unknown): UsageWindow[] {
  const windows = requestWindows(payload);
  const concurrency = concurrencyWindow(payload);
  if (concurrency !== undefined) {
    windows.push(concurrency);
  }
  return windows;
}

export const umansConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    if (request.credential === undefined) {
      throw new BridgeError("missingCredential", "umans usage requires a credential");
    }
    const secret = request.credential.secret;
    const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
    const response = await callProviderHttp({
      call: {
        url: USAGE_URL,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${secret}`,
        },
      },
      fetcher,
      signal,
      endpointLabel: "Umans usage",
      extraSecrets: [secret],
    });
    const payload = await response.json();
    if (!isRecord(payload)) {
      throw new BridgeError("malformedPayload", "Umans usage response was not a JSON object");
    }
    const windows = windowsFrom(payload);
    if (windows.length === 0) {
      throw new BridgeError("noData", "Umans usage response contained no usable windows");
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

export async function loginUmans(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: UmansLoginDeps = {},
): Promise<LoginResult> {
  if (signal.aborted) {
    cancelled();
  }
  if (method !== "apiKey") {
    throw new BridgeError("invalidRequest", "Umans supports only apiKey login");
  }
  events.onEvent({ type: "openUrl", url: AUTH_URL });
  events.onEvent({ type: "pasteHint", detail: PASTE_HINT });
  if (signal.aborted) {
    cancelled();
  }
  const secret = inputs.apiKey?.trim() ?? "";
  if (secret === "") {
    throw new BridgeError("invalidRequest", "Umans API key is required");
  }

  // OMP createApiKeyLogin -> validateAnthropicCompatibleApiKey, exact request shape.
  events.onEvent({ type: "waiting", detail: "Validating API key..." });
  await callProviderHttp({
    call: {
      url: VALIDATION_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": secret,
      },
      body: JSON.stringify({
        model: VALIDATION_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    },
    fetcher: deps.fetcher ?? platformFetch,
    signal: AbortSignal.any([signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)]),
    endpointLabel: "Umans key validation",
    extraSecrets: [secret],
  });

  return { credential: { kind: "apiKey", secret } };
}

export const umansAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  login: loginUmans,
};
