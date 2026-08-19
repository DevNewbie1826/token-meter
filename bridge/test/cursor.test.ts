import { describe, expect, test } from "bun:test";
import { cursorAuth, cursorConnector, extractCursorAccessTokenUserId, loginCursor, refreshCursorCredential } from "../src/providers/cursor";
import { BridgeError } from "../src/protocol";
import type { BridgeCredential, BridgeRequest, UsageWindow } from "../src/protocol";
import type { AuthEvent, AuthEvents } from "../src/dispatch";
import type { UsageRequestOverrides } from "./helpers";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";

// ---------------------------------------------------------------------------
// Shared fixtures (OMP-shaped payloads, packages/ai/src/usage/cursor.ts)
// ---------------------------------------------------------------------------

const NOW_MS = 1787011200500;
const ACCESS_EXP = 1787700000;
const NEW_EXP = 1787800000;
const AUG_1_MS = Date.parse("2026-08-01T00:00:00.000Z");
const SEP_1_MS = Date.parse("2026-09-01T00:00:00.000Z");

const AUTH_USAGE_URL = "https://api2.cursor.sh/auth/usage";
const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";
const LOGIN_URL = "https://cursor.com/loginDeepControl";
const POLL_URL = "https://api2.cursor.sh/auth/poll";

function cursorJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "sig",
  ].join(".");
}

const ACCESS_TOKEN = cursorJwt({ sub: "user_accounts|user-789", exp: ACCESS_EXP, email: "dev@example.com" });
const NEW_TOKEN = cursorJwt({ sub: "user_accounts|user-789", exp: NEW_EXP });

function dashboardCookie(token: string): string {
  return `WorkosCursorSessionToken=${encodeURIComponent(`user-789::${token}`)}`;
}

/** /auth/usage payload: legacy request/USD buckets plus an unusable row. */
const AUTH_USAGE_BODY = {
  startOfMonth: "2026-08-01T00:00:00.000Z",
  coreRequests: { numRequests: 120, maxRequestUsage: 500 },
  planUsage: { numRequests: 2400, maxRequestUsage: 20000 },
  cacheRequests: { numRequests: 10 },
};

/** cursor.com/api/usage-summary payload: Pro+ plan rails + on-demand cents. */
const SUMMARY_BODY = {
  billingCycleEnd: "2026-09-01T00:00:00.000Z",
  individualUsage: {
    plan: { enabled: true, limit: 20000, autoPercentUsed: 92, apiPercentUsed: 15 },
    onDemand: { used: 700, limit: 3000 },
  },
};

// OMP normalization: legacy rows first (requests + planUsage-as-USD), then
// the dashboard rails (auto percent row never invents a limit; api row
// resolves its percent against the cents limit; on-demand is cents/100).
const EXPECTED_WINDOWS: readonly UsageWindow[] = [
  {
    id: "cursor:requests:corerequests",
    label: "coreRequests requests",
    unit: "requests",
    resolvedFraction: 120 / 500,
    severity: "ok",
    used: 120,
    limit: 500,
    resetsAtMs: SEP_1_MS,
  },
  {
    id: "cursor:usd:planusage",
    label: "planUsage spend",
    unit: "usd",
    resolvedFraction: 2400 / 20000,
    severity: "ok",
    used: 2400,
    limit: 20000,
    resetsAtMs: SEP_1_MS,
  },
  {
    id: "cursor:usd:individual-auto",
    label: "Cursor Models",
    unit: "percent",
    resolvedFraction: 92 / 100,
    severity: "warning",
    used: 92,
    resetsAtMs: SEP_1_MS,
  },
  {
    id: "cursor:usd:individual-api",
    label: "Other Models",
    unit: "usd",
    resolvedFraction: 15 / 100,
    severity: "ok",
    used: 200 * (15 / 100),
    limit: 200,
    resetsAtMs: SEP_1_MS,
  },
  {
    id: "cursor:usd:individual-ondemand",
    label: "On-Demand Usage",
    unit: "usd",
    resolvedFraction: 700 / 3000,
    severity: "ok",
    used: 7,
    limit: 30,
    resetsAtMs: SEP_1_MS,
  },
];

