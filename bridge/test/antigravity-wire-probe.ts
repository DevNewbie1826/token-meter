// Test-only compiled process: real adapter + protocol, fixture HTTP boundary only.
import assert from "node:assert/strict";
import summary from "../fixtures/antigravity-summary.json";
import remaining from "../fixtures/antigravity-remaining.json";
import boundaries from "../fixtures/antigravity-boundaries.json";
import { fetchAntigravityUsage } from "../src/providers/google-antigravity";
import { BridgeError, encodeBridgeResponse, parseBridgeRequest, PROTOCOL_VERSION } from "../src/protocol";

const request = parseBridgeRequest(await Bun.stdin.text());
const scenario = request.accountRef;
const boundary = Object.entries(boundaries).find(([name]) => name === scenario)?.[1];
assert(boundary !== undefined || ["remaining", "disabled", "legacy", "grouped"].includes(scenario), "unknown scenario");
const calls: string[] = [];
const summaryPath = "/v1internal:retrieveUserQuotaSummary";
const legacyPath = "/v1internal:fetchAvailableModels";
const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
  if (init.method !== "POST") throw new Error("unexpected probe method");
  assert(request.credential?.kind === "oauth");
  assert(new Headers(init.headers).get("Authorization") === `Bearer ${request.credential.oauth.access}`, "incorrect auth header");
  assert(JSON.parse(String(init.body)).project === "synthetic-project", "incorrect project body");
  assert(new URL(url).origin === "https://daily-cloudcode-pa.googleapis.com", "unexpected probe origin");
  calls.push(new URL(url).pathname);
  if (url.endsWith(":retrieveUserQuotaSummary")) {
    return Response.json(boundary?.summary ?? (scenario === "remaining" ? remaining : scenario === "disabled"
      ? { buckets: [{ bucketId: "disabled", disabled: true, remainingFraction: 0 }] }
      : scenario === "legacy" ? {} : summary));
  }
  if (url.endsWith(":fetchAvailableModels")) {
    return Response.json(boundary?.legacy ?? { models: { fixture: { modelProvider: "MODEL_PROVIDER_GOOGLE",
      quotaInfo: { remainingFraction: 0.125, resetTime: "2026-08-18T05:00:00Z" } } } });
  }
  throw new Error("unexpected probe endpoint");
};
let output: string;
try {
  const response = await fetchAntigravityUsage({ request, fetcher, nowMs: request.requestedAtMs });
  output = encodeBridgeResponse(response);
} catch (error) {
  if (!(error instanceof BridgeError)) throw error;
  output = encodeBridgeResponse({
    schemaVersion: PROTOCOL_VERSION, requestId: request.requestId, providerId: request.providerId,
    connectorId: request.connectorId, accountRef: request.accountRef, status: "error",
    completedAtMs: request.requestedAtMs,
    error: { kind: error.kind, message: error.message,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) },
    ...(error.refreshedCredential !== undefined ? { refreshedCredential: error.refreshedCredential } : {}),
  });
}
const expectsLegacy = scenario === "legacy" || (boundary !== undefined && Object.keys(boundary.summary).length === 0);
assert.deepEqual(calls, expectsLegacy ? [summaryPath, legacyPath] : [summaryPath]);
process.stdout.write(`${output}\n`);
