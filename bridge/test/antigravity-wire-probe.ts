// Test-only compiled process: real adapter + protocol, fixture HTTP boundary only.
import summary from "../fixtures/antigravity-summary.json";
import remaining from "../fixtures/antigravity-remaining.json";
import { fetchAntigravityUsage } from "../src/providers/google-antigravity";
import { BridgeError, encodeBridgeResponse, parseBridgeRequest, PROTOCOL_VERSION } from "../src/protocol";

const request = parseBridgeRequest(await Bun.stdin.text());
const scenario = request.accountRef;
const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
  if (init.method !== "POST") throw new Error("unexpected probe method");
  if (url.endsWith(":retrieveUserQuotaSummary")) {
    return Response.json(scenario === "remaining" ? remaining : scenario === "disabled"
      ? { buckets: [{ bucketId: "disabled", disabled: true, remainingFraction: 0 }] }
      : scenario === "legacy" ? {} : summary);
  }
  if (url.endsWith(":fetchAvailableModels")) {
    return Response.json({ models: { fixture: { modelProvider: "MODEL_PROVIDER_GOOGLE",
      quotaInfo: { remainingFraction: 0.125, resetTime: "2026-08-18T05:00:00Z" } } } });
  }
  throw new Error("unexpected probe endpoint");
};
try {
  const response = await fetchAntigravityUsage({ request, fetcher, nowMs: request.requestedAtMs });
  process.stdout.write(`${encodeBridgeResponse(response)}\n`);
} catch (error) {
  if (!(error instanceof BridgeError)) throw error;
  process.stdout.write(`${encodeBridgeResponse({
    schemaVersion: PROTOCOL_VERSION, requestId: request.requestId, providerId: request.providerId,
    connectorId: request.connectorId, accountRef: request.accountRef, status: "error",
    completedAtMs: request.requestedAtMs,
    error: { kind: error.kind, message: error.message,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) },
    ...(error.refreshedCredential !== undefined ? { refreshedCredential: error.refreshedCredential } : {}),
  })}\n`);
}
