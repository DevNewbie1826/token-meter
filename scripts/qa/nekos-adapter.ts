import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import sample from "../../bridge/fixtures/nekos-usage.json";
import { loginNekos, nekosConnector } from "../../bridge/src/providers/nekos";
import { registerAuth } from "../../bridge/src/dispatch";
import type { Fetcher } from "../../bridge/src/dispatch";
import { runLoginSession } from "../../bridge/src/cli";
import { BridgeError, parseBridgeRequest, PROTOCOL_VERSION, redactSecrets } from "../../bridge/src/protocol";
import type { BridgeRequest, BridgeErrorPayload } from "../../bridge/src/protocol";

// Only the HTTP transport is replaced. Both production exports retain their
// real parsing, auth validation, shared HTTP errors, and wire severity behavior.
const fixtureFetcher: Fetcher = async (url, init) => {
  assert.equal(url, "https://claude.nekos.me/v1/usage/self");
  assert.equal(init.method, "GET");
  assert.ok(new Headers(init.headers).get("x-api-key"));
  assert.equal(new Headers(init.headers).get("anthropic-version"), "2023-06-01");
  return Response.json(sample);
};

async function serve(command: "login" | "usage"): Promise<number> {
  switch (command) {
    case "login": {
      registerAuth({ providerId: "nekos", methods: ["apiKey"],
        login: (method, inputs, events, signal) => loginNekos(method, inputs, events, signal, { fetcher: fixtureFetcher }) });
      const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
      const iterator = reader[Symbol.asyncIterator]();
      return await runLoginSession({
        readLine: async () => { const line = await iterator.next(); return line.done ? undefined : line.value; },
        writeOutput: line => process.stdout.write(`${line}\n`),
        writeEvent: line => process.stderr.write(`${line}\n`), closeInput: () => reader.close(),
      });
    }
    case "usage": {
      const request = parseBridgeRequest(await Bun.stdin.text());
      const response = await nekosConnector.fetchUsage({ request, fetcher: fixtureFetcher, nowMs: Date.now() });
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return 0;
    }
    default: throw new BridgeError("invalidRequest", command satisfies never);
  }
}

async function probe(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true });
  const secret = crypto.randomUUID();
  const nowMs = 1787011200500;
  const request: BridgeRequest = {
    schemaVersion: PROTOCOL_VERSION, requestId: "nekos-public-qa", operation: "fetchUsage",
    providerId: "nekos", connectorId: "builtin-nekos", accountRef: "qa:nekos",
    requestedAtMs: nowMs, deadlineAtMs: nowMs + 30000, credential: { kind: "apiKey", secret },
  };
  const calls: { readonly url: string; readonly method: string; readonly keyPresent: boolean; readonly version: string | null }[] = [];
  const recordingFetcher: Fetcher = async (url, init) => {
    const headers = new Headers(init.headers);
    assert.ok(headers.get("x-api-key") === secret, "fixture key header mismatch");
    calls.push({ url, method: init.method ?? "", keyPresent: true, version: headers.get("anthropic-version") });
    return await fixtureFetcher(url, init);
  };
  // Given raw supplied fixture; When real auth then usage exports execute.
  const auth = await loginNekos("apiKey", { apiKey: secret }, { onEvent: () => undefined },
    new AbortController().signal, { fetcher: recordingFetcher });
  assert.ok(auth.credential.kind === "apiKey" && auth.credential.secret === secret, "fixture login key mismatch");
  const response = await nekosConnector.fetchUsage({ request, fetcher: recordingFetcher, nowMs });
  // Then five separate machine-consumed windows, no inferred monetary units.
  assert.deepEqual(response.report.windows.map(row => row.resolvedFraction), [0, 0, 18.39 / 100, 0, 33.55 / 100]);
  assert.equal(new Set(response.report.windows.map(row => row.id)).size, 5);
  assert.ok(response.report.windows.every(row => row.unit === "percent" && row.severity === "ok" && row.resetsAtMs === undefined));
  await Bun.write(join(directory, "nekos-adapter.json"), `${JSON.stringify(response, null, 2)}\n`);
  await Bun.write(join(directory, "nekos-http.json"), `${JSON.stringify({ source: "recording fixture HTTP transport, not live upstream", calls }, null, 2)}\n`);
  const errors: { readonly scenario: string; readonly error: BridgeErrorPayload }[] = [];
  for (const [status, kind] of [[401, "authRequired"], [403, "permissionDenied"], [429, "rateLimited"]] as const) {
    try {
      await nekosConnector.fetchUsage({ request, nowMs,
        fetcher: async () => new Response(secret, { status, headers: { "retry-after": "30" } }) });
      assert.fail(`HTTP ${status} did not fail`);
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      assert.equal(error.kind, kind);
      if (status === 429) assert.equal(error.retryAfterMs, 30000);
      errors.push({ scenario: `HTTP ${status}`, error: { kind: error.kind,
        message: redactSecrets(error.message, [secret]),
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }) } });
    }
  }
  for (const [body, kind] of [["{}", "malformedPayload"], ["{\"limits\":[]}", "noData"]] as const) {
    try {
      await nekosConnector.fetchUsage({ request, nowMs, fetcher: async () => new Response(body) });
      assert.fail("invalid fixture did not fail");
    } catch (error) {
      if (!(error instanceof BridgeError)) throw error;
      assert.equal(error.kind, kind);
      errors.push({ scenario: kind, error: { kind: error.kind, message: error.message } });
    }
  }
  const encoded = JSON.stringify({ source: "injected HTTP failures, not live upstream", errors }, null, 2);
  assert.ok(!encoded.includes(secret));
  await Bun.write(join(directory, "nekos-errors.json"), `${encoded}\n`);
  console.log("PASS: actual Nekos auth/adapter exports; 5 windows, 5 typed failures; fixture-backed only");
}

const [command] = process.argv.slice(2);
if (command === "login" || command === "usage") {
  process.exitCode = await serve(command);
} else if (command !== undefined) {
  await probe(command);
} else {
  throw new BridgeError("invalidRequest", "usage: bun scripts/qa/nekos-adapter.ts <evidence-directory>");
}
