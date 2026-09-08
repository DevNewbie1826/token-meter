import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { opencodeGoAuth, opencodeGoConnector } from "../src/providers/opencode-go";
import { BridgeError } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import {
  buildLoginRequest,
  buildUsageRequest,
  expectNoModelFields,
  mockFetcher,
} from "./helpers";

const PROVIDER_ID = "opencode-go";
const CONNECTOR_VERSION = "opencode-go-1";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const AUTH_URL = "https://opencode.ai/auth";
const API_KEY = "sk-opencode-go-unit-test";
const NOW_MS = 1787011200500;

/** Live capture from OMP `GET /zen/go/v1/usage`, 2026-08-12. */
function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    usage: {
      rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
      weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
      monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-19T00:31:53.847Z" },
      ...overrides,
    },
  };
}

function usageRequest(overrides: Parameters<typeof buildUsageRequest>[0] = {}) {
  return buildUsageRequest({
    providerId: PROVIDER_ID,
    connectorId: PROVIDER_ID,
    credential: { kind: "apiKey", secret: API_KEY },
    ...overrides,
  });
}

let testRoot: string;
let installationIdPath: string;
beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), "opencode-test-"));
  installationIdPath = join(testRoot, "metadata", "opencode-install-id");
});
afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

function runFetch(fetcher: ReturnType<typeof mockFetcher>, request = usageRequest()) {
  const input = { request, fetcher, nowMs: NOW_MS, installationIdPath };
  return opencodeGoConnector.fetchUsage(input);
}

async function bridgeErrorFrom(action: () => Promise<unknown>): Promise<BridgeError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BridgeError) {
      return error;
    }
    throw new Error(`expected BridgeError, got ${String(error)}`);
  }
  throw new Error("expected BridgeError but the action succeeded");
}

describe("opencodeGoConnector", () => {
  test("maps the three OMP windows from GET /zen/go/v1/usage", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload() },
    });
    const response = await runFetch(fetcher);

    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected an upstream usage call");
    }
    expect(call.method).toBe("GET");
    expect(call.url).toBe(USAGE_URL);
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(call.init.body).toBeUndefined();

    expect(response.status).toBe("ok");
    expect(response.providerId).toBe(PROVIDER_ID);
    expect(response.connectorId).toBe(PROVIDER_ID);
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();

    const report = response.report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("firstPartyApi");
    expect(report.fetchedAtMs).toBe(NOW_MS);
    expect(report.connectorVersion).toBe(CONNECTOR_VERSION);
    expect(report.windows).toEqual([
      {
        id: "rolling-5h",
        label: "5 Hour limit",
        unit: "percent",
        resolvedFraction: 0.12,
        severity: "ok",
        used: 12,
        resetsAtMs: Date.parse("2026-08-12T15:09:04.847Z"),
      },
      {
        id: "weekly",
        label: "Weekly limit",
        unit: "percent",
        resolvedFraction: 0.08,
        severity: "ok",
        used: 8,
        resetsAtMs: Date.parse("2026-08-17T00:00:00.847Z"),
      },
      {
        id: "monthly",
        label: expect.any(String),
        unit: "percent",
        resolvedFraction: 1,
        severity: "exhausted",
        used: 100,
        resetsAtMs: Date.parse("2026-08-19T00:31:53.847Z"),
      },
    ]);
    expectNoModelFields(report);
  });

  test("maps 100 percent to exhausted and high usage to warning", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 200,
        body: usagePayload({
          rolling: { status: "ok", percent: 85, resetsAt: "2026-08-12T15:09:04.847Z" },
        }),
      },
    });
    const response = await runFetch(fetcher);
    expect(response.report.windows.find((window) => window.id === "rolling-5h")?.severity).toBe("warning");
    expect(response.report.windows.find((window) => window.id === "weekly")?.severity).toBe("ok");
    expect(response.report.windows.find((window) => window.id === "monthly")?.severity).toBe("exhausted");
  });

  test("rejects the wrong providerId and a missing credential", async () => {
    const fetcher = mockFetcher([]);
    expect(
      (await bridgeErrorFrom(() => runFetch(fetcher, usageRequest({ providerId: "other" })))).kind,
    ).toBe("invalidProvider");
    const { credential: _credential, ...missing } = usageRequest();
    expect((await bridgeErrorFrom(() => runFetch(fetcher, missing))).kind).toBe("missingCredential");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("maps 401 to authRequired without leaking the key", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 401, body: { error: { message: "Unauthorized" } } },
    });
    const error = await bridgeErrorFrom(() => runFetch(fetcher));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(API_KEY);
  });

  test("maps 403 to permissionDenied when the account has no Go subscription", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 403,
        body: { error: { message: "OpenCode Go subscription required." } },
      },
    });
    expect((await bridgeErrorFrom(() => runFetch(fetcher))).kind).toBe("permissionDenied");
  });

  test("maps 429 to rateLimited with Retry-After milliseconds", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { message: "slow down" } },
    });
    const error = await bridgeErrorFrom(() => runFetch(fetcher));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200 },
    });
    expect((await bridgeErrorFrom(() => runFetch(fetcher))).kind).toBe("malformedPayload");
  });

  test("maps zero usable windows to noData", async () => {
    const empty = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: { usage: {} } },
    });
    expect((await bridgeErrorFrom(() => runFetch(empty))).kind).toBe("noData");

    const missingUsage = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: {} },
    });
    expect((await bridgeErrorFrom(() => runFetch(missingUsage))).kind).toBe("noData");
  });

  test("maps some-but-not-all usable windows to partialPayload", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 200,
        body: usagePayload({ rolling: { status: "ok", percent: "abc" }, weekly: null }),
      },
    });
    expect((await bridgeErrorFrom(() => runFetch(fetcher))).kind).toBe("partialPayload");
  });
});

