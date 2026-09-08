import { describe, expect, test } from "bun:test";
import { loginUmans, umansAuth, umansConnector } from "../src/providers/umans";
import { BridgeError } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";

const PROVIDER_ID = "umans";
const CONNECTOR_VERSION = "umans-1";
const USAGE_URL = "https://api.code.umans.ai/v1/usage";
const VALIDATION_URL = "https://api.code.umans.ai/v1/messages";
const AUTH_URL = "https://app.umans.ai/billing";
const API_KEY = "sk-umans-unit-test";
const NOW_MS = 1787011200500;
const RESETS_AT = "2026-08-06T21:52:21.202174+00:00";

/** Realistic OMP-shaped `GET /v1/usage` body from packages/ai/test/umans-usage.test.ts. */
function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan: { display_name: "Code Max" },
    limits: {
      requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
      concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
    },
    window: {
      started_at: "2026-08-06T16:52:21.202174+00:00",
      resets_at: RESETS_AT,
      remaining_minutes: 9,
    },
    usage: {
      requests_in_window: 48,
      remaining_requests: 152,
      weighted_in_window: 96,
      weighted_remaining_requests: 104,
      concurrent_sessions: 1,
      tokens_in: 1_200_000,
      tokens_out: 340_000,
      priority: { low: false, boxed_until: null, reason: null },
    },
    ...overrides,
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
  return umansConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });
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

describe("umansConnector", () => {
  test("maps weighted soft, raw hard, and concurrency windows from GET /v1/usage", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: usagePayload() },
    });
    const response = await runFetch(fetcher);

    expect(umansConnector.providerId).toBe(PROVIDER_ID);
    expect(umansConnector.connectorVersion).toBe(CONNECTOR_VERSION);
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
        id: "umans:requests:soft",
        label: "Requests (soft cap)",
        unit: "requests",
        resolvedFraction: 0.48,
        severity: "ok",
        used: 96,
        limit: 200,
      },
      {
        id: "umans:requests:hard",
        label: "Requests (burst ceiling)",
        unit: "requests",
        resolvedFraction: 0.12,
        severity: "ok",
        used: 48,
        limit: 400,
      },
      {
        id: "umans:concurrency",
        label: "Concurrency",
        unit: "requests",
        resolvedFraction: 0.25,
        severity: "ok",
        used: 1,
        limit: 4,
      },
    ]);
    expect(report.windows.every((window) => window.resetsAtMs === undefined)).toBe(true);
    expectNoModelFields(report);
  });

  test("keeps weighted headroom decisive when raw traffic exceeds the soft cap", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 200,
        body: usagePayload({
          limits: {
            requests: { limit: 500, hard_cap: 1000, burst_pct: 1.0, window_seconds: 18000 },
            concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
          },
          usage: {
            requests_in_window: 838,
            remaining_requests: 0,
            weighted_in_window: 207,
            weighted_remaining_requests: 293,
            concurrent_sessions: 0,
          },
        }),
      },
    });
    const response = await runFetch(fetcher);
    const soft = response.report.windows.find((window) => window.id === "umans:requests:soft");
    const hard = response.report.windows.find((window) => window.id === "umans:requests:hard");
    expect(soft?.used).toBe(207);
    expect(soft?.limit).toBe(500);
    expect(soft?.resolvedFraction).toBeCloseTo(0.414, 3);
    expect(soft?.severity).toBe("ok");
    expect(hard?.used).toBe(838);
    expect(hard?.limit).toBe(1000);
    expect(hard?.resolvedFraction).toBeCloseTo(0.838, 3);
    expect(hard?.severity).toBe("warning");
    expect(response.report.windows.some((window) => window.severity === "exhausted")).toBe(false);
  });

  test("reports each exhausted cap independently", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 200,
        body: usagePayload({
          usage: {
            requests_in_window: 400,
            weighted_in_window: 200,
            concurrent_sessions: 1,
          },
        }),
      },
    });
    const response = await runFetch(fetcher);
    expect(response.report.windows.find((window) => window.id === "umans:requests:soft")?.severity).toBe("exhausted");
    expect(response.report.windows.find((window) => window.id === "umans:requests:hard")?.severity).toBe("exhausted");
  });

  test("accepts any valid subset of windows", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 200,
        body: { usage: { concurrent_sessions: 2 } },
      },
    });
    const response = await runFetch(fetcher);
    expect(response.report.windows).toEqual([
      {
        id: "umans:concurrency",
        label: "Concurrency",
        unit: "requests",
        severity: "unknown",
        used: 2,
      },
    ]);
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
      [`GET ${USAGE_URL}`]: { status: 401, body: { message: "unauthorized" } },
    });
    const error = await bridgeErrorFrom(() => runFetch(fetcher));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(API_KEY);
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
      [`GET ${USAGE_URL}`]: { status: 200, body: { plan: { display_name: "Code Max" } } },
    });
    expect((await bridgeErrorFrom(() => runFetch(empty))).kind).toBe("noData");

    const unused = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: { limits: {}, usage: { tokens_in: 1 } } },
    });
    expect((await bridgeErrorFrom(() => runFetch(unused))).kind).toBe("noData");
  });
});

