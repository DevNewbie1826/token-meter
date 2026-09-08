import { describe, expect, test } from "bun:test";
import { loginSynthetic, syntheticAuth, syntheticConnector } from "../src/providers/synthetic";
import { BridgeError } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";

const KEY = "sk-synthetic-test";
const QUOTAS_URL = "https://api.synthetic.new/v2/quotas";
const MODELS_URL = "https://api.synthetic.new/openai/v1/models";
const DASHBOARD_URL = "https://dev.synthetic.new/docs/api/overview";
const NOW_MS = 1787011200500;

/** Realistic OMP-shaped `GET /v2/quotas` body from packages/ai/test/synthetic-usage.test.ts. */
const FULL_FIXTURE = {
  subscription: { limit: 500, requests: 12, renewsAt: "2026-07-10T11:33:46.399Z" },
  search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-07-10T07:33:46.399Z" } },
  freeToolCalls: { limit: 0, requests: 0, renewsAt: "2026-07-11T06:33:46.405Z" },
  weeklyTokenLimit: {
    nextRegenAt: "2026-07-10T08:17:04.000Z",
    percentRemaining: 7.615,
    maxCredits: "$24.00",
    remainingCredits: "$1.82",
    nextRegenCredits: "$0.48",
  },
  rollingFiveHourLimit: {
    nextTickAt: "2026-07-10T06:46:05.000Z",
    tickPercent: 0.05,
    remaining: 500,
    max: 500,
    limited: false,
  },
};

const WEEKLY_USED_FRACTION = 1 - 7.615 / 100;

function usageRequest(overrides: Parameters<typeof buildUsageRequest>[0] = {}) {
  return buildUsageRequest({
    providerId: "synthetic",
    connectorId: "synthetic",
    credential: { kind: "apiKey", secret: KEY },
    ...overrides,
  });
}

function quotasFetcher(body: unknown, status = 200, headers?: Record<string, string>) {
  return mockFetcher({
    [`GET ${QUOTAS_URL}`]: { status, body, ...(headers === undefined ? {} : { headers }) },
  });
}

async function fetchUsage(fetcher: ReturnType<typeof mockFetcher> | ((url: string, init: RequestInit) => Promise<Response>)) {
  return syntheticConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });
}

async function expectBridgeError(action: () => Promise<unknown>): Promise<BridgeError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BridgeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected BridgeError");
}

