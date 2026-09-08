/**
 * Synthetic provider, hand-ported from
 *   packages/ai/src/registry/synthetic.ts
 *   packages/ai/src/registry/api-key-login.ts
 *   packages/ai/src/registry/api-key-validation.ts
 *   packages/ai/src/usage/synthetic.ts
 * @ 8500092296621a6826b7136e840f8a59ea338958.
 *
 * Auth is a dashboard API key validated against GET /openai/v1/models.
 * Usage is GET https://api.synthetic.new/v2/quotas with Bearer auth.
 * Regeneration tick timestamps are not window resets: resetsAtMs is omitted.
 */
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { callProviderHttp, type Fetcher } from "../connectors/provider-http";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type { BridgeSuccessResponse, UsageUnit, UsageWindow } from "../protocol";

const PROVIDER_ID = "synthetic";
const CONNECTOR_VERSION = "synthetic-1";
const QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
const MODELS_URL = "https://api.synthetic.new/openai/v1/models";
const DASHBOARD_URL = "https://dev.synthetic.new/docs/api/overview";
const PASTE_HINT = "Copy your API key from the Synthetic dashboard";
/** OMP `VALIDATION_TIMEOUT_MS` in packages/ai/src/registry/api-key-validation.ts. */
const VALIDATION_TIMEOUT_MS = 15_000;

const platformFetch: Fetcher = (url, init) => fetch(url, init);

export type SyntheticLoginDeps = {
  readonly fetcher?: Fetcher;
};

export const syntheticConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    const credential = request.credential;
    if (credential === undefined) {
      throw new BridgeError("missingCredential", "synthetic usage requires a credential");
    }

    const secret = credential.secret;
    const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
    const response = await callProviderHttp({
      call: {
        url: QUOTAS_URL,
        method: "GET",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
      },
      fetcher,
      signal,
      endpointLabel: "Synthetic quotas",
      extraSecrets: [secret],
    });
    const payload = await response.json();
    if (!isRecord(payload)) {
      throw new BridgeError("malformedPayload", "Synthetic quotas returned a non-object body");
    }

    const windows: UsageWindow[] = [];
    const fiveHour = parseRollingFiveHourLimit(payload["rollingFiveHourLimit"]);
    if (fiveHour !== undefined) {
      windows.push(fiveHour);
    }
    const weekly = parseWeeklyTokenLimit(payload["weeklyTokenLimit"]);
    if (weekly !== undefined) {
      windows.push(weekly);
    }
    if (windows.length === 0) {
      throw new BridgeError("noData", "Synthetic quotas contained no usable request or credit windows");
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

export async function loginSynthetic(
  method: AuthMethod,
  inputs: LoginInputs,
  events: AuthEvents,
  signal: AbortSignal,
  deps: SyntheticLoginDeps = {},
): Promise<LoginResult> {
  if (signal.aborted) {
    throw cancelled();
  }
  if (method !== "apiKey") {
    throw new BridgeError("invalidRequest", "Synthetic supports API-key login only");
  }

  events.onEvent({ type: "openUrl", url: DASHBOARD_URL });
  events.onEvent({ type: "pasteHint", detail: PASTE_HINT });
  if (signal.aborted) {
    throw cancelled();
  }

  const secret = inputs.apiKey?.trim() ?? "";
  if (secret === "") {
    throw new BridgeError("invalidRequest", "Synthetic API key is required");
  }

  events.onEvent({ type: "waiting", detail: "Validating API key..." });
  try {
    // OMP `validateApiKeyAgainstModelsEndpoint`: GET models, Bearer, 15s timeout.
    await callProviderHttp({
      call: {
        url: MODELS_URL,
        method: "GET",
        headers: { Authorization: `Bearer ${secret}` },
      },
      fetcher: deps.fetcher ?? platformFetch,
      signal: AbortSignal.any([signal, AbortSignal.timeout(VALIDATION_TIMEOUT_MS)]),
      endpointLabel: "Synthetic models",
      extraSecrets: [secret],
    });
  } catch (error) {
    if (signal.aborted) {
      throw cancelled();
    }
    throw error;
  }

  return { credential: { kind: "apiKey", secret } };
}

export const syntheticAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  login: loginSynthetic,
};

