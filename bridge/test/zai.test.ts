import { describe, expect, test } from "bun:test";
import { loginZai, zaiAuth, zaiConnector } from "../src/providers/zai";
import { BridgeError } from "../src/protocol";
import credits from "../fixtures/zai/credits.json";
import mixed from "../fixtures/zai/mixed.json";
import precision from "../fixtures/zai/precision.json";
import type { BridgeRequest, UsageWindow } from "../src/protocol";
import type { AuthEvent, AuthEvents } from "../src/dispatch";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher, waitForCount } from "./helpers";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1787011200500;
const RAW_KEY = "ak_unit1234567890.sk_unitsecretvalue";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

// Realistic OMP-shaped quota payload (packages/ai/src/usage/zai.ts shapes):
// token quotas on the 5h/7d/1mo windows, request quotas on 5h/1d/1w, plus a
// Zread feature-only row on an opaque unit (search-prime + web-reader + zread).
const QUOTA_BODY = {
  success: true,
  code: 200,
  msg: "",
  data: {
    limits: [
      {
        type: "TOKENS_LIMIT",
        usage: 600000,
        currentValue: 150000,
        percentage: 25,
        remaining: 450000,
        nextResetTime: 1787014800,
        unit: 3,
        number: 5,
        usageDetails: [],
      },
      {
        type: "TOKENS_LIMIT",
        usage: 3000000,
        currentValue: 600000,
        percentage: 20,
        remaining: 2400000,
        nextResetTime: 1787500000,
        unit: 6,
      },
      {
        type: "TOKENS_LIMIT",
        usage: 12000000,
        currentValue: 2400000,
        percentage: 20,
        remaining: 9600000,
        nextResetTime: 1787014800,
        unit: 5,
        number: 1,
      },
      {
        // No percentage: fraction falls back to currentValue/usage (45/300).
        type: "TIME_LIMIT",
        usage: 300,
        currentValue: 45,
        remaining: 255,
        nextResetTime: 1787014800,
        unit: 3,
        number: 5,
      },
      {
        type: "TIME_LIMIT",
        usage: 100,
        currentValue: 100,
        percentage: 100,
        remaining: 0,
        unit: 4,
        number: 1,
      },
      {
        type: "TIME_LIMIT",
        usage: 1200,
        currentValue: 1080,
        percentage: 90,
        remaining: 120,
        nextResetTime: 1787500000,
        unit: 6,
      },
      {
        type: "TIME_LIMIT",
        usage: 50,
        currentValue: 3,
        percentage: 6,
        remaining: 47,
        unit: 99,
        usageDetails: [
          { modelCode: "search-prime", usage: 1 },
          { modelCode: "web-reader", usage: 1 },
          { modelCode: "zread", usage: 1 },
        ],
      },
      { type: "OTHER_LIMIT", usage: 1, currentValue: 1, unit: 3 },
    ],
  },
};

const EXPECTED_WINDOWS: readonly UsageWindow[] = [
  {
    id: "zai:tokens:5h",
    label: "ZAI 5 Hours Token Quota",
    unit: "tokens",
    resolvedFraction: 0.25,
    severity: "ok",
    used: 150000,
    limit: 600000,
    resetsAtMs: 1787014800000,
  },
  {
    id: "zai:tokens:1w",
    label: "ZAI Weekly Token Quota",
    unit: "tokens",
    resolvedFraction: 0.2,
    severity: "ok",
    used: 600000,
    limit: 3000000,
    resetsAtMs: 1787500000000,
  },
  {
    id: "zai:tokens:1mo",
    label: "ZAI Monthly Token Quota",
    unit: "tokens",
    resolvedFraction: 0.2,
    severity: "ok",
    used: 2400000,
    limit: 12000000,
    resetsAtMs: 1787014800000,
  },
  {
    id: "zai:requests:5h",
    label: "ZAI Request Quota",
    unit: "requests",
    resolvedFraction: 0.15,
    severity: "ok",
    used: 45,
    limit: 300,
    resetsAtMs: 1787014800000,
  },
  {
    id: "zai:requests:1d",
    label: "ZAI Request Quota",
    unit: "requests",
    resolvedFraction: 1,
    severity: "exhausted",
    used: 100,
    limit: 100,
  },
  {
    id: "zai:requests:1w",
    label: "ZAI Request Quota",
    unit: "requests",
    resolvedFraction: 0.9,
    severity: "warning",
    used: 1080,
    limit: 1200,
    resetsAtMs: 1787500000000,
  },
  {
    id: "zai:features:zread:1u99",
    label: "ZAI Zread Quota",
    unit: "requests",
    resolvedFraction: 0.06,
    severity: "ok",
    used: 3,
    limit: 50,
  },
];