describe("syntheticConnector", () => {
  test("maps the OMP quotas fixture to 5h request and 7d USD windows", async () => {
    const fetcher = quotasFetcher(FULL_FIXTURE);
    const response = await fetchUsage(fetcher);

    expect(syntheticConnector.providerId).toBe("synthetic");
    expect(syntheticConnector.connectorVersion).toBe("synthetic-1");
    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected a quotas request");
    }
    expect(call.method).toBe("GET");
    expect(call.url).toBe(QUOTAS_URL);
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(call.init.body).toBeUndefined();
    expect(call.init.signal).toBeInstanceOf(AbortSignal);

    expect(response.status).toBe("ok");
    expect(response.providerId).toBe("synthetic");
    expect(response.connectorId).toBe("synthetic");
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();

    const report = response.report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("firstPartyApi");
    expect(report.connectorVersion).toBe("synthetic-1");
    expect(report.fetchedAtMs).toBe(NOW_MS);
    expect(report.windows).toHaveLength(2);

    const fiveHour = report.windows[0];
    const weekly = report.windows[1];
    if (fiveHour === undefined || weekly === undefined) {
      throw new Error("expected both normalized windows");
    }

    expect(fiveHour.id).toBe("synthetic:requests:5h");
    expect(fiveHour.label).toBe("Synthetic Requests");
    expect(fiveHour.unit).toBe("requests");
    expect(fiveHour.used).toBe(0);
    expect(fiveHour.limit).toBe(500);
    expect(fiveHour.resolvedFraction).toBe(0);
    expect(fiveHour.severity).toBe("ok");
    expect(fiveHour.resetsAtMs).toBeUndefined();

    expect(weekly.id).toBe("synthetic:usd:7d");
    expect(weekly.label).toBe("Synthetic Credits");
    expect(weekly.unit).toBe("usd");
    expect(weekly.limit).toBeCloseTo(24);
    expect(weekly.resolvedFraction).toBeCloseTo(WEEKLY_USED_FRACTION, 5);
    expect(weekly.used).toBeCloseTo(WEEKLY_USED_FRACTION * 24, 5);
    expect(weekly.severity).toBe("warning");
    expect(weekly.resetsAtMs).toBeUndefined();

    expectNoModelFields(report);
    expect(JSON.stringify(response)).not.toContain(KEY);
  });

  test("either valid row alone forms a report", async () => {
    const onlyFive = await fetchUsage(quotasFetcher({ rollingFiveHourLimit: FULL_FIXTURE.rollingFiveHourLimit }));
    expect(onlyFive.report.windows.map((window) => window.id)).toEqual(["synthetic:requests:5h"]);

    const onlyWeekly = await fetchUsage(quotasFetcher({ weeklyTokenLimit: FULL_FIXTURE.weeklyTokenLimit }));
    expect(onlyWeekly.report.windows.map((window) => window.id)).toEqual(["synthetic:usd:7d"]);
  });

  test("marks the 5h window exhausted when limited is true", async () => {
    const response = await fetchUsage(
      quotasFetcher({
        rollingFiveHourLimit: { ...FULL_FIXTURE.rollingFiveHourLimit, remaining: 0, limited: true },
      }),
    );
    expect(response.report.windows[0]?.severity).toBe("exhausted");
  });

  test("rejects the wrong provider and a missing credential", async () => {
    const fetcher = quotasFetcher(FULL_FIXTURE);
    await expect(
      syntheticConnector.fetchUsage({ request: usageRequest({ providerId: "other" }), fetcher, nowMs: NOW_MS }),
    ).rejects.toMatchObject({ kind: "invalidProvider" });

    const { credential: _credential, ...missing } = usageRequest();
    await expect(syntheticConnector.fetchUsage({ request: missing, fetcher, nowMs: NOW_MS })).rejects.toMatchObject({
      kind: "missingCredential",
    });
    expect(fetcher.calls).toHaveLength(0);
  });

  test("maps 401 to authRequired", async () => {
    const error = await expectBridgeError(() => fetchUsage(quotasFetcher({ message: "Unauthorized" }, 401)));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(KEY);
  });

  test("maps 429 with Retry-After to rateLimited milliseconds", async () => {
    const error = await expectBridgeError(() => fetchUsage(quotasFetcher({ message: "slow down" }, 429, { "retry-after": "30" })));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = async () => new Response("not-json{{{{", { status: 200 });
    const error = await expectBridgeError(() => fetchUsage(fetcher));
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps a payload with no usable rows to noData", async () => {
    const error = await expectBridgeError(() =>
      fetchUsage(quotasFetcher({ subscription: FULL_FIXTURE.subscription })),
    );
    expect(error.kind).toBe("noData");
  });
});