describe("opencodeGoAuth", () => {
  test("emits the OMP auth URL and instructions, then accepts a pasted API key with no validation request", async () => {
    const originalFetch = globalThis.fetch;
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      throw new Error("opencode-go login must not make network requests (OMP does not validate the key)");
    }) as typeof fetch;
    try {
      const events: AuthEvent[] = [];
      const login = buildLoginRequest({
        providerId: PROVIDER_ID,
        inputs: { apiKey: `  ${API_KEY}  ` },
      });
      const result = await opencodeGoAuth.login(
        login.method,
        login.inputs ?? {},
        { onEvent: (event) => events.push(event) },
        new AbortController().signal,
      );
      expect(calls).toHaveLength(0);
      expect(events).toEqual([
        { type: "openUrl", url: AUTH_URL },
        { type: "pasteHint", detail: "Log in and copy your API key, then paste your OpenCode Zen API key" },
      ]);
      expect(result).toEqual({ credential: { kind: "apiKey", secret: API_KEY } });
      expect(result.accountLabel).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects an empty key and maps abort to timeout", async () => {
    const events: AuthEvent[] = [];
    expect(
      (await bridgeErrorFrom(() =>
        opencodeGoAuth.login("apiKey", { apiKey: "  " }, { onEvent: (event) => events.push(event) }, new AbortController().signal),
      )).kind,
    ).toBe("invalidRequest");
    expect(events[0]).toEqual({ type: "openUrl", url: AUTH_URL });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridgeErrorFrom(() =>
      opencodeGoAuth.login("apiKey", { apiKey: API_KEY }, { onEvent: () => {} }, controller.signal),
    );
    expect(cancelled.kind).toBe("timeout");
    expect(cancelled.message.toLowerCase()).toContain("cancelled");
    expect(cancelled.message).not.toContain(API_KEY);
  });
});


