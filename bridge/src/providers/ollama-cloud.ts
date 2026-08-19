/**
 * Ported from OMP packages/ai/src/registry/ollama-cloud.ts and
 * packages/ai/src/usage/ollama.ts @ 8500092296621a6826b7136e840f8a59ea338958.
 * Usage intentionally makes no network request: Ollama Cloud exposes no quota API.
 */
import type { ConnectorModule, AuthModule, AuthMethod, LoginInputs, AuthEvents } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION } from "../protocol";
import type { BridgeCredential, BridgeSuccessResponse } from "../protocol";

const PROVIDER_ID = "ollama-cloud";
const CONNECTOR_VERSION = "ollama-cloud-1";
const KEYS_URL = "https://ollama.com/settings/keys";

function cancelled(): never {
  throw new BridgeError("timeout", "Ollama Cloud login was cancelled");
}

export const ollamaCloudConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, nowMs }) : Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    if (request.credential === undefined) {
      throw new BridgeError("missingCredential", "ollama-cloud usage requires a credential");
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
        productKind: "localActivity",
        sourceKind: "noQuotaApi",
        fetchedAtMs: nowMs,
        connectorVersion: CONNECTOR_VERSION,
        windows: [],
      },
    };
  },
};

export const ollamaCloudAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  async login(method: AuthMethod, inputs: LoginInputs, events: AuthEvents, signal: AbortSignal) {
    if (signal.aborted) cancelled();
    if (method !== "apiKey") {
      throw new BridgeError("invalidRequest", "Ollama Cloud supports API-key login only");
    }
    events.onEvent({ type: "openUrl", url: KEYS_URL });
    events.onEvent({ type: "pasteHint", detail: "Create an Ollama Cloud API key, then paste it here." });
    if (signal.aborted) cancelled();
    const secret = inputs.apiKey?.trim() ?? "";
    if (!secret) {
      throw new BridgeError("invalidRequest", "Ollama Cloud API key is required");
    }
    const credential: BridgeCredential = { kind: "apiKey", secret };
    return { credential };
  },
};