describe("umansAuth", () => {
  test("validates the key with OMP's exact Anthropic-compatible messages probe before returning the credential", async () => {
    const fetcher = mockFetcher({
      [`POST ${VALIDATION_URL}`]: { status: 200, body: { id: "msg_unit", type: "message", content: [] } },
    });
    const events: AuthEvent[] = [];
    const login = buildLoginRequest({
      providerId: PROVIDER_ID,
      inputs: { apiKey: `  ${API_KEY}  ` },
    });
    const result = await loginUmans(
      login.method,
      login.inputs ?? {},
      { onEvent: (event) => events.push(event) },
      new AbortController().signal,
      { fetcher },
    );

    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected a validation request");
    }
    expect(call.method).toBe("POST");
    expect(call.url).toBe(VALIDATION_URL);
    const headers = new Headers(call.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("x-api-key")).toBe(API_KEY);
    expect(headers.get("authorization")).toBeNull();
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "umans-coder",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    expect(events).toEqual([
      { type: "openUrl", url: AUTH_URL },
      { type: "pasteHint", detail: "Create or copy your Umans API key from Dashboard → API Keys." },
      { type: "waiting", detail: "Validating API key..." },
    ]);
    expect(result).toEqual({ credential: { kind: "apiKey", secret: API_KEY } });
    expect(result.accountLabel).toBeUndefined();
    expect(umansAuth.methods).toEqual(["apiKey"]);
  });

  test("rejects an invalid key with authRequired and never returns a credential", async () => {
    const fetcher = mockFetcher({
      [`POST ${VALIDATION_URL}`]: { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } },
    });
    const error = await bridgeErrorFrom(() =>
      loginUmans(
        "apiKey",
        { apiKey: API_KEY },
        { onEvent: () => {} },
        new AbortController().signal,
        { fetcher },
      ),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(API_KEY);
    expect(fetcher.calls).toHaveLength(1);
  });

  test("rejects an empty key before any network call and maps abort to timeout", async () => {
    const events: AuthEvent[] = [];
    const fetcher = mockFetcher([]);
    expect(
      (
        await bridgeErrorFrom(() =>
          loginUmans("apiKey", { apiKey: "  " }, { onEvent: (event) => events.push(event) }, new AbortController().signal, { fetcher }),
        )
      ).kind,
    ).toBe("invalidRequest");
    expect(events[0]).toEqual({ type: "openUrl", url: AUTH_URL });
    expect(fetcher.calls).toHaveLength(0);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridgeErrorFrom(() =>
      loginUmans("apiKey", { apiKey: API_KEY }, { onEvent: () => {} }, controller.signal, { fetcher }),
    );
    expect(cancelled.kind).toBe("timeout");
    expect(cancelled.message.toLowerCase()).toContain("cancelled");
    expect(cancelled.message).not.toContain(API_KEY);
    expect(fetcher.calls).toHaveLength(0);
  });
});

describe("Umans wire conformance", () => {
  test.each([[79.9, "ok"], [80, "warning"], [89.9, "warning"], [95, "critical"], [99.9, "critical"], [100, "exhausted"], [120, "exhausted"]] as const)("keeps exact independent ratios at %s percent", async (used, severity) => {
    const response = await runFetch(mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { limits: { requests: { limit: 100, hard_cap: 200 }, concurrency: { limit: 100 } }, usage: { weighted_in_window: used, requests_in_window: 2 * used, concurrent_sessions: used } } } }));
    expect(response.report.windows.map(window => window.resolvedFraction)).toEqual([used / 100, used / 100, used / 100]);
    expect(response.report.windows.map(window => window.severity)).toEqual([severity, severity, severity]);
  });
  test.each([{ used: -1, limit: 100 }, { used: 0, limit: 0 }])("rejects invalid amounts %j", async ({ used, limit }) => {
    await expect(runFetch(mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { usage: { concurrent_sessions: used }, limits: { concurrency: { limit } } } } }))).rejects.toMatchObject({ kind: "malformedPayload" });
  });
});
