/** App-owned Nekos API-key adapter; not an OMP provider.
 * Both auth validation and quota reads use usage/self. Raw costs have an
 * unconfirmed scale, so only used_percent is exposed; lifetime totals are not quotas.
 */
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { callProviderHttp, type Fetcher } from "../connectors/provider-http";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type { UsageWindow } from "../protocol";

const USAGE_URL = "https://claude.nekos.me/v1/usage/self";
const CONNECTOR_VERSION = "nekos-1";
const REQUEST_TIMEOUT_MS = 15000;
const platformFetch: Fetcher = (url, init) => fetch(url, init);
const ZONED_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export const nekosConnector: ConnectorModule = {
  providerId: "nekos",
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs }) {
    if (request.providerId !== "nekos") {
      throw new BridgeError("invalidProvider", "Nekos connector only serves Nekos");
    }
    const credential = request.credential;
    if (credential === undefined) {
      throw new BridgeError("missingCredential", "Nekos usage requires an API key");
    }
    switch (credential.kind) {
      case "apiKey": break;
      case "bearer": case "oauth": case "none":
        throw new BridgeError("missingCredential", "Nekos usage requires an API-key credential");
      default: throw new BridgeError("internalError", credential satisfies never);
    }
    if (request.deadlineAtMs <= nowMs) {
      throw new BridgeError("timeout", "Nekos usage deadline has expired");
    }
    const signal = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, request.deadlineAtMs - nowMs));
    const windows = await readNekosWindows(credential.secret, fetcher, signal);
    if (windows.length === 0) {
      throw new BridgeError("noData", "Nekos usage contains no supported quota limits");
    }
    return {
      schemaVersion: PROTOCOL_VERSION, requestId: request.requestId,
      providerId: request.providerId, connectorId: request.connectorId, accountRef: request.accountRef,
      status: "ok", completedAtMs: nowMs,
      report: { productKind: "quota", sourceKind: "firstPartyApi", fetchedAtMs: nowMs,
        connectorVersion: CONNECTOR_VERSION, windows },
    };
  },
};

export type NekosLoginDeps = { readonly fetcher?: Fetcher };

// Five parameters preserve the existing AuthModule.login contract plus the
// injected network seam used by sibling adapters; no new positional API design.
export async function loginNekos(
  method: AuthMethod, inputs: LoginInputs, events: AuthEvents, signal: AbortSignal,
  deps: NekosLoginDeps = {},
): Promise<LoginResult> {
  switch (method) {
    case "apiKey": break;
    case "browser": case "device":
      throw new BridgeError("invalidRequest", "Nekos supports API-key login only");
    default: throw new BridgeError("internalError", method satisfies never);
  }
  const secret = inputs.apiKey?.trim() ?? "";
  if (secret === "") {
    throw new BridgeError("invalidRequest", "Nekos API key is required");
  }
  events.onEvent({ type: "waiting", detail: "Validating Nekos API key..." });
  await readNekosWindows(secret, deps.fetcher ?? platformFetch,
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
  return { credential: { kind: "apiKey", secret } };
}

export const nekosAuth: AuthModule = {
  providerId: "nekos", methods: ["apiKey"], login: loginNekos,
};

/** One HTTP/parser boundary for both callers, including body-read cancellation.
 * Race the whole read as injected transports may not honor AbortSignal. The
 * shared HTTP helper otherwise maps native TimeoutError to transport and a
 * cancelled body read to malformedPayload; cancellation must remain timeout.
 */
async function readNekosWindows(secret: string, fetcher: Fetcher, signal: AbortSignal): Promise<readonly UsageWindow[]> {
  const cancelled = new BridgeError("timeout", "Nekos request was cancelled or timed out");
  if (signal.aborted) throw cancelled;
  const aborted = Promise.withResolvers<never>();
  const onAbort = (): void => aborted.reject(cancelled);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await Promise.race([aborted.promise, callProviderHttp({
      call: { url: USAGE_URL, method: "GET", headers: { "x-api-key": secret, "anthropic-version": "2023-06-01" } },
      fetcher, signal, endpointLabel: "Nekos usage endpoint", extraSecrets: [secret],
    })]);
    const payload = await Promise.race([aborted.promise, response.json()]);
    return parseNekosWindows(payload);
  } catch (error) {
    if (signal.aborted) throw cancelled;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Match the bridge's dependency-free boundary parsers, returning only typed
 * wire windows. Never discard a malformed supported row beside a valid one.
 */
function parseNekosWindows(payload: unknown): readonly UsageWindow[] {
  if (!isRecord(payload) || !Array.isArray(payload["limits"])) {
    throw new BridgeError("malformedPayload", "Nekos usage requires a limits array");
  }
  const windows: UsageWindow[] = [];
  const ids = new Set<string>();
  for (const raw of payload["limits"]) {
    if (!isRecord(raw) || typeof raw["limit_type"] !== "string" || raw["limit_type"].trim() === "") {
      throw new BridgeError("malformedPayload", "Nekos limit requires a limit_type");
    }
    if (raw["limit_type"] !== "cost_usd") continue;
    const period = raw["limit_window"];
    let periodLabel: string;
    switch (period) {
      case "3h": periodLabel = "3시간"; break;
      case "daily": periodLabel = "일간"; break;
      case "weekly": periodLabel = "주간"; break;
      default: throw new BridgeError("malformedPayload", "Nekos cost limit has an unsupported window");
    }
    const percent = raw["used_percent"];
    const model = raw["model_filter"];
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0
      || (model !== null && (typeof model !== "string" || model.trim() === "" || !model.isWellFormed()))) {
      throw new BridgeError("malformedPayload", "Nekos cost limit has an invalid percentage or model scope");
    }
    const id = `nekos:cost_usd:${period}:${model === null ? "global" : `model:${encodeURIComponent(model)}`}`;
    if (ids.has(id)) {
      throw new BridgeError("malformedPayload", "Nekos usage contains duplicate quota IDs");
    }
    ids.add(id);
    const reset = raw["reset_at"];
    let resetsAtMs: number | undefined;
    if (typeof reset === "string" && ZONED_TIMESTAMP.test(reset)) {
      const date = reset.slice(0, 10);
      const calendarMs = Date.parse(`${date}T00:00:00Z`);
      const timestampMs = Date.parse(reset);
      if (Number.isFinite(calendarMs) && Number.isFinite(timestampMs)
        && new Date(calendarMs).toISOString().slice(0, 10) === date) {
        resetsAtMs = timestampMs;
      }
    }
    const resolvedFraction = percent / 100;
    windows.push({ id, label: `${model ?? "전체"} · ${periodLabel}`, unit: "percent",
      resolvedFraction, severity: severityForFraction(resolvedFraction),
      ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
    });
  }
  return windows;
}
