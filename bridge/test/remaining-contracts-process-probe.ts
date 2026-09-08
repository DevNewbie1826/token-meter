/** Test-only actual-adapter process surface. Never imported by the release CLI. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureEnvelope } from "../src/cli";
import { lookupConnector } from "../src/dispatch";
import { BridgeError, encodeBridgeResponse, isRecord, parseBridgeRequest } from "../src/protocol";
import type { BridgeRequest } from "../src/protocol";

const owned = new Set(["google-gemini-cli", "alibaba-token-plan", "kimi-code", "minimax-code", "ollama", "ollama-cloud", "synthetic", "umans"]);
const directory = mkdtempSync(join(tmpdir(), "remaining-process-"));
process.env["PI_CODING_AGENT_DIR"] = directory;
let request: BridgeRequest | undefined;
let calls = 0;
try {
  const input: unknown = JSON.parse(await Bun.stdin.text());
  if (!isRecord(input) || !Array.isArray(input["routes"])) throw new BridgeError("invalidRequest", "probe requires routes");
  request = parseBridgeRequest(JSON.stringify(input["request"]));
  if (!owned.has(request.providerId)) throw new BridgeError("invalidProvider", "outside probe scope");
  const connector = lookupConnector(request.providerId);
  if (connector === undefined) throw new BridgeError("invalidProvider", "unregistered provider");
  const routes = input["routes"];
  const response = await connector.fetchUsage({ request, nowMs: request.requestedAtMs, fetcher: async (url, init) => {
    const route: unknown = routes[calls++];
    if (!isRecord(route) || route["url"] !== url || route["method"] !== (init.method ?? "GET")) {
      throw new BridgeError("invalidRequest", "unexpected fixture HTTP route");
    }
    if (typeof route["status"] !== "number") throw new BridgeError("invalidRequest", "invalid fixture status");
    const headers = new Headers(init.headers);
    if (request?.providerId === "alibaba-token-plan" && (headers.get("cookie") === null || headers.has("authorization"))) {
      throw new BridgeError("invalidRequest", "Alibaba browser-session auth changed");
    }
    // No network delegation: every HTTP result is constructed from stdin fixtures.
    return new Response(JSON.stringify(route["body"]), { status: route["status"] });
  } });
  if (calls !== routes.length) throw new BridgeError("invalidRequest", "unused fixture HTTP routes");
  process.stdout.write(encodeBridgeResponse(response));
} catch (error) {
  process.stdout.write(encodeBridgeResponse(failureEnvelope(request, error)));
  process.exitCode = 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
  process.stderr.write(JSON.stringify({ calls, cleanup: true }) + "\n");
}
