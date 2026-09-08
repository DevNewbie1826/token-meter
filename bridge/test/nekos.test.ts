import { expect, test } from "bun:test";
import "../src/providers/index";
import { lookupConnector } from "../src/dispatch";
import { runLoginSession } from "../src/cli";
import { loginNekos, nekosAuth, nekosConnector } from "../src/providers/nekos";
import { BridgeError } from "../src/protocol";
import type { Fetcher } from "../src/connectors/provider-http";
import { buildLoginRequest, buildUsageRequest, readFixtureSource } from "./helpers";

const NOW = 1787011200500;
const KEY = "nekos-fixture-only-key";
const URL = "https://claude.nekos.me/v1/usage/self";
const request = buildUsageRequest({ providerId: "nekos", connectorId: "nekos", credential: { kind: "apiKey", secret: KEY } });
const sample = readFixtureSource("nekos-usage.json");

async function usage(fetcher: Fetcher) {
  const connector = lookupConnector("nekos");
  if (connector === undefined) throw new BridgeError("invalidProvider", "No Nekos usage connector registered");
  return await connector.fetchUsage({ request, fetcher, nowMs: NOW });
}

test("returns five independent quota fractions when dispatched with the supplied sample", async () => {
  // Given
  const fetcher: Fetcher = async () => new Response(sample);
  // When
  const result = await usage(fetcher);
  // Then
  expect(result.report.windows.map(row => row.resolvedFraction)).toEqual([0, 0, 18.39 / 100, 0, 33.55 / 100]);
});

test("returns invalidRequest through the CLI auth route when the key is blank", async () => {
  // Given
  const input = JSON.stringify(buildLoginRequest({ providerId: "nekos", inputs: { apiKey: "   " },
    requestedAtMs: Date.now(), deadlineAtMs: Date.now() + 10000 }));
  const lines = [input];
  const output: string[] = [];
  // When
  const exitCode = await runLoginSession({
    readLine: async () => lines.shift(), writeOutput: line => { output.push(line); },
    writeEvent: () => undefined, closeInput: () => undefined,
  });
  // Then
  expect(exitCode).toBe(1);
  const result: unknown = JSON.parse(output.join(""));
  expect(result).toMatchObject({ providerId: "nekos", status: "error", error: { kind: "invalidRequest" } });
});

const baseRow = { limit_type: "cost_usd", limit_window: "daily", model_filter: null, used_percent: 0 } as const;
const bodyFetcher = (body: unknown): Fetcher => async () => Response.json(body);
const authEvents: import("../src/dispatch").AuthEvents = { onEvent: () => undefined };
const login = (fetcher: Fetcher, signal = new AbortController().signal) =>
  loginNekos("apiKey", { apiKey: `  ${KEY}  ` }, authEvents, signal, { fetcher });

for (const [operation, execute] of [["usage", usage], ["login", login]] as const) {
  test(`sends the required authenticated GET when ${operation} receives a valid payload`, async () => {
    // Given
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    const fetcher: Fetcher = async (url, init) => { calls.push({ url, init }); return new Response(sample); };
    // When
    await execute(fetcher);
    // Then
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(URL);
    expect(call?.init.method).toBe("GET");
    expect(call?.init.body).toBeUndefined();
    const headers = new Headers(call?.init.headers);
    expect(headers.get("x-api-key")).toBe(KEY);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("authorization")).toBeNull();
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });
  for (const [status, kind] of [[401, "authRequired"], [403, "permissionDenied"], [429, "rateLimited"], [500, "upstreamError"]] as const) {
    test(`returns ${kind} when ${operation} receives HTTP ${status}`, async () => {
      // Given
      const fetcher: Fetcher = async () => new Response(KEY, { status, headers: { "retry-after": "30" } });
      // When
      const result = execute(fetcher);
      // Then
      await expect(result).rejects.toMatchObject({ kind, ...(status === 429 ? { retryAfterMs: 30000 } : {}) });
      await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining(KEY));
    });
  }
  for (const malformed of [null, {}, { limits: null }, { limits: [null] }, { limits: [{}] },
    { limits: [baseRow, { ...baseRow, used_percent: "95" }] },
    { limits: [{ ...baseRow, used_percent: -1 }] }, { limits: [{ ...baseRow, used_percent: null }] },
    { limits: [{ ...baseRow, used_percent: undefined }] }, { limits: [{ ...baseRow, model_filter: undefined }] },
    { limits: [{ ...baseRow, model_filter: "fable" }, { ...baseRow, model_filter: "fable" }] },
    { limits: [{ ...baseRow, limit_window: "monthly" }] }, { limits: [{ ...baseRow, limit_window: null }] },
    { limits: [{ ...baseRow, model_filter: " " }] }, { limits: [{ ...baseRow, model_filter: 42 }] },
    { limits: [{ ...baseRow, model_filter: "\ud800" }] }, { limits: [baseRow, baseRow] }]) {
    test(`returns malformedPayload when ${operation} receives invalid or duplicate rows: ${JSON.stringify(malformed)}`, async () => {
      // Given
      const fetcher = bodyFetcher(malformed);
      // When
      const result = execute(fetcher);
      // Then
      await expect(result).rejects.toMatchObject({ kind: "malformedPayload" });
    });
  }
  test(`returns malformedPayload when ${operation} receives invalid JSON`, async () => {
    // Given
    const fetcher: Fetcher = async () => new Response("not-json");
    // When
    const result = execute(fetcher);
    // Then
    await expect(result).rejects.toMatchObject({ kind: "malformedPayload" });
  });
  test(`rejects nonfinite percentages when ${operation} receives a JSON numeric overflow`, async () => {
    // Given: JSON.parse accepts 1e999 as Infinity; JSON.stringify changes Infinity to null.
    const fetcher: Fetcher = async () => new Response('{"limits":[{"limit_type":"cost_usd","limit_window":"daily","model_filter":null,"used_percent":1e999}]}');
    // When
    const result = execute(fetcher);
    // Then
    await expect(result).rejects.toMatchObject({ kind: "malformedPayload" });
  });
  test(`redacts transport details when ${operation} fails with a credential-bearing error`, async () => {
    // Given
    const fetcher: Fetcher = async () => { throw new TypeError(`request failed: ${KEY}`); };
    // When
    const result = execute(fetcher);
    // Then
    await expect(result).rejects.toMatchObject({ kind: "transport" });
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining(KEY));
  });
}

