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
    const body = response(200, { ok: true });
    const result = await call(async () => body);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("json");
    expect(body.bodyUsed).toBe(false);
    expect(await result.json()).toEqual({ ok: true });
    expect(body.bodyUsed).toBe(true);
  });

  test.each([undefined, "follow", "manual", "error"] as const)("honors redirect policy %s with real fetch", async (redirect) => {
    const paths: string[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      return path === "/redirect"
        ? new Response(null, { status: 302, headers: { location: "/target" } })
        : Response.json({ ok: true });
    } });
    try {
      const pending = call(fetch, {
        call: { url: new URL("/redirect", server.url).href, ...(redirect === undefined ? {} : { redirect }) },
        signal: AbortSignal.timeout(2000),
        acceptedStatuses: [302],
      });
      if (redirect === "error") {
        const error = await errorOf(pending);
        expect(error).toBeInstanceOf(BridgeError);
        expect(error.kind).toBe("transport");
        expect(paths).toEqual(["/redirect"]);
      } else {
        const result = await pending;
        if (redirect === "manual") {
          expect(result.status).toBe(302);
          expect(result.headers.get("location")).toBe("/target");
          expect(paths).toEqual(["/redirect"]);
        } else {
          expect(result.status).toBe(200);
          expect(await result.json()).toEqual({ ok: true });
          expect(paths).toEqual(["/redirect", "/target"]);
        }
      }
    } finally {
      await server.stop(true);
      expect(server.pendingRequests).toBe(0);
    }
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

  test.each(["AbortError", "TimeoutError"])("maps DOMException %s to timeout and redacts secrets", async (name) => {
    const error = await errorOf(call(async () => {
      throw new DOMException("token-secret failed", name);
    }, { extraSecrets: ["token-secret"] }));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("token-secret");
  });

  test.each(["AbortError", "TimeoutError"])("classifies real in-flight fetch cancellation with %s", async (name) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() {
      started.resolve();
      await release.promise;
      return Response.json({ ok: true });
    } });
    const deadline = setTimeout(() => controller.abort(new Error("test deadline exceeded")), 2000);
    try {
      const pending = errorOf(call(fetch, { call: { url: server.url.href }, signal: controller.signal }));
      await Promise.race([started.promise, pending.then(() => { throw new Error("request settled before cancellation"); })]);
      controller.abort(new DOMException("cancelled", name));
      const error = await pending;
      expect(error).toBeInstanceOf(BridgeError);
      expect(error.kind).toBe("timeout");
    } finally {
      clearTimeout(deadline);
      controller.abort();
      release.resolve();
      await server.stop(true);
      expect(server.pendingRequests).toBe(0);
    }
  });

  test.each(["AbortError", "TimeoutError"])("classifies real deferred JSON cancellation with %s", async (name) => {
    const received = Promise.withResolvers<Response>();
    const expired = Promise.withResolvers<never>();
    const controller = new AbortController();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new TextEncoder().encode('{"pending":'));
      } }), { headers: { "content-type": "application/json" } });
    } });
    const deadline = setTimeout(() => expired.reject(new Error("test deadline exceeded")), 2000);
    try {
      const result = await Promise.race([call(async (url, init) => {
        const body = await fetch(url, init);
        received.resolve(body);
        return body;
      }, { call: { url: server.url.href }, signal: controller.signal, extraSecrets: ["token-secret"] }), expired.promise]);
      const body = await received.promise;
      expect(result.status).toBe(200);
      expect(body.bodyUsed).toBe(false);
      const pending = errorOf(result.json());
      expect(body.bodyUsed).toBe(true);
      controller.abort(new DOMException("token-secret cancelled", name));
      const error = await Promise.race([pending, expired.promise]);
      expect(error).toBeInstanceOf(BridgeError);
      expect(error.kind).toBe("timeout");
      expect(error.message).not.toContain("token-secret");
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await server.stop(true);
      expect(server.pendingRequests).toBe(0);
    }
  });

  test("maps network failures to transport", async () => {
    const error = await errorOf(call(async () => { throw new Error("token-secret offline"); }, { extraSecrets: ["token-secret"] }));
    expect(error.kind).toBe("transport");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("token-secret");
  });

  test("throws malformedPayload only when JSON is read", async () => {
    const result = await call(async () => new Response("not json", { status: 200 }));
    expect(result.status).toBe(200);
    const error = await errorOf(result.json());
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("usage endpoint");
  });
});
