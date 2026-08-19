import { describe, expect, test } from "bun:test";
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

function runFetch(fetcher: ReturnType<typeof mockFetcher>, request = usageRequest()) {
  return opencodeGoConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });
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
        label: "Monthly limit",
        unit: "percent",
        resolvedFraction: 1,
        severity: "exhausted",
        used: 100,
        resetsAtMs: Date.parse("2026-08-19T00:31:53.847Z"),
      },
    ]);
    expectNoModelFields(report);
  });

  test("maps rate-limited windows to exhausted and high usage to warning", async () => {
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