function zaiUsageRequest(overrides: { readonly providerId?: string } = {}): BridgeRequest {
  return buildUsageRequest({
    providerId: overrides.providerId ?? "zai",
    connectorId: "zai",
    credential: { kind: "apiKey", secret: RAW_KEY },
  });
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

/** Collects auth events; waitFor subscribes to a specific event type. */
function eventCollector(): {
  readonly events: AuthEvents;
  received(): readonly AuthEvent[];
  waitFor(type: AuthEvent["type"], timeoutMs?: number): Promise<AuthEvent>;
} {
  const received: AuthEvent[] = [];
  type Waiter = { readonly type: AuthEvent["type"]; resolve(event: AuthEvent): void; readonly timer: Timer };
  const waiters: Waiter[] = [];
  return {
    events: {
      onEvent: (event) => {
        received.push(event);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const waiter = waiters[i];
          if (waiter !== undefined && waiter.type === event.type) {
            waiters.splice(i, 1);
            clearTimeout(waiter.timer);
            waiter.resolve(event);
          }
        }
      },
    },
    received: () => received,
    waitFor: (type, timeoutMs = 5000) => {
      const existing = received.find((event) => event.type === type);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise<AuthEvent>((resolve, reject) => {
        const waiterRef: { entry?: Waiter } = {};
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry === waiterRef.entry);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`timed out waiting for a "${type}" auth event`));
        }, timeoutMs);
        const entry: Waiter = { type, resolve, timer };
        waiterRef.entry = entry;
        waiters.push(entry);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Usage connector
// ---------------------------------------------------------------------------