describe("syntheticAuth", () => {
  test("validates a dashboard key against the models endpoint", async () => {
    const fetcher = mockFetcher({
      [`GET ${MODELS_URL}`]: { status: 200, body: { data: [{ id: "hf:zai-org/GLM-5.1" }] } },
    });

    const events: AuthEvent[] = [];
    const login = buildLoginRequest({ providerId: "synthetic", method: "apiKey", inputs: { apiKey: `  ${KEY}  ` } });
    const result = await loginSynthetic(
      login.method,
      login.inputs ?? {},
      { onEvent: (event) => events.push(event) },
      new AbortController().signal,
      { fetcher },
    );

    expect(syntheticAuth.providerId).toBe("synthetic");
    expect(syntheticAuth.methods).toEqual(["apiKey"]);
    expect(result).toEqual({ credential: { kind: "apiKey", secret: KEY } });
    expect(result.accountLabel).toBeUndefined();
    expect(events).toEqual([
      { type: "openUrl", url: DASHBOARD_URL },
      { type: "pasteHint", detail: "Copy your API key from the Synthetic dashboard" },
      { type: "waiting", detail: "Validating API key..." },
    ]);
    expect(fetcher.calls).toHaveLength(1);
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected a models request");
    }
    expect(call.method).toBe("GET");
    expect(call.url).toBe(MODELS_URL);
    expect(new Headers(call.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.init.body).toBeUndefined();
  });

  test("rejects an invalid key with authRequired and never returns a credential", async () => {
    const fetcher = mockFetcher({
      [`GET ${MODELS_URL}`]: { status: 401, body: { error: { message: "Invalid API key" } } },
    });
    const error = await expectBridgeError(() =>
      loginSynthetic(
        "apiKey",
        { apiKey: KEY },
        { onEvent: () => {} },
        new AbortController().signal,
        { fetcher },
      ),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(KEY);
    expect(fetcher.calls).toHaveLength(1);
  });

  test("rejects an empty key, the wrong method, and a cancelled signal", async () => {
    const fetcher = mockFetcher([]);
    const events: AuthEvent[] = [];
    const live = new AbortController().signal;
    await expect(loginSynthetic("apiKey", { apiKey: "  " }, { onEvent: (event) => events.push(event) }, live, { fetcher })).rejects.toMatchObject({
      kind: "invalidRequest",
    });
    await expect(loginSynthetic("browser", { apiKey: KEY }, { onEvent: () => {} }, live, { fetcher })).rejects.toMatchObject({
      kind: "invalidRequest",
    });

    const controller = new AbortController();
    controller.abort();
    const error = await expectBridgeError(() =>
      syntheticAuth.login("apiKey", { apiKey: KEY }, { onEvent: () => {} }, controller.signal),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancelled");
    expect(error.message).not.toContain(KEY);
    expect(fetcher.calls).toHaveLength(0);
  });
});

describe("Synthetic wire conformance", () => {
  test.each([[79.9, "ok"], [80, "warning"], [89.9, "warning"], [95, "critical"], [99.9, "critical"], [100, "exhausted"]] as const)("uses wire severity for both independent windows at %s percent", async (percent, severity) => {
    const response = await fetchUsage(quotasFetcher({ rollingFiveHourLimit: { remaining: 100 - percent, max: 100 }, weeklyTokenLimit: { maxCredits: "$100", percentRemaining: 100 - percent } }));
    expect(response.report.windows.map(window => window.severity)).toEqual([severity, severity]);
  });
  test("retains remaining-only request and USD amounts without inventing utilization", async () => {
    const response = await fetchUsage(quotasFetcher({ rollingFiveHourLimit: { remaining: 17 }, weeklyTokenLimit: { remainingCredits: "$2.50" } }));
    expect(response.report.windows.map(({ unit, remaining, used, limit, resolvedFraction, severity }) => ({ unit, remaining, used, limit, resolvedFraction, severity }))).toEqual([
      { unit: "requests", remaining: 17, used: undefined, limit: undefined, resolvedFraction: undefined, severity: "unknown" },
      { unit: "usd", remaining: 2.5, used: undefined, limit: undefined, resolvedFraction: undefined, severity: "unknown" },
    ]);
  });
  test("derives weekly utilization from amounts when percentRemaining is absent", async () => {
    const response = await fetchUsage(quotasFetcher({ weeklyTokenLimit: { remainingCredits: "$2", maxCredits: "$10" } }));
    expect(response.report.windows[0]).toMatchObject({ remaining: 2, used: 8, limit: 10, resolvedFraction: 0.8, severity: "warning" });
  });
  test("does not let limited override an explicit non-exhausted ratio", async () => {
    const response = await fetchUsage(quotasFetcher({ rollingFiveHourLimit: { remaining: 50, max: 100, limited: true } }));
    expect(response.report.windows[0]).toMatchObject({ resolvedFraction: 0.5, severity: "ok" });
  });
  test("keeps a cap-only row unknown", async () => {
    const response = await fetchUsage(quotasFetcher({ rollingFiveHourLimit: { max: 100 } }));
    expect(response.report.windows[0]).toMatchObject({ limit: 100, severity: "unknown" });
  });
  test.each([{ remaining: -1, max: 100 }, { remaining: 101, max: 100 }, { remaining: 0, max: 0 }])("rejects contradictory rolling amounts %j", async row => {
    await expect(fetchUsage(quotasFetcher({ rollingFiveHourLimit: row }))).rejects.toMatchObject({ kind: "malformedPayload" });
  });
});
