/**
 * OpenCode Go provider, hand-ported from
 * packages/ai/src/registry/oauth/opencode.ts,
 * packages/ai/src/registry/opencode-go.ts, and
 * packages/ai/src/usage/opencode-go.ts
 * @ 8500092296621a6826b7136e840f8a59ea338958.
 *
 * Auth is explicitly not OAuth: open https://opencode.ai/auth and paste the
 * API key. Usage is GET https://opencode.ai/zen/go/v1/usage with Bearer auth.
 */
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { callProviderHttp } from "../connectors/provider-http";
import { BridgeError, PROTOCOL_VERSION, isRecord } from "../protocol";
import type { BridgeSuccessResponse, Severity, UsageWindow } from "../protocol";

const PROVIDER_ID = "opencode-go";
const CONNECTOR_VERSION = "opencode-go-1";
const AUTH_URL = "https://opencode.ai/auth";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/**
 * OMP `OPENCODE_GO_WINDOWS` limit ids / labels. Monthly is the subscription
 * anniversary — resetsAtMs is reported, with no duration semantics.
 */
const OPENCODE_GO_WINDOWS = [
  { key: "rolling", id: "rolling-5h", label: "5 Hour limit" },
  { key: "weekly", id: "weekly", label: "Weekly limit" },
  { key: "monthly", id: "monthly", label: "Monthly limit" },
] as const;

/** Port of OMP `resolveStatus` in packages/ai/src/usage/opencode-go.ts. */
function resolveSeverity(windowStatus: "ok" | "rate-limited", usedFraction: number): Severity {
  if (windowStatus === "rate-limited") {
    return "exhausted";
  }
  if (usedFraction >= 1) {
    return "exhausted";
  }
  if (usedFraction >= 0.8) {
    return "warning";
  }
  return "ok";
}

function decodeWindow(
  descriptor: (typeof OPENCODE_GO_WINDOWS)[number],
  payload: unknown,
): UsageWindow | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const percent = payload["percent"];
  const status = payload["status"];
  if (
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    (status !== "ok" && status !== "rate-limited")
  ) {
    return undefined;
  }
  const resetsAtMs = typeof payload["resetsAt"] === "string" ? Date.parse(payload["resetsAt"]) : Number.NaN;
  if (!Number.isFinite(resetsAtMs)) {
    return undefined;
  }
  const usedFraction = percent / 100;
  return {
    id: descriptor.id,
    label: descriptor.label,
    unit: "percent",
    resolvedFraction: usedFraction,
    severity: resolveSeverity(status, usedFraction),
    used: percent,
    resetsAtMs,
  };
}

export const opencodeGoConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    if (request.credential === undefined) {
      throw new BridgeError("missingCredential", "opencode-go usage requires a credential");
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
      endpointLabel: "OpenCode Go usage",
      extraSecrets: [secret],
    });
    const payload = await response.json();
    if (!isRecord(payload) || !isRecord(payload["usage"])) {
      throw new BridgeError("noData", "OpenCode Go usage response had no usage object");
    }
    const usage = payload["usage"];
    const windows: UsageWindow[] = [];
    for (const descriptor of OPENCODE_GO_WINDOWS) {
      const window = decodeWindow(descriptor, usage[descriptor.key]);
      if (window !== undefined) {
        windows.push(window);
      }
    }
    if (windows.length === 0) {
      throw new BridgeError("noData", "OpenCode Go usage response contained no usable windows");
    }
    if (windows.length !== OPENCODE_GO_WINDOWS.length) {
      throw new BridgeError("partialPayload", "OpenCode Go usage response was missing or malformed windows");
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

export const opencodeGoAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  async login(method: AuthMethod, inputs: LoginInputs, events: AuthEvents, signal: AbortSignal): Promise<LoginResult> {
    if (signal.aborted) {
      throw new BridgeError("timeout", "OpenCode Go login cancelled");
    }
    if (method !== "apiKey") {
      throw new BridgeError("invalidRequest", "OpenCode Go supports only apiKey login");
    }
    events.onEvent({ type: "openUrl", url: AUTH_URL });
    // OMP onAuth instructions ("Log in and copy your API key") plus the exact
    // onPrompt message ("Paste your OpenCode Zen API key"). OMP performs no
    // key validation for this provider, so none is faked here either.
    events.onEvent({ type: "pasteHint", detail: "Log in and copy your API key, then paste your OpenCode Zen API key" });
    if (signal.aborted) {
      throw new BridgeError("timeout", "OpenCode Go login cancelled");
    }
    const secret = inputs.apiKey?.trim() ?? "";
    if (secret === "") {
      throw new BridgeError("invalidRequest", "OpenCode Go API key is required");
    }
    return { credential: { kind: "apiKey", secret } };
  },
};