describe("zaiConnector — quota mapping", () => {
  test.each([
    ["credits", credits, [1438 / 12000, 0.95], ["credits", "credits"]],
    ["mixed", mixed, [0.8, 0.7999, 0.9499, 0.9999], ["credits", "tokens", "requests", "credits"]],
    ["precision", precision, [0.7999, 1.01], ["tokens", "requests"]],
  ] as const)("latest %s payload preserves precise independent meters", async (_name, body, fractions, units) => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body } });
    const response = await zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows.map(window => window.resolvedFraction)).toEqual([...fractions]);
    expect(response.report.windows.map(window => window.unit)).toEqual([...units]);
  });

  test("maps the OMP quota payload to normalized windows over the exact upstream call", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: QUOTA_BODY } });
    const request = zaiUsageRequest();
    const response = await zaiConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.length).toBe(1);
    const quotaCall = fetcher.calls[0];
    if (quotaCall === undefined) {
      throw new Error("expected the quota endpoint to be called");
    }
    expect(quotaCall.method).toBe("GET");
    expect(quotaCall.url).toBe(QUOTA_URL);
    const headers = new Headers(quotaCall.init.headers);
    // OMP sends the raw key verbatim — no "Bearer" prefix.
    expect(headers.get("Authorization")).toBe(RAW_KEY);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(quotaCall.init.body).toBeUndefined();
    expect(quotaCall.init.signal).toBeInstanceOf(AbortSignal);

    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(request.requestId);
    expect(response.providerId).toBe("zai");
    expect(response.connectorId).toBe("zai");
    expect(response.accountRef).toBe(request.accountRef);
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();

    const report = response.report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("privateApi");
    expect(report.fetchedAtMs).toBe(NOW_MS);
    expect(report.connectorVersion).toBe("zai-1");
    expect(report.windows).toEqual(EXPECTED_WINDOWS);
    expectNoModelFields(response);
  });

  test("uses the shared wire severity bands", async () => {
    const limits = [
      { type: "TOKENS_LIMIT", usage: 600000, currentValue: 510000, percentage: 85, unit: 6 },
      { type: "TIME_LIMIT", usage: 1200, currentValue: 1152, percentage: 96, unit: 4, number: 1 },
      { type: "TOKENS_LIMIT", usage: 100, currentValue: 80, percentage: 80, unit: 3 },
      { type: "TOKENS_LIMIT", usage: 100, currentValue: 95, percentage: 95, unit: 5 },
      { type: "TOKENS_LIMIT", usage: 100, currentValue: 100, percentage: 100, unit: 99 },
    ];
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: { success: true, code: 200, data: { limits } } } });
    const response = await zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS });

    expect(response.report.windows.map((window) => window.severity)).toEqual([
      "warning",
      "critical",
      "warning",
      "critical",
      "exhausted",
    ]);
  });

  test("keeps the credential out of the serialized response", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: QUOTA_BODY } });
    const response = await zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(JSON.stringify(response)).not.toContain(RAW_KEY);
  });

  test("credits without absolute pairs retain percentage fallback and remaining-only units", async () => {
    const limits = [
      { type: "CREDIT_LIMIT", percentage: "80", unit: 3 },
      { type: "CREDIT_LIMIT", currentValue: "1438", usage: "12000", percentage: 11, unit: 6 },
      { type: "CREDIT_LIMIT", remaining: "25", unit: 5 },
    ];
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: { success: true, data: { limits } } } });
    const response = await zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows.map(window => window.unit)).toEqual(["credits", "credits", "credits"]);
    expect(response.report.windows.map(window => window.resolvedFraction)).toEqual([0.8, 1438 / 12000, undefined]);
    expect(response.report.windows.map(window => window.severity)).toEqual(["warning", "ok", "unknown"]);
    expect(response.report.windows[2]?.remaining).toBe(25);
  });

  test.each([
    { currentValue: -1, usage: 100 },
    { currentValue: 1, usage: 0, percentage: 50 },
    { currentValue: 1e308, usage: 1e-308 },
    { currentValue: 80, usage: 100, remaining: 30 },
    { remaining: -1 },
  ])("malformed credit amounts become typed errors rather than invalid Swift reports: %j", async amounts => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: {
      status: 200, body: { success: true, data: { limits: [{ type: "CREDIT_LIMIT", ...amounts }] } },
    } });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("malformedPayload");
  });

  test("empty credit rows do not fabricate a usable report", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: {
      status: 200, body: { success: true, data: { limits: [{ type: "CREDIT_LIMIT" }] } },
    } });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
  });
});

