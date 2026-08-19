import { describe, expect, test } from "bun:test";
import { BridgeError } from "../src/protocol-core";
import { callProviderHttp, type Fetcher } from "../src/connectors/provider-http";

const signal = new AbortController().signal;
const response = (status: number, body: unknown = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const call = (fetcher: Fetcher, options: Partial<Parameters<typeof callProviderHttp>[0]> = {}) =>
  callProviderHttp({ call: { url: "https://provider.test/usage" }, fetcher, signal, endpointLabel: "usage endpoint", ...options });

function errorOf(promise: Promise<unknown>): Promise<BridgeError> {
  return promise.then(() => { throw new Error("expected failure"); }, (error) => error as BridgeError);
}

describe("callProviderHttp", () => {
  test("returns status, headers, and deferred JSON", async () => {
    const result = await call(async () => response(200, { ok: true }));
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("json");
    expect(await result.json()).toEqual({ ok: true });
  });

  test.each([
    [401, "authRequired"],
    [403, "permissionDenied"],
    [500, "upstreamError"],
    [503, "upstreamError"],
  ] as const)("maps HTTP %d to %s", async (status, kind) => {
    const error = await errorOf(call(async () => response(status)));
    expect(error.kind).toBe(kind);
    expect(error.message).toContain("usage endpoint");
  });

  test("maps 429 and parses Retry-After seconds as milliseconds", async () => {
    const error = await errorOf(call(async () => new Response("", { status: 429, headers: { "retry-after": "1.25" } })));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(1250);
  });

  test("allows a status map override", async () => {
    const error = await errorOf(call(async () => response(401), { statusMap: { 401: "permissionDenied" } }));
    expect(error.kind).toBe("permissionDenied");
  });

  test("maps AbortError to timeout and redacts secrets", async () => {
    const error = await errorOf(call(async () => {
      throw Object.assign(new Error("token-secret failed"), { name: "AbortError" });
    }, { extraSecrets: ["token-secret"] }));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("token-secret");
  });

  test("maps network failures to transport", async () => {
    const error = await errorOf(call(async () => { throw new Error("offline"); }));
    expect(error.kind).toBe("transport");
  });

  test("throws malformedPayload only when JSON is read", async () => {
    const result = await call(async () => new Response("not json", { status: 200 }));
    expect(result.status).toBe(200);
    const error = await errorOf(result.json());
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("usage endpoint");
  });
});
