/** Test-only compiled actual-adapter surface. No imports from the OMP runtime. */
import credits from "../fixtures/zai/credits.json";
import mixed from "../fixtures/zai/mixed.json";
import precision from "../fixtures/zai/precision.json";
import { fetchZaiUsage } from "../src/providers/zai";
import { BridgeError, encodeBridgeResponse, parseBridgeRequest, PROTOCOL_VERSION } from "../src/protocol";

const scenario = process.argv[2];
const payload = scenario === "credits" ? credits : scenario === "mixed" ? mixed : scenario === "precision" ? precision : undefined;
if (payload === undefined) throw new Error("expected credits, mixed, or precision scenario");
const request = parseBridgeRequest(await Bun.stdin.text());
try {
  const response = await fetchZaiUsage({
    request,
    nowMs: request.requestedAtMs,
    fetcher: async (url, init) => {
      if (url !== "https://api.z.ai/api/monitor/usage/quota/limit" || init.method !== "GET") {
        throw new Error("unexpected upstream request");
      }
      if (new Headers(init.headers).get("Authorization") !== request.credential?.secret) {
        throw new Error("raw authorization was not preserved");
      }
      return Response.json(payload);
    },
  });
  process.stdout.write(`${encodeBridgeResponse(response)}\n`);
} catch (error) {
  if (!(error instanceof BridgeError)) throw error;
  process.stdout.write(`${encodeBridgeResponse({
    schemaVersion: PROTOCOL_VERSION,
    requestId: request.requestId,
    providerId: request.providerId,
    connectorId: request.connectorId,
    accountRef: request.accountRef,
    completedAtMs: request.requestedAtMs,
    status: "error",
    error: { kind: error.kind, message: error.message },
  })}\n`);
  process.exitCode = 1;
}