describe("OpenCode current usage contract", () => {
  test.each([79.9, 80, 94.9, 95, 99.9, 100])("wire severity at %p percent", async (percent) => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload({
      rolling: { status: "ok", percent, resetsAt: "2026-08-12T15:09:04.847Z" },
    }) } });
    const window = (await runFetch(fetcher)).report.windows[0];
    expect(window?.resolvedFraction).toBe(percent / 100);
    expect(window?.severity).toBe(percent >= 100 ? "exhausted" : percent >= 95 ? "critical" : percent >= 80 ? "warning" : "ok");
  });

  test.each([0, 12, 80, 95, 99.9, 100])("rate-limited availability preserves reported %p percent", async (percent) => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload({
      rolling: { status: "rate-limited", percent, resetsAt: "2026-08-12T15:09:04.847Z" },
    }) } });
    expect((await runFetch(fetcher)).report.windows[0]).toMatchObject({
      used: percent, resolvedFraction: percent / 100,
      severity: percent >= 100 ? "exhausted" : percent >= 95 ? "critical" : percent >= 80 ? "warning" : "ok",
    });
  });

  test("availability changes only the optional display label, not measurements", async () => {
    const windows = [];
    for (const status of ["ok", "rate-limited"]) {
      const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload({
        rolling: { status, percent: 100, resetsAt: "2026-08-12T15:09:04.847Z" },
      }) } });
      const window = (await runFetch(fetcher)).report.windows[0];
      if (window === undefined) throw new Error("missing rolling window");
      windows.push(window);
    }
    const [available, limited] = windows;
    if (available === undefined || limited === undefined) throw new Error("missing availability pair");
    const { label: availableLabel, ...availableMeasurements } = available;
    const { label: limitedLabel, ...limitedMeasurements } = limited;
    expect(typeof limitedLabel).toBe("string");
    expect(limitedLabel?.length).toBeGreaterThan(0);
    expect(limitedLabel).not.toBe(availableLabel);
    expect(limitedMeasurements).toEqual(availableMeasurements);
  });

  test.each(["", "broken-metadata", "sk-synthetic-not-an-installation-id"])("invalid metadata is typed, not replaced or sent (%p)", async (contents) => {
    mkdirSync(join(testRoot, "metadata"));
    writeFileSync(installationIdPath, contents);
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload() } });
    const error = await bridgeErrorFrom(() => runFetch(fetcher));
    expect(error.kind).toBe("dependencyUnavailable");
    expect(error.message).not.toContain(testRoot);
    if (contents !== "") expect(error.message).not.toContain(contents);
    expect(readFileSync(installationIdPath, "utf8")).toBe(contents);
    expect(fetcher.calls).toHaveLength(0);
  });

  test("unavailable metadata parent never falls back to a process UUID", async () => {
    writeFileSync(join(testRoot, "metadata"), "not-a-directory");
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload() } });
    expect((await bridgeErrorFrom(() => runFetch(fetcher))).kind).toBe("dependencyUnavailable");
    expect(fetcher.calls).toHaveLength(0);
  });

  test.each([null, { status: "other", percent: 20, resetsAt: "2026-08-12T15:09:04Z" },
    { status: "ok", percent: 101, resetsAt: "2026-08-12T15:09:04Z" },
    { status: "ok", percent: 20, resetsAt: "invalid" }])("never drops a malformed window: %p", async (monthly) => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload({ monthly }) } });
    expect((await bridgeErrorFrom(() => runFetch(fetcher))).kind).toBe("partialPayload");
  });
});