describe("zaiConnector — typed error paths", () => {
  test("rejects a foreign providerId with invalidProvider", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      zaiConnector.fetchUsage({
        request: zaiUsageRequest({ providerId: "anthropic" }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("invalidProvider");
    expect(fetcher.calls.length).toBe(0);
  });

  test("rejects an absent credential with missingCredential", async () => {
    const fetcher = mockFetcher([]);
    const request: BridgeRequest = {
      schemaVersion: "1.3.0",
      requestId: "00000000-0000-4000-8000-000000000001",
      operation: "fetchUsage",
      providerId: "zai",
      connectorId: "zai",
      accountRef: "00000000-0000-4000-8000-000000000002",
      requestedAtMs: 1787011200000,
      deadlineAtMs: 1787011210000,
    };
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("missingCredential");
  });

  test("maps 401 to authRequired", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 401, body: { code: 401, msg: "unauthorized" } } });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(RAW_KEY);
  });

  test("maps 429 with Retry-After to rateLimited with retryAfterMs", async () => {
    const fetcher = mockFetcher({
      [`GET ${QUOTA_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { code: 429, msg: "slow down" } },
    });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = async () => new Response("not-json{", { status: 200, headers: { "Content-Type": "application/json" } });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps a success:false envelope to noData (OMP null-report path)", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: { success: false, code: 40001, msg: "bad key" } } });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
    expect(error.message).toContain("bad key");
  });

  test("maps an empty limits array to noData (no-usable-rows rule)", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: { success: true, code: 200, data: { limits: [] } } } });
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
  });

  test("maps a network failure to transport", async () => {
    const fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("transport");
  });

  test("maps an aborted request to timeout", async () => {
    const fetcher = async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const error = await bridgeErrorFrom(() => zaiConnector.fetchUsage({ request: zaiUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Auth module — apiKey method
// ---------------------------------------------------------------------------

const VALIDATION_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";

describe("zaiAuth — apiKey method", () => {
  test("validates the pasted key with the exact OMP request and returns an apiKey credential", async () => {
    const fetcher = mockFetcher({ [`POST ${VALIDATION_URL}`]: { status: 200, body: {} } });
    const collector = eventCollector();
    const loginRequest = buildLoginRequest({
      providerId: "zai",
      method: "apiKey",
      inputs: { apiKey: `  ${RAW_KEY}  ` },
    });

    const result = await loginZai(
      "apiKey",
      loginRequest.inputs ?? {},
      collector.events,
      AbortSignal.timeout(10_000),
      { fetcher },
    );

    expect(fetcher.calls.length).toBe(1);
    const validationCall = fetcher.calls[0];
    if (validationCall === undefined) {
      throw new Error("expected the validation endpoint to be called");
    }
    expect(validationCall.method).toBe("POST");
    expect(validationCall.url).toBe(VALIDATION_URL);
    const headers = new Headers(validationCall.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${RAW_KEY}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(validationCall.init.body))).toEqual({
      model: "glm-5.2",
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 1,
      temperature: 0,
    });

    // The key is trimmed like OMP's apiKey.trim().
    expect(result.credential).toEqual({ kind: "apiKey", secret: RAW_KEY });
    expect(result.accountLabel).toBeUndefined();

    const pasteHint = collector.received().find((event) => event.type === "pasteHint");
    expect(pasteHint).toBeDefined();
    expect(collector.received().some((event) => event.type === "waiting")).toBe(true);
  });

  test("rejects a missing pasted key with invalidRequest before any upstream call", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      loginZai("apiKey", {}, eventCollector().events, AbortSignal.timeout(10_000), { fetcher }),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(fetcher.calls.length).toBe(0);
  });

  test("maps a rejected key to authRequired without leaking the key", async () => {
    const fetcher = mockFetcher({ [`POST ${VALIDATION_URL}`]: { status: 401, body: { error: "invalid api key" } } });
    const error = await bridgeErrorFrom(() =>
      loginZai(
        "apiKey",
        { apiKey: RAW_KEY },
        eventCollector().events,
        AbortSignal.timeout(10_000),
        { fetcher },
      ),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(RAW_KEY);
  });
});

// ---------------------------------------------------------------------------
// Auth module — browser method (ZCode-like authorization-code mint flow)
// ---------------------------------------------------------------------------

const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const BUSINESS_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
const CUSTOMER_INFO_URL = "https://api.z.ai/api/biz/customer/getCustomerInfo";
const KEYS_URL = "https://api.z.ai/api/biz/v1/organization/org-2/projects/proj-b/api_keys";

const OAUTH_ACCESS_TOKEN = "zai-oauth-access-unit";
const BIZ_TOKEN = "zai-biz-token-unit";
const API_KEY_ID = "ak_1234567890abcdef";
const SECRET_KEY = "sk_secret_unit_value";
const AUTH_CODE = "zai-auth-code-unit";

const TOKEN_BODY = {
  code: 0,
  msg: "ok",
  data: {
    zai: { access_token: OAUTH_ACCESS_TOKEN },
    user: { email: "dev@example.com", id: 12345 },
  },
};

const CUSTOMER_BODY = {
  code: 200,
  data: {
    organizations: [
      { organizationId: "org-1", isDefault: false, projects: [{ projectId: "proj-x", isDefault: false }] },
      {
        organizationId: "org-2",
        isDefault: true,
        projects: [
          { projectId: "proj-a", isDefault: false },
          { projectId: "proj-b", isDefault: true },
        ],
      },
    ],
  },
};

/**
 * Runs the actual browser entry with a controlled App-style openUrl consumer
 * and duplex paste. Only the external HTTP boundary is replaced.
 */
async function runBrowserFlow(
  routes: Parameters<typeof mockFetcher>[0],
): Promise<{
  readonly result: Awaited<ReturnType<typeof loginZai>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly openedUrls: string[];
  readonly authorizeUrl: URL;
  readonly redirectUri: string;
}> {
  const fetcher = mockFetcher(routes);
  const collector = eventCollector();
  const openedUrls: string[] = [];
  const controller = new AbortController();

  let authorizeUrl: URL | undefined;
  let redirectUri: string | undefined;
  try {
    const result = await loginZai("browser", {}, {
      onEvent: event => {
        collector.events.onEvent(event);
        if (event.type === "openUrl") {
          // Same surface as the App's browser opener, without OS side effects.
          openedUrls.push(event.url);
          authorizeUrl = new URL(event.url);
          redirectUri = authorizeUrl.searchParams.get("redirect_uri") ?? undefined;
        }
      },
      requestInput: async prompt => {
        expect(prompt.inputKind).toBe("redirectUrl");
        expect(prompt.sensitive).toBe(true);
        expect(fetcher.calls).toHaveLength(0);
        const state = authorizeUrl?.searchParams.get("state");
        if (redirectUri === undefined || !state) throw new Error("missing callback parameters");
        return `${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`;
      },
    }, controller.signal, {
      fetcher,
      openBrowser: () => { throw new Error("provider must not double-open the browser"); },
    });
    if (authorizeUrl === undefined || redirectUri === undefined) throw new Error("missing authorize event");
    return { result, fetcher, collector, openedUrls, authorizeUrl, redirectUri };
  } finally {
    controller.abort();
  }
}

describe("zaiAuth — browser method", () => {
  test("latest authorize request uses only the allowlisted custom callback", async () => {
    const collector = eventCollector();
    const controller = new AbortController();
    const opened = collector.waitFor("openUrl");
    const login = loginZai("browser", {}, collector.events, controller.signal, { fetcher: mockFetcher([]) });
    const outcome = Promise.allSettled([login]);
    try {
      const event = await opened;
      if (event.type !== "openUrl") throw new Error("expected browser URL");
      expect(new URL(event.url).searchParams.get("redirect_uri")).toBe("zcode://zai-auth/callback");
    } finally {
      controller.abort();
      await outcome;
    }
  });

  test("mints the durable id.secret key through the full ZCode-like flow", async () => {
    const { result, fetcher, collector, openedUrls, authorizeUrl, redirectUri } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`POST ${BUSINESS_LOGIN_URL}`]: { status: 200, body: { code: 200, success: true, data: { access_token: BIZ_TOKEN } } },
      [`GET ${CUSTOMER_INFO_URL}`]: { status: 200, body: CUSTOMER_BODY },
      [`GET ${KEYS_URL}`]: { status: 200, body: { code: 200, data: { list: [{ name: "scratch", apiKey: "ak_old" }, { name: "oh-my-pi", apiKey: API_KEY_ID }] } } },
      [`GET ${KEYS_URL}/copy/${API_KEY_ID}`]: { status: 200, body: { code: 200, data: { secretKey: SECRET_KEY } } },
    });

    // Authorize URL: chat.z.ai, ZCode client id, response_type=code, the
    // allowlisted custom redirect_uri, 32-hex state and NO PKCE challenge.
    expect(authorizeUrl.origin).toBe("https://chat.z.ai");
    expect(authorizeUrl.pathname).toBe("/api/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(redirectUri).toBe("zcode://zai-auth/callback");
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(authorizeUrl.searchParams.has("code_challenge")).toBe(false);
    expect(openedUrls).toEqual([authorizeUrl.toString()]);

    // Events: openUrl, the OMP paste-fallback hint, and progress events.
    expect(collector.received().some((event) => event.type === "pasteHint")).toBe(true);
    expect(collector.received().filter((event) => event.type === "waiting").length).toBeGreaterThanOrEqual(2);

    // Token exchange: non-standard body (no grant_type, no code_verifier),
    // Content-Type JSON, no Authorization header.
    const tokenCall = fetcher.calls[0];
    if (tokenCall === undefined) {
      throw new Error("expected a token exchange call");
    }
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).toBe(TOKEN_URL);
    expect(new Headers(tokenCall.init.headers).get("Authorization")).toBeNull();
    expect(JSON.parse(String(tokenCall.init.body))).toEqual({
      provider: "zai",
      code: AUTH_CODE,
      redirect_uri: redirectUri,
      state: authorizeUrl.searchParams.get("state"),
    });

    // Business login exchanges the OAuth access token for a biz token.
    const loginCall = fetcher.calls[1];
    if (loginCall === undefined) {
      throw new Error("expected a business login call");
    }
    expect(loginCall.method).toBe("POST");
    expect(loginCall.url).toBe(BUSINESS_LOGIN_URL);
    expect(JSON.parse(String(loginCall.init.body))).toEqual({ token: OAUTH_ACCESS_TOKEN });

    // Customer lookup + key list + secret copy ride the biz token (Bearer),
    // scoped to the default org/project (org-2/proj-b).
    const [customerCall, listCall, copyCall] = [fetcher.calls[2], fetcher.calls[3], fetcher.calls[4]];
    if (customerCall === undefined || listCall === undefined || copyCall === undefined) {
      throw new Error("expected customer/list/copy calls");
    }
    expect(customerCall.url).toBe(CUSTOMER_INFO_URL);
    expect(listCall.url).toBe(KEYS_URL);
    expect(copyCall.url).toBe(`${KEYS_URL}/copy/${API_KEY_ID}`);
    for (const call of [customerCall, listCall, copyCall]) {
      expect(call.method).toBe("GET");
      expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${BIZ_TOKEN}`);
    }

    // Existing "oh-my-pi" key is reused: no create POST happened.
    expect(fetcher.calls.length).toBe(5);

    expect(result.credential).toEqual({ kind: "apiKey", secret: `${API_KEY_ID}.${SECRET_KEY}` });
    expect(result.accountLabel).toBe("dev@example.com");
  });

  test("creates the oh-my-pi key when the account has none, with the OMP body", async () => {
    const { result, fetcher } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`POST ${BUSINESS_LOGIN_URL}`]: { status: 200, body: { code: 200, success: true, data: { accessToken: BIZ_TOKEN } } },
      [`GET ${CUSTOMER_INFO_URL}`]: { status: 200, body: CUSTOMER_BODY },
      [`GET ${KEYS_URL}`]: { status: 200, body: { code: 200, data: { list: [] } } },
      [`POST ${KEYS_URL}`]: { status: 200, body: { code: 200, data: { name: "oh-my-pi", apiKey: "ak_newlyminted" } } },
      [`GET ${KEYS_URL}/copy/ak_newlyminted`]: { status: 200, body: { code: 200, data: { secretKey: "sk_created_unit" } } },
    });

    const createCall = fetcher.calls.find((call) => call.method === "POST" && call.url === KEYS_URL);
    if (createCall === undefined) {
      throw new Error("expected an api key create call");
    }
    expect(JSON.parse(String(createCall.init.body))).toEqual({ name: "oh-my-pi" });
    expect(new Headers(createCall.init.headers).get("Authorization")).toBe(`Bearer ${BIZ_TOKEN}`);
    expect(result.credential).toEqual({ kind: "apiKey", secret: "ak_newlyminted.sk_created_unit" });
  });

  test("maps an envelope failure at token exchange to upstreamError", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: { code: 40001, msg: "invalid authorization code" } },
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.message).toContain("invalid authorization code");
    expect(error.message).toContain("token exchange");
  });

  test("maps a business login without an access token to malformedPayload", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
        [`POST ${BUSINESS_LOGIN_URL}`]: { status: 200, body: { code: 200, success: true, data: {} } },
      }),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("business login");
  });

  test("maps an account without organization/project to malformedPayload", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
        [`POST ${BUSINESS_LOGIN_URL}`]: { status: 200, body: { code: 200, success: true, data: { access_token: BIZ_TOKEN } } },
        [`GET ${CUSTOMER_INFO_URL}`]: { status: 200, body: { code: 200, data: { organizations: [{ organizationId: "org-9", isDefault: true }] } } },
      }),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("no organization/project");
  });

  test("maps an aborted login signal to a timeout BridgeError with a cancelled message", async () => {
    const fetcher = mockFetcher([]);
    const collector = eventCollector();
    const controller = new AbortController();
    const opened = collector.waitFor("openUrl");
    const loginPromise = loginZai("browser", {}, {
      ...collector.events,
      requestInput: (_prompt, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
    });
    await opened;
    controller.abort(new Error("user closed the browser"));

    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(fetcher.calls.length).toBe(0);
  });
});

