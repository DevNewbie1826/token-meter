import { describe, expect, test } from "bun:test";
import { loginMiniMaxCode, minimaxCodeAuth, minimaxCodeConnector } from "../src/providers/minimax-code";
import { BridgeError } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";

const PROVIDER_ID = "minimax-code";
const CONNECTOR_VERSION = "minimax-code-1";
const REMAINS_URL = "https://api.minimax.io/v1/token_plan/remains";
const VALIDATION_URL = "https://api.minimax.io/v1/chat/completions";
const AUTH_URL = "https://platform.minimax.io/subscribe/token-plan";
const API_KEY = "sk-minimax-code-unit-test";
const NOW_MS = 1787011200500;

const INTERVAL_START = 1_785_009_600_000;
const INTERVAL_END = 1_785_024_000_000;
const WEEKLY_START = 1_784_505_600_000;
const WEEKLY_END = 1_785_110_400_000;

type RemainsBucket = {
  readonly model_name: string;
  readonly start_time: number;
  readonly end_time: number;
  readonly current_interval_total_count: number;
  readonly current_interval_usage_count: number;
  readonly current_interval_remaining_percent?: number;
  readonly current_interval_status?: number;
  readonly weekly_start_time: number;
  readonly weekly_end_time: number;
  readonly current_weekly_total_count: number;
  readonly current_weekly_usage_count: number;
  readonly current_weekly_remaining_percent?: number;
  readonly current_weekly_status?: number;
};

function generalBucket(overrides: Partial<RemainsBucket> = {}): RemainsBucket {
  return {
    model_name: "general",
    start_time: INTERVAL_START,
    end_time: INTERVAL_END,
    current_interval_total_count: 0,
    current_interval_usage_count: 0,
    current_interval_remaining_percent: 90,
    current_interval_status: 1,
    weekly_start_time: WEEKLY_START,
    weekly_end_time: WEEKLY_END,
    current_weekly_total_count: 0,
    current_weekly_usage_count: 0,
    current_weekly_remaining_percent: 78,
    current_weekly_status: 1,
    ...overrides,
  };
}

function videoBucket(): RemainsBucket {
  return {
    model_name: "video",
    start_time: INTERVAL_END - 86_400_000,
    end_time: INTERVAL_END,
    current_interval_total_count: 3,
    current_interval_usage_count: 1,
    current_interval_remaining_percent: 100,
    current_interval_status: 1,
    weekly_start_time: WEEKLY_START,
    weekly_end_time: WEEKLY_END,
    current_weekly_total_count: 21,
    current_weekly_usage_count: 1,
    current_weekly_remaining_percent: 100,
    current_weekly_status: 1,
  };
}

function notInPlanBucket(modelName: string): RemainsBucket {
  return {
    model_name: modelName,
    start_time: INTERVAL_START,
    end_time: INTERVAL_END,
    current_interval_total_count: 0,
    current_interval_usage_count: 0,
    current_interval_remaining_percent: 100,
    current_interval_status: 3,
    weekly_start_time: WEEKLY_START,
    weekly_end_time: WEEKLY_END,
    current_weekly_total_count: 0,
    current_weekly_usage_count: 0,
    current_weekly_remaining_percent: 100,
    current_weekly_status: 3,
  };
}

function remainsPayload(...buckets: RemainsBucket[]): Record<string, unknown> {
  return { model_remains: buckets, base_resp: { status_code: 0, status_msg: "success" } };
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
  return minimaxCodeConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });
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