function usageRequest(overrides: UsageRequestOverrides = {}): BridgeRequest {
  return buildUsageRequest({ providerId: "cursor", connectorId: "cursor", ...overrides });
}

type OAuthFields = {
  readonly expiresAtMs?: number;
  readonly refresh?: string;
  readonly identity?: Readonly<Record<string, string>>;
};

function oauthCredential(fields: OAuthFields = {}): BridgeCredential {
  return {
    kind: "oauth",
    secret: ACCESS_TOKEN,
    oauth: {
      access: ACCESS_TOKEN,
      refresh: fields.refresh ?? "login-refresh",
      ...(fields.expiresAtMs !== undefined ? { expiresAtMs: fields.expiresAtMs } : {}),
      refreshEndpoint: REFRESH_URL,
      ...(fields.identity !== undefined ? { identity: fields.identity } : {}),
    },
  };
}

async function bridgeErrorFrom(action: () => Promise<unknown>): Promise<BridgeError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BridgeError) {
      return error;
    }
    throw error;
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
        const entry: Waiter = {
          type,
          resolve,
          timer,
        };
        waiterRef.entry = entry;
        waiters.push(entry);
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Usage connector
// ---------------------------------------------------------------------------

describe("cursorConnector — usage mapping over the exact upstream calls", () => {
  test("merges /auth/usage rows with the dashboard usage-summary rails (OAuth)", async () => {
    const fetcher = mockFetcher({
      [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: AUTH_USAGE_BODY },
      [`GET ${USAGE_SUMMARY_URL}`]: { status: 200, body: SUMMARY_BODY },
    });
    const request = usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 }) });

    const response = await cursorConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    // Primary call: GET api2.cursor.sh/auth/usage with the Bearer access token.
    expect(fetcher.calls.length).toBe(2);
    const usageCall = fetcher.calls[0];
    if (usageCall === undefined) {
      throw new Error("expected an auth usage call");
    }
    expect(usageCall.method).toBe("GET");
    expect(usageCall.url).toBe(AUTH_USAGE_URL);
    expect(new Headers(usageCall.init.headers).get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(new Headers(usageCall.init.headers).get("Accept")).toBe("application/json");

    // Dashboard call: the synthesized WorkosCursorSessionToken cookie (JWT
    // subject after "|" + token), exactly as OMP builds it; no Bearer header.
    const summaryCall = fetcher.calls[1];
    if (summaryCall === undefined) {
      throw new Error("expected a usage summary call");
    }
    expect(summaryCall.method).toBe("GET");
    expect(summaryCall.url).toBe(USAGE_SUMMARY_URL);
    expect(new Headers(summaryCall.init.headers).get("Cookie")).toBe(dashboardCookie(ACCESS_TOKEN));
    expect(new Headers(summaryCall.init.headers).get("Authorization")).toBeNull();

    expect(response.report).toEqual({
      productKind: "quota",
      sourceKind: "privateApi",
      fetchedAtMs: NOW_MS,
      connectorVersion: "cursor-1",
      windows: EXPECTED_WINDOWS,
    });
    expect("refreshedCredential" in response).toBe(false);
    expectNoModelFields(response.report);
    expect(JSON.stringify(response)).not.toContain(ACCESS_TOKEN);
  });

  test("bearer credentials hit only /auth/usage (no dashboard cookie)", async () => {
    const fetcher = mockFetcher({ [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: AUTH_USAGE_BODY } });
    const response = await cursorConnector.fetchUsage({
      request: usageRequest({ credential: { kind: "bearer", secret: ACCESS_TOKEN } }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.length).toBe(1);
    expect(response.report.windows.map((window) => window.id)).toEqual([
      "cursor:requests:corerequests",
      "cursor:usd:planusage",
    ]);
  });

  test("prefers the overall cents bucket over plan rails and infers resets from endOfMonth", async () => {
    const summaryBody = {
      endOfMonth: SEP_1_MS / 1000,
      individualUsage: {
        overall: { used: 1500, limit: 10000 },
        plan: { limit: 10000, autoPercentUsed: 50, apiPercentUsed: 50 },
        onDemand: { remaining: 1800, limit: 2000 },
      },
    };
    const fetcher = mockFetcher({
      [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: {} },
      [`GET ${USAGE_SUMMARY_URL}`]: { status: 200, body: summaryBody },
    });
    const response = await cursorConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(response.report.windows).toEqual([
      {
        id: "cursor:usd:individual-overall",
        label: "Personal Usage",
        unit: "usd",
        resolvedFraction: 1500 / 10000,
        severity: "ok",
        used: 15,
        limit: 100,
        resetsAtMs: SEP_1_MS,
      },
      {
        id: "cursor:usd:individual-ondemand",
        label: "On-Demand Usage",
        unit: "usd",
        resolvedFraction: 200 / 2000,
        severity: "ok",
        used: 2,
        limit: 20,
        resetsAtMs: SEP_1_MS,
      },
    ]);
  });

  test("keeps the legacy rows when the dashboard summary fails (OMP soft-fail)", async () => {
    const fetcher = mockFetcher({
      [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: AUTH_USAGE_BODY },
      [`GET ${USAGE_SUMMARY_URL}`]: { status: 500, body: { error: "boom" } },
    });
    const response = await cursorConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(response.report.windows.map((window) => window.id)).toEqual([
      "cursor:requests:corerequests",
      "cursor:usd:planusage",
    ]);
  });
});