test("preserves labeled percent-only rows when the sample contains scaled costs and lifetime totals", async () => {
  // Given
  const fetcher: Fetcher = async () => new Response(sample);
  // When
  const result = await usage(fetcher);
  // Then: shipped-copy values; no extra USD, model-catalog or lifetime fields.
  expect(result).toEqual({ schemaVersion: "1.3.0", requestId: request.requestId, providerId: "nekos",
    connectorId: "nekos", accountRef: request.accountRef, status: "ok", completedAtMs: NOW,
    report: { productKind: "quota", sourceKind: "firstPartyApi", fetchedAtMs: NOW, connectorVersion: "nekos-1", windows: [
      { id: "nekos:cost_usd:3h:global", label: "전체 · 3시간", unit: "percent", resolvedFraction: 0, severity: "ok" },
      { id: "nekos:cost_usd:daily:global", label: "전체 · 일간", unit: "percent", resolvedFraction: 0, severity: "ok" },
      { id: "nekos:cost_usd:weekly:global", label: "전체 · 주간", unit: "percent", resolvedFraction: 0.1839, severity: "ok" },
      { id: "nekos:cost_usd:daily:model:fable", label: "fable · 일간", unit: "percent", resolvedFraction: 0, severity: "ok" },
      { id: "nekos:cost_usd:weekly:model:fable", label: "fable · 주간", unit: "percent", resolvedFraction: 33.55 / 100, severity: "ok" },
    ] } });
});
for (const [percent, severity] of [[0, "ok"], [79.99, "ok"], [80, "warning"], [94.99, "warning"], [95, "critical"], [100, "exhausted"], [125, "exhausted"]] as const) {
  test(`preserves fraction and shared severity when used_percent is ${percent}`, async () => {
    // Given
    const fetcher = bodyFetcher({ limits: [{ ...baseRow, used_percent: percent }] });
    // When
    const result = await usage(fetcher);
    // Then
    expect(result.report.windows[0]).toMatchObject({ resolvedFraction: percent / 100, severity });
  });
}
for (const reset_at of [undefined, null, 42, "", "2026-09-07T03:50:09.957777", "2026-02-30T03:00:00Z", "2026-09-07T24:00:00Z", "invalidZ", "2026-09-07T03:50:09+25:00"]) {
  test(`omits reset when the timestamp is absent, ambiguous or invalid: ${reset_at}`, async () => {
    // Given
    const fetcher = bodyFetcher({ limits: [{ ...baseRow, reset_at }] });
    // When
    const result = await usage(fetcher);
    // Then
    expect(result.report.windows[0]).not.toHaveProperty("resetsAtMs");
  });
}
for (const reset_at of ["2026-09-07T03:50:09.957777Z", "2026-09-07T12:50:09.957777+09:00", "2026-09-06T23:50:09.957777-04:00"]) {
  test(`preserves integer millisecond reset when the timestamp has an explicit timezone: ${reset_at}`, async () => {
    // Given
    const fetcher = bodyFetcher({ limits: [{ ...baseRow, reset_at }] });
    // When
    const result = await usage(fetcher);
    // Then
    expect(result.report.windows[0]?.resetsAtMs).toBe(1788753009957);
    expect(result.report.windows[0]?.id).toBe("nekos:cost_usd:daily:global");
  });
}
test("keeps stable collision-resistant IDs when models resemble global scope or encoded delimiters", async () => {
  // Given
  const limits = [null, "global", "a:b", "a%3Ab", "전체"].map(model_filter => ({ ...baseRow, model_filter }));
  // When
  const results = await Promise.all([usage(bodyFetcher({ limits })), usage(bodyFetcher({ limits: limits.toReversed() }))]);
  // Then
  expect(results[0]?.report.windows.map(row => row.id)).toEqual(["nekos:cost_usd:daily:global",
    "nekos:cost_usd:daily:model:global", "nekos:cost_usd:daily:model:a%3Ab", "nekos:cost_usd:daily:model:a%253Ab", "nekos:cost_usd:daily:model:%EC%A0%84%EC%B2%B4"]);
  expect(results[1]?.report.windows.map(row => row.id).toReversed()).toEqual(results[0]?.report.windows.map(row => row.id));
});
for (const limits of [[], [{ limit_type: "tokens" }]]) {
  test(`returns noData when usage has no supported limits: ${JSON.stringify(limits)}`, async () => {
    // Given
    const fetcher = bodyFetcher({ limits });
    // When
    const result = usage(fetcher);
    // Then
    await expect(result).rejects.toMatchObject({ kind: "noData" });
  });
  test(`authenticates a trimmed key when valid usage has no supported limits: ${JSON.stringify(limits)}`, async () => {
    // Given
    const fetcher = bodyFetcher({ limits });
    // When
    const result = await login(fetcher);
    // Then
    expect(result).toEqual({ credential: { kind: "apiKey", secret: KEY } });
  });
}
for (const method of ["browser", "device"] as const) {
  test(`rejects unsupported auth when method is ${method}`, async () => {
    // Given / When
    const result = nekosAuth.login(method, {}, authEvents, new AbortController().signal);
    // Then
    await expect(result).rejects.toMatchObject({ kind: "invalidRequest" });
  });
}
test("makes no HTTP call when login is already cancelled", async () => {
  // Given
  let calls = 0;
  const fetcher: Fetcher = async () => { calls++; return new Response(sample); };
  // When
  const result = login(fetcher, AbortSignal.abort());
  // Then
  await expect(result).rejects.toMatchObject({ kind: "timeout" });
  expect(calls).toBe(0);
});
for (const phase of ["request", "body"] as const) {
  test(`returns timeout when login is cancelled during the ${phase}`, async () => {
    // Given: subscribe before action; Bun's test deadline bounds the signal wait.
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    const releaseRequest = Promise.withResolvers<Response>();
    const releaseBody = Promise.withResolvers<void>();
    const fetcher: Fetcher = async () => {
      switch (phase) {
        case "request": started.resolve(); return await releaseRequest.promise;
        case "body": return new Response(new ReadableStream({ async pull(stream) {
          started.resolve(); await releaseBody.promise; stream.close();
        } }, { highWaterMark: 0 }));
        default: throw new Error(phase satisfies never);
      }
    };
    // When
    const result = login(fetcher, controller.signal);
    await started.promise;
    controller.abort(new Error("cancelled"));
    // Then
    try {
      await expect(result).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      releaseRequest.resolve(new Response(sample));
      releaseBody.resolve();
    }
  }, 1000);
}
test("returns timeout without HTTP when usage has an expired deadline", async () => {
  // Given
  let calls = 0;
  const fetcher: Fetcher = async () => { calls++; return new Response(sample); };
  // When
  const result = nekosConnector.fetchUsage({ request: { ...request, deadlineAtMs: NOW }, fetcher, nowMs: NOW });
  // Then
  await expect(result).rejects.toMatchObject({ kind: "timeout" });
  expect(calls).toBe(0);
});