describe("minimaxCodeConnector", () => {
  test("maps each OMP plan bucket to its rolling interval and 7d windows", async () => {
    const fetcher = mockFetcher({
      [`GET ${REMAINS_URL}`]: { status: 200, body: remainsPayload(generalBucket(), videoBucket()) },
    });
    const response = await runFetch(fetcher);

    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected an upstream remains call");
    }
    expect(call.method).toBe("GET");
    expect(call.url).toBe(REMAINS_URL);
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(call.init.body).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

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
        id: "general:4h",
        label: "General 4 Hour",
        unit: "percent",
        resolvedFraction: 0.1,
        severity: "ok",
        used: 10,
        resetsAtMs: INTERVAL_END,
      },
      {
        id: "general:7d",
        label: "General 7 Day",
        unit: "percent",
        resolvedFraction: 0.22,
        severity: "ok",
        used: 22,
        resetsAtMs: WEEKLY_END,
      },
      {
        id: "video:24h",
        label: "Video 24 Hour",
        unit: "percent",
        resolvedFraction: 0,
        severity: "ok",
        used: 0,
        resetsAtMs: INTERVAL_END,
      },
      {
        id: "video:7d",
        label: "Video 7 Day",
        unit: "percent",
        resolvedFraction: 0,
        severity: "ok",
        used: 0,
        resetsAtMs: WEEKLY_END,
      },
    ]);
    expectNoModelFields(report);
  });

  test("maps status 2 to exhausted and status 3 to unlimited ok", async () => {
    const fetcher = mockFetcher({
      [`GET ${REMAINS_URL}`]: {
        status: 200,
        body: remainsPayload(
          {
            model_name: "general",
            start_time: INTERVAL_START,
            end_time: INTERVAL_END,
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            current_interval_status: 2,
            weekly_start_time: WEEKLY_START,
            weekly_end_time: WEEKLY_END,
            current_weekly_total_count: 0,
            current_weekly_usage_count: 0,
            current_weekly_remaining_percent: 5,
            current_weekly_status: 1,
          },
          {
            ...videoBucket(),
            current_interval_status: 3,
            current_interval_remaining_percent: 40,
            current_weekly_status: 1,
            current_weekly_remaining_percent: 8,
          },
        ),
      },
    });
    const response = await runFetch(fetcher);
    expect(response.report.windows.find((window) => window.id === "general:4h")).toMatchObject({
      used: 100,
      resolvedFraction: 1,
      severity: "exhausted",
    });
    expect(response.report.windows.find((window) => window.id === "general:7d")).toMatchObject({
      used: 95,
      resolvedFraction: 0.95,
      severity: "critical",
    });
    expect(response.report.windows.find((window) => window.id === "video:24h")).toMatchObject({
      used: 0,
      resolvedFraction: 0,
      severity: "ok",
    });
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
      [`GET ${REMAINS_URL}`]: { status: 401, body: { base_resp: { status_code: 1004, status_msg: "login fail" } } },
    });
    const error = await bridgeErrorFrom(() => runFetch(fetcher));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(API_KEY);
  });

  test("maps a 200 envelope rejection to authRequired", async () => {
    const fetcher = mockFetcher({
      [`GET ${REMAINS_URL}`]: {
        status: 200,
        body: { base_resp: { status_code: 1004, status_msg: "login fail: Please carry the API secret key" } },
      },
    });
    expect((await bridgeErrorFrom(() => runFetch(fetcher))).kind).toBe("authRequired");
  });

  test("maps 429 to rateLimited with Retry-After milliseconds", async () => {
    const fetcher = mockFetcher({
      [`GET ${REMAINS_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { message: "slow down" } },
    });
    const error = await bridgeErrorFrom(() => runFetch(fetcher));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("maps a non-JSON body or missing envelope to malformedPayload", async () => {
    const nonJson = mockFetcher({
      [`GET ${REMAINS_URL}`]: { status: 200 },
    });
    expect((await bridgeErrorFrom(() => runFetch(nonJson))).kind).toBe("malformedPayload");

    const missingEnvelope = mockFetcher({
      [`GET ${REMAINS_URL}`]: { status: 200, body: { model_remains: [generalBucket()] } },
    });
    expect((await bridgeErrorFrom(() => runFetch(missingEnvelope))).kind).toBe("malformedPayload");
  });

  test("maps zero usable rows to noData", async () => {
    const empty = mockFetcher({
      [`GET ${REMAINS_URL}`]: { status: 200, body: remainsPayload() },
    });
    expect((await bridgeErrorFrom(() => runFetch(empty))).kind).toBe("noData");

    const unavailable = mockFetcher({
      [`GET ${REMAINS_URL}`]: {
        status: 200,
        body: remainsPayload(notInPlanBucket("general"), notInPlanBucket("video")),
      },
    });
    expect((await bridgeErrorFrom(() => runFetch(unavailable))).kind).toBe("noData");
  });

  test("labels a non-hour interval in minutes", async () => {
    const fetcher = mockFetcher({
      [`GET ${REMAINS_URL}`]: {
        status: 200,
        body: remainsPayload(
          generalBucket({
            start_time: INTERVAL_END - 90 * 60_000,
            end_time: INTERVAL_END,
          }),
        ),
      },
    });
    const response = await runFetch(fetcher);
    expect(response.report.windows.map((window) => window.id)).toEqual(["general:90m", "general:7d"]);
    expect(response.report.windows[0]?.label).toBe("General 90 Minute");
  });

  test("keeps a not-in-plan bucket out of the reported windows", async () => {
    const fetcher = mockFetcher({
      [`GET ${REMAINS_URL}`]: { status: 200, body: remainsPayload(generalBucket(), notInPlanBucket("video")) },
    });
    const response = await runFetch(fetcher);
    expect(response.report.windows.map((window) => window.id)).toEqual(["general:4h", "general:7d"]);
    expectNoModelFields(response.report);
  });
});

describe("minimaxCodeAuth", () => {
  test("validates the pasted key with OMP's exact chat-completions probe before returning the credential", async () => {
    const fetcher = mockFetcher({
      [`POST ${VALIDATION_URL}`]: { status: 200, body: { id: "resp-unit", choices: [] } },
    });
    const events: AuthEvent[] = [];
    const login = buildLoginRequest({
      providerId: PROVIDER_ID,
      inputs: { apiKey: `  ${API_KEY}  ` },
    });
    const result = await loginMiniMaxCode(
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
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(call.init.body))).toEqual({
      model: "MiniMax-M3",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    expect(events).toEqual([
      { type: "openUrl", url: AUTH_URL },
      {
        type: "pasteHint",
        detail: "Subscribe to Token Plan and copy your API key. Paste your MiniMax Token Plan API key.",
      },
      { type: "waiting", detail: "Validating API key..." },
    ]);
    expect(result).toEqual({ credential: { kind: "apiKey", secret: API_KEY } });
    expect(result.accountLabel).toBeUndefined();
    expect(minimaxCodeAuth.methods).toEqual(["apiKey"]);
  });

  test("rejects an invalid key with authRequired and never returns a credential", async () => {
    const fetcher = mockFetcher({
      [`POST ${VALIDATION_URL}`]: { status: 401, body: { base_resp: { status_code: 1004 }, status_msg: "invalid API key" } },
    });
    const error = await bridgeErrorFrom(() =>
      loginMiniMaxCode(
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
          loginMiniMaxCode("apiKey", { apiKey: "  " }, { onEvent: (event) => events.push(event) }, new AbortController().signal, { fetcher }),
        )
      ).kind,
    ).toBe("invalidRequest");
    expect(events[0]).toEqual({ type: "openUrl", url: AUTH_URL });
    expect(fetcher.calls).toHaveLength(0);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await bridgeErrorFrom(() =>
      loginMiniMaxCode("apiKey", { apiKey: API_KEY }, { onEvent: () => {} }, controller.signal, { fetcher }),
    );
    expect(cancelled.kind).toBe("timeout");
    expect(cancelled.message.toLowerCase()).toContain("cancelled");
    expect(cancelled.message).not.toContain(API_KEY);
    expect(fetcher.calls).toHaveLength(0);
  });
});

describe("MiniMax wire conformance", () => {
  test.each([[79.9, "ok"], [80, "warning"], [89.9, "warning"], [95, "critical"], [99.9, "critical"], [100, "exhausted"]] as const)("uses wire severity at %s percent", async (percent, severity) => {
    const response = await runFetch(mockFetcher({ [`GET ${REMAINS_URL}`]: { status: 200, body: remainsPayload(generalBucket({ current_interval_remaining_percent: 100 - percent })) } }));
    expect(response.report.windows[0]?.resolvedFraction).toBeCloseTo(percent / 100, 12);
    expect(response.report.windows[0]?.severity).toBe(severity);
  });
});
