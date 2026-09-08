// Test-only compiled adapter surface. No release endpoint or storage overrides.
import { opencodeGoConnector } from "../../src/providers/opencode-go";
import { BridgeError, isRecord, parseBridgeRequest, PROTOCOL_VERSION } from "../../src/protocol";

process.stderr.write("ready\n");
const input: unknown = JSON.parse(await Bun.stdin.text());
if (!isRecord(input) || typeof input["endpoint"] !== "string" || typeof input["installationIdPath"] !== "string") {
  throw new Error("invalid probe input");
}
const endpoint = new URL(input["endpoint"]);
if (endpoint.hostname !== "127.0.0.1") throw new Error("probe only permits loopback");
const request = parseBridgeRequest(JSON.stringify(input["request"]));
const context = {
  request, nowMs: request.requestedAtMs, installationIdPath: input["installationIdPath"],
  fetcher: async (url: string, init: RequestInit) => {
    if (url !== "https://opencode.ai/zen/go/v1/usage") throw new Error("unexpected provider endpoint");
    return fetch(new URL(new URL(url).pathname, endpoint), init);
  },
};
try {
  console.log(JSON.stringify(await opencodeGoConnector.fetchUsage(context)));
} catch (error) {
  if (!(error instanceof BridgeError)) throw error;
  console.log(JSON.stringify({
    schemaVersion: PROTOCOL_VERSION, requestId: request.requestId,
    providerId: request.providerId, connectorId: request.connectorId, accountRef: request.accountRef,
    status: "error", completedAtMs: request.requestedAtMs,
    error: { kind: error.kind, message: error.message, ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) },
  }));
}