for (const credential of [undefined, { kind: "none" }, { kind: "bearer", secret: KEY }, { kind: "oauth", secret: KEY, oauth: { access: KEY } }] as const) {
  test(`rejects unusable credentials before HTTP when usage receives ${credential?.kind ?? "absent"}`, async () => {
    // Given
    const { credential: _credential, ...identity } = request;
    let calls = 0;
    const fetcher: Fetcher = async () => { calls++; return new Response(sample); };
    // When
    const result = nekosConnector.fetchUsage({ request: { ...identity, ...(credential === undefined ? {} : { credential }) }, fetcher, nowMs: NOW });
    // Then
    await expect(result).rejects.toMatchObject({ kind: "missingCredential" });
    expect(calls).toBe(0);
  });
}
for (const status of [200, 403]) {
  test(`uses the real HTTP boundary when a fixture server returns ${status}`, async () => {
    // Given: real loopback HTTP, ephemeral port, no global fetch replacement.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(incoming) {
      expect(incoming.headers.get("x-api-key")).toBe(KEY);
      expect(incoming.headers.get("anthropic-version")).toBe("2023-06-01");
      return new Response(sample, { status });
    } });
    const fetcher: Fetcher = async (_url, init) => await fetch(server.url, init);
    try {
      // When
      const result = usage(fetcher);
      // Then
      if (status === 200) expect((await result).report.windows).toHaveLength(5);
      else await expect(result).rejects.toMatchObject({ kind: "permissionDenied" });
    } finally { await server.stop(true); }
  });
}