// A compiled, provider-only probe is not shipped. It uses the actual adapter and
// actual loopback fetch; credentials and the isolated metadata path arrive on stdin.
describe("OpenCode compiled process surface", () => {
  let binaryRoot: string;
  let binary: string;
  beforeAll(async () => {
    binaryRoot = mkdtempSync(join(tmpdir(), "opencode-compiled-"));
    binary = join(binaryRoot, "opencode-probe");
    const build = Bun.spawn([process.execPath, "build", "fixtures/opencode-go/probe.ts", "--compile", "--outfile", binary], {
      cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
    if (code !== 0) throw new Error(`probe build failed: ${stdout} ${stderr}`);
  });
  afterAll(() => rmSync(binaryRoot, { recursive: true, force: true }));

  function startProbe(endpoint: string, path: string) {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stderr });
    const ready = Promise.race([
      once(lines, "line").then(([line]) => expect(line).toBe("ready")),
      closed.then(() => { throw new Error("probe exited before ready"); }),
    ]);
    return {
      ready,
      release: () => child.stdin.end(JSON.stringify({ endpoint, installationIdPath: path, request: usageRequest() })),
      result: async () => {
        const [code, signal] = await closed;
        lines.close();
        expect(signal).toBeNull();
        expect(code).toBe(0);
        const raw = Buffer.concat(chunks).toString("utf8");
        expect(raw).not.toContain(API_KEY);
        return JSON.parse(raw);
      },
      stop: async () => { child.kill(); await closed; lines.close(); },
    };
  }

  test("real outgoing headers persist across sequential and concurrent first-use processes", async () => {
    const headers: { session: string | null; userAgent: string | null }[] = [];
    let payload = usagePayload({ rolling: { status: "ok", percent: 95, resetsAt: "2026-08-12T15:09:04Z" } });
    let status = 200;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/zen/go/v1/usage");
      expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
      expect(request.headers.get("accept")).toBe("application/json");
      headers.push({ session: request.headers.get("x-opencode-session"), userAgent: request.headers.get("user-agent") });
      return Response.json(payload, { status, headers: { "retry-after": "30" } });
    } });
    const children: ReturnType<typeof startProbe>[] = [];
    const outputs: Record<string, unknown> = {};
    const invoke = async (name: string, path = installationIdPath) => {
      const child = startProbe(server.url.href, path);
      children.push(child);
      await child.ready;
      child.release();
      const output = await child.result();
      outputs[name] = output;
      return output;
    };
    try {
      // Two independent invocations, not repeated calls in one JS process.
      expect((await invoke("critical-first")).status).toBe("ok");
      expect((await invoke("critical-second")).status).toBe("ok");
      const concurrentPath = join(testRoot, "concurrent", "opencode-install-id");
      const racers = Array.from({ length: 8 }, () => startProbe(server.url.href, concurrentPath));
      children.push(...racers);
      await Promise.all(racers.map((child) => child.ready));
      racers.forEach((child) => child.release());
      const results = await Promise.all(racers.map((child) => child.result()));
      expect(results.every((result) => result.status === "ok")).toBe(true);
      expect(headers[0]?.userAgent).toBe("omp/18.1.14");
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      const firstSession = headers[0]?.session;
      if (typeof firstSession !== "string") throw new Error("missing outgoing installation header");
      expect(firstSession).toMatch(uuid);
      expect(headers[1]?.session).toBe(firstSession);
      expect(readFileSync(installationIdPath, "utf8").trim()).toBe(firstSession);
      expect(statSync(installationIdPath).mode & 0o777).toBe(0o600);

      const concurrentHeaders = headers.slice(2);
      expect(concurrentHeaders).toHaveLength(8);
      expect(new Set(concurrentHeaders.map((header) => header.session)).size).toBe(1);
      const concurrentId = readFileSync(concurrentPath, "utf8").trim();
      expect(concurrentId).toMatch(uuid);
      expect(concurrentId).not.toBe(headers[0]?.session);
      expect(concurrentHeaders.every((header) => header.session === concurrentId && header.userAgent === "omp/18.1.14")).toBe(true);
      expect(readdirSync(join(testRoot, "concurrent"))).toEqual(["opencode-install-id"]);

      for (const percent of [80, 99.9]) {
        payload = usagePayload({ rolling: { status: "ok", percent, resetsAt: "2026-08-12T15:09:04Z" } });
        expect((await invoke(`percent-${percent}`)).status).toBe("ok");
      }
      payload = usagePayload({ rolling: { status: "rate-limited", percent: 12, resetsAt: "2026-08-12T15:09:04Z" } });
      expect((await invoke("rate-limited-window")).report.windows[0]).toMatchObject({ used: 12, resolvedFraction: 0.12, severity: "ok" });
      for (const [httpStatus, kind] of [[401, "authRequired"], [403, "permissionDenied"], [429, "rateLimited"], [500, "upstreamError"]] as const) {
        status = httpStatus;
        expect((await invoke(`http-${status}`)).error.kind).toBe(kind);
      }
      status = 200;
      payload = usagePayload({ monthly: null });
      expect((await invoke("partial")).error.kind).toBe("partialPayload");
      const invalidPath = join(testRoot, "invalid-id");
      writeFileSync(invalidPath, "invalid-metadata");
      const beforeInvalid = headers.length;
      expect((await invoke("invalid-metadata", invalidPath)).error.kind).toBe("dependencyUnavailable");
      expect(headers).toHaveLength(beforeInvalid);
      expect(readFileSync(invalidPath, "utf8")).toBe("invalid-metadata");
    } finally {
      await Promise.all(children.map((child) => child.stop()));
      await server.stop(true);
      const artifactDir = process.env["OPENCODE_EVIDENCE_DIR"];
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(artifactDir, "opencode-headers.json"), JSON.stringify(headers, null, 2));
        for (const [name, output] of Object.entries(outputs)) {
          writeFileSync(join(artifactDir, `opencode-response-${name}.json`), JSON.stringify(output));
        }
      }
    }
  }, 30_000);
});