describe("cursorConnector — typed error paths", () => {
  test("rejects a foreign providerId with invalidProvider before any call", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({ request: usageRequest({ providerId: "zai" }), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("invalidProvider");
    expect(fetcher.calls.length).toBe(0);
  });

  test("rejects an absent credential with missingCredential", async () => {
    const request: BridgeRequest = { ...usageRequest() };
    const { credential: _credential, ...withoutCredential } = request;
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({ request: withoutCredential, fetcher: mockFetcher([]), nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("missingCredential");
  });

  test("maps 401 to authRequired without leaking the token", async () => {
    const fetcher = mockFetcher({ [`GET ${AUTH_USAGE_URL}`]: { status: 401, body: { error: "unauthorized" } } });
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        request: usageRequest({ credential: { kind: "bearer", secret: ACCESS_TOKEN } }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });

  test("maps 429 with Retry-After to rateLimited with retryAfterMs", async () => {
    const fetcher = mockFetcher({
      [`GET ${AUTH_USAGE_URL}`]: { status: 429, headers: { "retry-after": "2" }, body: { error: "slow down" } },
    });
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        request: usageRequest({ credential: { kind: "bearer", secret: ACCESS_TOKEN } }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(2000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = async () => new Response("not-json{", { status: 200, headers: { "Content-Type": "application/json" } });
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        request: usageRequest({ credential: { kind: "bearer", secret: ACCESS_TOKEN } }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps an empty payload to noData (no-usable-rows rule)", async () => {
    const fetcher = mockFetcher({ [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: {} } });
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        request: usageRequest({ credential: { kind: "bearer", secret: ACCESS_TOKEN } }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("noData");
  });
});

// ---------------------------------------------------------------------------
// Usage connector — OAuth rotation contract
// ---------------------------------------------------------------------------

describe("cursorConnector — OAuth rotation", () => {
  test("pre-rotates a near-expiry token before the first upstream call and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({
      [`POST ${REFRESH_URL}`]: { status: 200, body: { accessToken: NEW_TOKEN, refreshToken: "new-refresh" } },
      [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: AUTH_USAGE_BODY },
      [`GET ${USAGE_SUMMARY_URL}`]: { status: 200, body: SUMMARY_BODY },
    });
    const credential = oauthCredential({
      expiresAtMs: NOW_MS + 30_000,
      refresh: "old-refresh",
      identity: { userId: "user-789" },
    });

    const response = await cursorConnector.fetchUsage({ request: usageRequest({ credential }), fetcher, nowMs: NOW_MS });

    // Rotation first, with OMP's exact exchange request.
    const refreshCall = fetcher.calls[0];
    if (refreshCall === undefined) {
      throw new Error("expected a token refresh call");
    }
    expect(refreshCall.method).toBe("POST");
    expect(refreshCall.url).toBe(REFRESH_URL);
    expect(new Headers(refreshCall.init.headers).get("Authorization")).toBe("Bearer old-refresh");
    expect(new Headers(refreshCall.init.headers).get("Content-Type")).toBe("application/json");
    expect(refreshCall.init.body).toBe("{}");

    // Every later call rides the rotated token.
    expect(fetcher.calls.length).toBe(3);
    const usageCall = fetcher.calls[1];
    const summaryCall = fetcher.calls[2];
    if (usageCall === undefined || summaryCall === undefined) {
      throw new Error("expected usage and summary calls after rotation");
    }
    expect(new Headers(usageCall.init.headers).get("Authorization")).toBe(`Bearer ${NEW_TOKEN}`);
    expect(new Headers(summaryCall.init.headers).get("Cookie")).toBe(dashboardCookie(NEW_TOKEN));

    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: NEW_TOKEN,
      oauth: {
        access: NEW_TOKEN,
        refresh: "new-refresh",
        expiresAtMs: NEW_EXP * 1000 - 5 * 60 * 1000,
        refreshEndpoint: REFRESH_URL,
        identity: { userId: "user-789" },
      },
    });
    expectNoModelFields(response.report);
  });

  test("pre-rotates when expiresAtMs is missing entirely", async () => {
    const fetcher = mockFetcher({
      [`POST ${REFRESH_URL}`]: { status: 200, body: { accessToken: NEW_TOKEN, refreshToken: "new-refresh" } },
      [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: AUTH_USAGE_BODY },
      [`GET ${USAGE_SUMMARY_URL}`]: { status: 200, body: SUMMARY_BODY },
    });
    // oauthCredential omits expiresAtMs when not provided (missing expiry).
    const response = await cursorConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ refresh: "old-refresh" }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls[0]?.url).toBe(REFRESH_URL);
    const refreshed = response.refreshedCredential;
    expect(refreshed?.kind === "oauth" ? refreshed.oauth.access : undefined).toBe(NEW_TOKEN);
  });

  test("rotates once and retries once on a mid-flow 401", async () => {
    let usageHits = 0;
    const fetcher = mockFetcher([
      {
        when: (method, url) => method === "GET" && url === AUTH_USAGE_URL && usageHits++ === 0,
        respond: { status: 401, body: { error: "unauthorized" } },
      },
      { when: (method, url) => method === "GET" && url === AUTH_USAGE_URL, respond: { status: 200, body: AUTH_USAGE_BODY } },
      { when: (method, url) => method === "POST" && url === REFRESH_URL, respond: { status: 200, body: { accessToken: NEW_TOKEN, refreshToken: "new-refresh" } } },
      { when: (method, url) => method === "GET" && url === USAGE_SUMMARY_URL, respond: { status: 200, body: SUMMARY_BODY } },
    ]);

    const response = await cursorConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000, refresh: "old-refresh" }) }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${AUTH_USAGE_URL}`,
      `POST ${REFRESH_URL}`,
      `GET ${AUTH_USAGE_URL}`,
      `GET ${USAGE_SUMMARY_URL}`,
    ]);
    expect(new Headers(fetcher.calls[2]?.init.headers).get("Authorization")).toBe(`Bearer ${NEW_TOKEN}`);
    expect(new Headers(fetcher.calls[3]?.init.headers).get("Cookie")).toBe(dashboardCookie(NEW_TOKEN));
    const refreshed = response.refreshedCredential;
    expect(refreshed?.kind === "oauth" ? refreshed.oauth.refresh : undefined).toBe("new-refresh");
    expect(response.report.windows.map((window) => window.id)).toContain("cursor:usd:individual-auto");
  });

  test("maps a refresh response without an access token to authRequired", async () => {
    const fetcher = mockFetcher({
      [`POST ${REFRESH_URL}`]: { status: 200, body: {} },
    });
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 30_000, refresh: "old-refresh" }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain("old-refresh");
  });

  test("keeps the pre-rotated credential on the error envelope when the usage call fails afterwards", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${REFRESH_URL}`, respond: { status: 200, body: { accessToken: NEW_TOKEN, refreshToken: "new-refresh" } } },
      {
        when: `GET ${AUTH_USAGE_URL}`,
        respond: { status: 429, headers: { "retry-after": "23" }, body: { error: "slow down" } },
      },
    ]);
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        // Missing expiresAtMs forces the pre-rotation; refresh material exists.
        request: usageRequest({ credential: oauthCredential({ refresh: "old-refresh", identity: { userId: "user-789" } }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(23_000);
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${REFRESH_URL}`,
      `GET ${AUTH_USAGE_URL}`,
    ]);
    // The rotated bundle rides the error so the caller persists it before
    // surfacing the failure — the old refresh token is burned server-side.
    expect(error.refreshedCredential).toEqual({
      kind: "oauth",
      secret: NEW_TOKEN,
      oauth: {
        access: NEW_TOKEN,
        refresh: "new-refresh",
        expiresAtMs: NEW_EXP * 1000 - 5 * 60 * 1000,
        refreshEndpoint: REFRESH_URL,
        identity: { userId: "user-789" },
      },
    });
  });

  test("keeps the mid-flow-rotated credential on the error envelope when the retried usage call fails", async () => {
    let usageHits = 0;
    const fetcher = mockFetcher([
      {
        when: (method, url) => method === "GET" && url === AUTH_USAGE_URL && usageHits++ === 0,
        respond: { status: 401, body: { error: "unauthorized" } },
      },
      { when: (method, url) => method === "GET" && url === AUTH_USAGE_URL, respond: { status: 500, body: { error: "boom" } } },
      { when: `POST ${REFRESH_URL}`, respond: { status: 200, body: { accessToken: NEW_TOKEN, refreshToken: "new-refresh" } } },
    ]);
    const error = await bridgeErrorFrom(() =>
      cursorConnector.fetchUsage({
        request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000, refresh: "old-refresh" }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.refreshedCredential?.kind).toBe("oauth");
    if (error.refreshedCredential?.kind !== "oauth") {
      throw new Error("expected the rotated credential on the error envelope");
    }
    expect(error.refreshedCredential.oauth.access).toBe(NEW_TOKEN);
    expect(error.refreshedCredential.oauth.refresh).toBe("new-refresh");
    expect(error.message).not.toContain(NEW_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// Auth module — browser method (OMP loginCursor + pollCursorAuth)
// ---------------------------------------------------------------------------

const instantSleep = () => Promise.resolve();

describe("cursorAuth — browser method", () => {
  test("opens the PKCE+UUID loginDeepControl URL and polls until the token pair lands", async () => {
    let pollHits = 0;
    const fetcher = mockFetcher([
      {
        when: (method, url) => method === "GET" && url.startsWith(`${POLL_URL}?`) && pollHits++ === 0,
        respond: { status: 404 },
      },
      {
        when: (method, url) => method === "GET" && url.startsWith(`${POLL_URL}?`),
        respond: { status: 200, body: { accessToken: ACCESS_TOKEN, refreshToken: "login-refresh-token" } },
      },
    ]);
    const collector = eventCollector();
    const openedUrls: string[] = [];

    const result = await loginCursor("browser", {}, collector.events, AbortSignal.timeout(5000), {
      fetcher,
      openBrowser: (url) => {
        openedUrls.push(url);
      },
      sleep: instantSleep,
    });

    // openUrl event carries the exact OMP login URL (challenge, uuid, mode, redirectTarget).
    const openUrlEvent = await collector.waitFor("openUrl");
    if (openUrlEvent.type !== "openUrl") {
      throw new Error("expected an openUrl event");
    }
    const loginUrl = new URL(openUrlEvent.url);
    expect(`${loginUrl.origin}${loginUrl.pathname}`).toBe(LOGIN_URL);
    expect(loginUrl.searchParams.get("mode")).toBe("login");
    expect(loginUrl.searchParams.get("redirectTarget")).toBe("cli");
    const uuid = loginUrl.searchParams.get("uuid") ?? "";
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(loginUrl.searchParams.get("challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(openedUrls).toEqual([]);
    expect(collector.received().some((event) => event.type === "waiting")).toBe(true);

    // Poll: raw OMP query, GET, no Authorization header; 404 retried then 200.
    expect(fetcher.calls.length).toBe(2);
    const pollCall = fetcher.calls[0];
    if (pollCall === undefined) {
      throw new Error("expected a poll call");
    }
    expect(pollCall.method).toBe("GET");
    expect(pollCall.url).toBe(`${POLL_URL}?uuid=${uuid}&verifier=${new URL(pollCall.url).searchParams.get("verifier")}`);
    expect(new URL(pollCall.url).searchParams.get("uuid")).toBe(uuid);
    expect(new URL(pollCall.url).searchParams.get("verifier")).toMatch(/^[A-Za-z0-9_-]{128}$/);
    expect(new Headers(pollCall.init.headers).get("Authorization")).toBeNull();

    expect(result.credential).toEqual({
      kind: "oauth",
      secret: ACCESS_TOKEN,
      oauth: {
        access: ACCESS_TOKEN,
        refresh: "login-refresh-token",
        expiresAtMs: ACCESS_EXP * 1000 - 5 * 60 * 1000,
        refreshEndpoint: REFRESH_URL,
        identity: { userId: "user-789" },
      },
    });
    expect(result.accountLabel).toBe("user-789");
  });

  test("fails after three consecutive poll errors (OMP error budget)", async () => {
    const fetcher = mockFetcher([
      { when: (method, url) => method === "GET" && url.startsWith(`${POLL_URL}?`), respond: { status: 500 } },
    ]);
    const error = await bridgeErrorFrom(() =>
      loginCursor("browser", {}, eventCollector().events, AbortSignal.timeout(5000), {
        fetcher,
        openBrowser: () => undefined,
        sleep: instantSleep,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.message).toBe("Too many consecutive errors during Cursor auth polling");
    expect(fetcher.calls.length).toBe(3);
  });

  test("counts a malformed poll response toward the consecutive error budget", async () => {
    const fetcher = mockFetcher([
      { when: (method, url) => method === "GET" && url.startsWith(`${POLL_URL}?`), respond: { status: 200, body: { refreshToken: "orphan" } } },
    ]);
    const error = await bridgeErrorFrom(() =>
      loginCursor("browser", {}, eventCollector().events, AbortSignal.timeout(5000), {
        fetcher,
        openBrowser: () => undefined,
        sleep: instantSleep,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(fetcher.calls.length).toBe(3);
  });

  test("maps an aborted login signal to a timeout BridgeError with a cancelled message", async () => {
    const controller = new AbortController();
    const fetcher = mockFetcher([
      {
        when: (method, url) => {
          if (method === "GET" && url.startsWith(`${POLL_URL}?`)) {
            controller.abort(new Error("user closed the browser"));
          }
          return false;
        },
        respond: { status: 404 },
      },
      { when: (method, url) => method === "GET" && url.startsWith(`${POLL_URL}?`), respond: { status: 404 } },
    ]);
    const collector = eventCollector();
    const loginPromise = loginCursor("browser", {}, collector.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
      sleep: instantSleep,
    });
    await collector.waitFor("openUrl");
    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(fetcher.calls.length).toBe(1);
  });

  test("rejects a pre-aborted signal before generating auth params", async () => {
    const controller = new AbortController();
    controller.abort();
    const collector = eventCollector();
    const error = await bridgeErrorFrom(() =>
      loginCursor("browser", {}, collector.events, controller.signal, {
        fetcher: mockFetcher([]),
        openBrowser: () => undefined,
        sleep: instantSleep,
      }),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(collector.received()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Auth module — apiKey method + refresh + module surface
// ---------------------------------------------------------------------------

describe("cursorAuth — apiKey method", () => {
  test("validates the pasted key against /auth/usage before returning the bearer credential", async () => {
    const loginRequest = buildLoginRequest({
      providerId: "cursor",
      method: "apiKey",
      inputs: { apiKey: `  ${ACCESS_TOKEN}  ` },
    });
    const collector = eventCollector();
    const fetcher = mockFetcher({ [`GET ${AUTH_USAGE_URL}`]: { status: 200, body: AUTH_USAGE_BODY } });

    const result = await loginCursor("apiKey", loginRequest.inputs ?? {}, collector.events, AbortSignal.timeout(1000), {
      fetcher,
    });

    // Exactly the request the usage path makes with an api_key credential
    // (OMP sends the raw key as the plain Bearer token).
    expect(fetcher.calls.length).toBe(1);
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected a validation call");
    }
    expect(call.method).toBe("GET");
    expect(call.url).toBe(AUTH_USAGE_URL);
    const headers = new Headers(call.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("Accept")).toBe("application/json");

    expect(result.credential).toEqual({ kind: "bearer", secret: ACCESS_TOKEN });
    expect(result.accountLabel).toBeUndefined();
    expect(collector.received().some((event) => event.type === "pasteHint")).toBe(true);
  });

  test("rejects a missing pasted key with invalidRequest before any upstream call", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      loginCursor("apiKey", {}, eventCollector().events, AbortSignal.timeout(1000), { fetcher }),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(fetcher.calls.length).toBe(0);
  });

  test("rejects an invalid key as authRequired without leaking it", async () => {
    const fetcher = mockFetcher({ [`GET ${AUTH_USAGE_URL}`]: { status: 401, body: { error: "unauthorized" } } });
    const error = await bridgeErrorFrom(() =>
      loginCursor("apiKey", { apiKey: ACCESS_TOKEN }, eventCollector().events, AbortSignal.timeout(1000), { fetcher }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(1);
    expect(error.message).not.toContain(ACCESS_TOKEN);
  });
});

describe("cursorAuth — refresh", () => {
  test("posts the OMP exchange request and rotates the credential", async () => {
    const fetcher = mockFetcher({
      [`POST ${REFRESH_URL}`]: { status: 200, body: { accessToken: NEW_TOKEN, refreshToken: "new-refresh" } },
    });
    const rotated = await refreshCursorCredential(
      oauthCredential({ refresh: "old-refresh", identity: { userId: "user-789" } }),
      AbortSignal.timeout(1000),
      fetcher,
    );
    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected a refresh call");
    }
    expect(call.method).toBe("POST");
    expect(call.url).toBe(REFRESH_URL);
    expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer old-refresh");
    expect(call.init.body).toBe("{}");
    expect(rotated).toEqual({
      kind: "oauth",
      secret: NEW_TOKEN,
      oauth: {
        access: NEW_TOKEN,
        refresh: "new-refresh",
        expiresAtMs: NEW_EXP * 1000 - 5 * 60 * 1000,
        refreshEndpoint: REFRESH_URL,
        identity: { userId: "user-789" },
      },
    });
  });

  test("keeps the current refresh token when the response omits refreshToken", async () => {
    const fetcher = mockFetcher({
      [`POST ${REFRESH_URL}`]: { status: 200, body: { accessToken: NEW_TOKEN } },
    });
    const rotated = await refreshCursorCredential(
      oauthCredential({ refresh: "old-refresh" }),
      AbortSignal.timeout(1000),
      fetcher,
    );
    expect(rotated.kind === "oauth" ? rotated.oauth.refresh : undefined).toBe("old-refresh");
  });

  test("rejects non-oauth credentials with invalidRequest", async () => {
    const error = await bridgeErrorFrom(() =>
      refreshCursorCredential({ kind: "bearer", secret: ACCESS_TOKEN }, AbortSignal.timeout(1000), mockFetcher([])),
    );
    expect(error.kind).toBe("invalidRequest");
  });
});

describe("cursorAuth — module surface", () => {
  test("offers browser and apiKey methods and rejects unknown methods", async () => {
    expect(cursorAuth.providerId).toBe("cursor");
    expect(cursorAuth.methods).toEqual(["browser", "apiKey"]);
    expect(cursorConnector.providerId).toBe("cursor");
    expect(cursorConnector.connectorVersion).toBe("cursor-1");

    const error = await bridgeErrorFrom(() =>
      cursorAuth.login("device", {}, eventCollector().events, AbortSignal.timeout(50)),
    );
    expect(error.kind).toBe("invalidRequest");
  });

  test("extracts the JWT subject user id the way OMP does", () => {
    expect(extractCursorAccessTokenUserId(ACCESS_TOKEN)).toBe("user-789");
    expect(extractCursorAccessTokenUserId("not-a-jwt")).toBeUndefined();
    expect(extractCursorAccessTokenUserId(cursorJwt({ sub: "plain-sub" }))).toBe("plain-sub");
  });
});
