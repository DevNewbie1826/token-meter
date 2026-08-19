/**
 * Ollama provider, hand-ported from OMP packages/ai/src/registry/ollama.ts
 * and packages/ai/src/usage/ollama.ts @ 8500092296621a6826b7136e840f8a59ea338958.
 *
 * Login mirrors OMP loginOllama: the API key is optional — a missing or blank
 * key (OMP's `if (!options.onPrompt) return ""` and its allowEmpty prompt
 * answer) means local no-auth and maps to the honest `{kind:"none"}`
 * credential, never a fabricated secret. A supplied key is trimmed exactly
 * like OMP's `apiKey.trim()`. No prompt round-trip is required: a login
 * request without an apiKey input completes immediately as local no-auth,
 * matching OMP's non-interactive callers.
 *
 * Usage exposes no standalone quota API (OMP registers ollama with
 * validatesCredentials: false and a notes-only report); the connector answers
 * the exact noQuotaApi empty report without network access for both the none
 * and apiKey credentials.
 */
import type { ConnectorModule, AuthModule, LoginInputs, AuthEvents, LoginResult, AuthMethod } from "../dispatch";
import { BridgeError, PROTOCOL_VERSION } from "../protocol";
import type { BridgeSuccessResponse } from "../protocol";

const PROVIDER_ID = "ollama";
const CONNECTOR_VERSION = "ollama-1";

export const ollamaConnector: ConnectorModule = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, nowMs }): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    if (request.credential === undefined) {
      throw new BridgeError("missingCredential", "ollama usage requires a credential");
    }
    // Both `{kind:"none"}` (local no-auth) and apiKey credentials report the
    // same honest empty report; no request is made either way.
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

export const ollamaAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  async login(
    method: AuthMethod,
    inputs: LoginInputs,
    _events: AuthEvents,
    signal: AbortSignal,
  ): Promise<LoginResult> {
    if (signal.aborted) {
      throw new BridgeError("timeout", "Ollama login cancelled");
    }
    if (method !== "apiKey") {
      throw new BridgeError("invalidPolicy", "Ollama supports only apiKey login");
    }
    const apiKey = (inputs.apiKey ?? "").trim();
    if (apiKey === "") {
      // OMP returns "" for local no-auth; the bridge's honest equivalent is
      // the none credential — no fabricated local-noauth secret.
      return { credential: { kind: "none" }, accountLabel: "Local (no key)" };
    }
    return { credential: { kind: "apiKey", secret: apiKey } };
  },
};