function cancelled(): BridgeError {
  return new BridgeError("timeout", "Synthetic login was cancelled");
}

/**
 * Port of OMP `parseRollingFiveHourLimit`. `nextTickAt` is a regen tick, not a
 * window reset, so `resetsAtMs` is omitted (protocol 1.1 has no resetKind).
 */
function parseRollingFiveHourLimit(raw: unknown): UsageWindow | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const remaining = finiteNumber(raw["remaining"]);
  const max = finiteNumber(raw["max"]);
  if (remaining === undefined && max === undefined) {
    return undefined;
  }
  const used = max !== undefined && remaining !== undefined ? max - remaining : undefined;
  const resolvedFraction = fractionFromUsedLimit(used, max);
  return usageWindow({
    id: "synthetic:requests:5h",
    label: "Synthetic Requests",
    unit: "requests",
    used,
    limit: max,
    remaining,
    resolvedFraction,
  });
}

/**
 * Port of OMP `parseWeeklyTokenLimit`. `used` comes from `percentRemaining`
 * when present (rounded dollar amounts can disagree). Without a percent,
 * known remaining/maximum amounts are used. `nextRegenAt` is not a reset.
 */
function parseWeeklyTokenLimit(raw: unknown): UsageWindow | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const remainingCredits = parseDollarAmount(raw["remainingCredits"]);
  const maxCredits = parseDollarAmount(raw["maxCredits"]);
  if (remainingCredits === undefined && maxCredits === undefined) {
    return undefined;
  }
  const percentRemaining = finiteNumber(raw["percentRemaining"]);
  const percentFraction = percentRemaining === undefined ? undefined : clamp01(1 - percentRemaining / 100);
  const used = maxCredits === undefined ? undefined
    : percentFraction !== undefined ? percentFraction * maxCredits
    : remainingCredits !== undefined ? maxCredits - remainingCredits : undefined;
  const resolvedFraction = fractionFromUsedLimit(used, maxCredits) ?? percentFraction;
  return usageWindow({
    id: "synthetic:usd:7d",
    label: "Synthetic Credits",
    unit: "usd",
    used,
    limit: maxCredits,
    // Do not mix rounded dollar balances with the authoritative percentage.
    remaining: percentFraction === undefined || maxCredits === undefined ? remainingCredits : undefined,
    resolvedFraction,
  });
}

function usageWindow(input: {
  id: string;
  label: string;
  unit: UsageUnit;
  used: number | undefined;
  limit: number | undefined;
  remaining: number | undefined;
  resolvedFraction: number | undefined;
}): UsageWindow {
  if ((input.used !== undefined && input.used < 0) || (input.limit !== undefined && input.limit <= 0)
    || (input.remaining !== undefined && (input.remaining < 0 || (input.limit !== undefined && input.remaining > input.limit)))) {
    throw new BridgeError("malformedPayload", "Synthetic quotas contain invalid amounts");
  }
  return {
    id: input.id,
    label: input.label,
    unit: input.unit,
    // limited is not a utilization value and cannot override a known ratio.
    severity: severityForFraction(input.resolvedFraction),
    ...(input.used !== undefined ? { used: input.used } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.remaining !== undefined ? { remaining: input.remaining } : {}),
    ...(input.resolvedFraction !== undefined ? { resolvedFraction: input.resolvedFraction } : {}),
  };
}

function fractionFromUsedLimit(used: number | undefined, limit: number | undefined): number | undefined {
  if (used === undefined || limit === undefined || limit <= 0) {
    return undefined;
  }
  return used / limit;
}

function parseDollarAmount(value: unknown): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value.replace(/^\$/, "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