describe("zaiAuth — manual paste fallback (OMP onManualCodeInput race)", () => {
  /** AuthEvents whose requestInput records prompts and replays pastes on demand. */
  function pasteCollector(collector: ReturnType<typeof eventCollector>): {
    readonly events: AuthEvents;
    readonly ready: EventTarget;
    prompts(): readonly { readonly inputKind: string; readonly sensitive: boolean }[];
    waitForPrompts(count: number, signal: AbortSignal): Promise<void>;
    pendingResponses(): number;
    respond(paste: string): void;
  } {
    const prompts: { readonly inputKind: string; readonly sensitive: boolean }[] = [];
    const responders: Array<(value: string) => void> = [];
    const ready = new EventTarget();
    return {
      ready,
      events: {
        onEvent: collector.events.onEvent,
        requestInput: (prompt, requestSignal) => {
          prompts.push({ inputKind: prompt.inputKind, sensitive: prompt.sensitive });
          expect(requestSignal.aborted).toBe(false);
          const { promise, resolve, reject } = Promise.withResolvers<string>();
          const respond = (value: string): void => {
            requestSignal.removeEventListener("abort", onAbort);
            resolve(value);
          };
          const onAbort = (): void => {
            responders.splice(responders.indexOf(respond), 1);
            requestSignal.removeEventListener("abort", onAbort);
            reject(requestSignal.reason);
          };
          responders.push(respond);
          requestSignal.addEventListener("abort", onAbort);
          ready.dispatchEvent(new Event("ready"));
          return promise;
        },
      },
      prompts: () => prompts,
      waitForPrompts: (count, signal) => waitForCount(() => prompts.length, count, ready, { signal }),
      pendingResponses: () => responders.length,
      respond: (paste) => {
        const resolve = responders.shift();
        if (resolve === undefined) {
          throw new Error("no pending manual paste request");
        }
        resolve(paste);
      },
    };
  }

  function redirectFrom(collector: ReturnType<typeof eventCollector>): { readonly redirectUri: string; readonly state: string } {
    const openEvent = collector.received().find((event) => event.type === "openUrl");
    if (openEvent?.type !== "openUrl") {
      throw new Error("expected an openUrl event");
    }
    const authorizeUrl = new URL(openEvent.url);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
    const state = authorizeUrl.searchParams.get("state");
    if (redirectUri === null || state === null) {
      throw new Error("authorize URL carries no redirect_uri/state");
    }
    return { redirectUri, state };
  }

  const MINT_ROUTES = {
    [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
    [`POST ${BUSINESS_LOGIN_URL}`]: { status: 200, body: { code: 200, success: true, data: { access_token: BIZ_TOKEN } } },
    [`GET ${CUSTOMER_INFO_URL}`]: { status: 200, body: CUSTOMER_BODY },
    [`GET ${KEYS_URL}`]: { status: 200, body: { code: 200, data: { list: [{ name: "oh-my-pi", apiKey: API_KEY_ID }] } } },
    [`GET ${KEYS_URL}/copy/${API_KEY_ID}`]: { status: 200, body: { code: 200, data: { secretKey: SECRET_KEY } } },
  } as const;

  test("resolves the browser flow through a pasted redirect URL on the duplex channel", async () => {
    const fetcher = mockFetcher(MINT_ROUTES);
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginZai("browser", {}, pastes.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
    });
    await Promise.all([collector.waitFor("openUrl"), firstPrompt]);
    const { redirectUri, state } = redirectFrom(collector);

    pastes.respond(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
    const result = await loginPromise;
    expect(pastes.pendingResponses()).toBe(0);
    expect(redirectUri).toBe("zcode://zai-auth/callback");

    expect(pastes.prompts()).toEqual([{ inputKind: "redirectUrl", sensitive: true }]);
    // The mint ran to completion over the pasted code: exactly the 5 upstream
    // calls of the existing-key path, no loopback redirect involved.
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `POST ${BUSINESS_LOGIN_URL}`,
      `GET ${CUSTOMER_INFO_URL}`,
      `GET ${KEYS_URL}`,
      `GET ${KEYS_URL}/copy/${API_KEY_ID}`,
    ]);
    const exchangeBody = JSON.parse(String(fetcher.calls[0]?.init.body)) as Record<string, string>;
    expect(exchangeBody["code"]).toBe(AUTH_CODE);
    expect(exchangeBody["state"]).toBe(state);
    expect(result.credential).toEqual({ kind: "apiKey", secret: `${API_KEY_ID}.${SECRET_KEY}` });
  });

  test("re-prompts when the paste carries a mismatched state, then accepts", async () => {
    const fetcher = mockFetcher(MINT_ROUTES);
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginZai("browser", {}, pastes.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
    });
    await Promise.all([collector.waitFor("openUrl"), firstPrompt]);
    const { redirectUri, state } = redirectFrom(collector);

    const pendingAtReady: number[] = [];
    const recordReady = (): void => { pendingAtReady.push(pastes.pendingResponses()); };
    pastes.ready.addEventListener("ready", recordReady);
    const retryReady = pastes.waitForPrompts(2, controller.signal);
    try {
      pastes.respond(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=forged`);
      await retryReady;
      expect(pendingAtReady).toEqual([1]);
      expect(fetcher.calls).toHaveLength(0);
      expect(pastes.pendingResponses()).toBe(1);
      pastes.respond(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
      await loginPromise;

      expect(pastes.prompts()).toHaveLength(2);
      const exchangeBody = JSON.parse(String(fetcher.calls[0]?.init.body)) as Record<string, string>;
      expect(exchangeBody["state"]).toBe(state);
    } finally {
      pastes.ready.removeEventListener("ready", recordReady);
      controller.abort();
      // Drain the login even when a readiness assertion/timeout fails.
      await Promise.allSettled([loginPromise, retryReady]);
      expect(pastes.pendingResponses()).toBe(0);
      expect(redirectUri).toBe("zcode://zai-auth/callback");
    }
  });

  test("cancellation while a manual-only paste is pending drains the prompt", async () => {
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginZai("browser", {}, pastes.events, controller.signal, {
      fetcher: mockFetcher([]),
      openBrowser: () => undefined,
    });
    await Promise.all([collector.waitFor("openUrl"), firstPrompt]);
    const { redirectUri } = redirectFrom(collector);

    expect(pastes.pendingResponses()).toBe(1);
    const reason = new Error("user cancelled");
    const nextPrompt = pastes.waitForPrompts(2, controller.signal);
    const cancelledPrompt = Promise.allSettled([nextPrompt]);
    controller.abort(reason);
    expect(await cancelledPrompt).toEqual([{ status: "rejected", reason }]);
    expect(pastes.pendingResponses()).toBe(0);
    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(redirectUri).toBe("zcode://zai-auth/callback");
  });
});

describe("zaiAuth — module surface", () => {
  test("offers apiKey and browser methods and rejects unknown methods", async () => {
    expect(zaiAuth.providerId).toBe("zai");
    expect(zaiAuth.methods).toEqual(["apiKey", "browser"]);
    expect(zaiConnector.providerId).toBe("zai");
    expect(zaiConnector.connectorVersion).toBe("zai-1");

    const error = await bridgeErrorFrom(() =>
      zaiAuth.login("device", {}, eventCollector().events, AbortSignal.timeout(50)),
    );
    expect(error.kind).toBe("invalidRequest");
  });
});
