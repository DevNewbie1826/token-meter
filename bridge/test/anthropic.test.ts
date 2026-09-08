import { describe, expect, test } from "bun:test";
import { anthropicAuth, anthropicConnector, fetchAnthropicUsage, loginAnthropic, refreshAnthropicCredential } from "../src/providers/anthropic";
import { BridgeError } from "../src/protocol";
import type { BridgeRequest, OAuthCredential, UsageWindow } from "../src/protocol";
import type { AuthEvent, AuthEvents, AuthPrompt } from "../src/dispatch";
import { pkceChallengeFromVerifier } from "../src/auth/pkce";
import { buildUsageRequest, expectLoopbackClosed, expectNoModelFields, mockFetcher, waitForCount } from "./helpers";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1787011200500;
const ACCESS = "anthropic-access-unit";
const REFRESH = "anthropic-refresh-unit";
/** atob(CLIENT_ID_B64) — the OMP-embedded Claude Code OAuth client id. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";

const CLAUDE_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11";
const CLAUDE_USER_AGENT = "claude-cli/2.1.220 (external, cli)";

const RESET_5H = "2026-08-19T18:00:00.000Z";
const RESET_7D = "2026-08-23T09:30:00.000Z";

// Realistic OMP-shaped usage payload (packages/ai/src/usage/claude.ts shapes):
// live five_hour/seven_day buckets, null legacy per-model buckets, generic
// limits[] with weekly_scoped rows (duplicate Fable slug + display-name-less
// row must be dropped), the newer `spend` extra-usage block, and inline
// identity so no profile fallback is needed.
const USAGE_BODY = {
  five_hour: { utilization: 42.5, resets_at: RESET_5H },
  seven_day: { utilization: 77.2, resets_at: RESET_7D },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    {
      kind: "weekly_scoped",
      percent: 91.4,
      resets_at: RESET_7D,
      scope: { model: { display_name: "Fable" } },
      is_active: true,
    },
    {
      kind: "weekly_scoped",
      percent: 33.3,
      resets_at: RESET_7D,
      scope: { model: { display_name: "Mythos" } },
      is_active: false,
    },
    // Duplicate Fable slug: the first occurrence wins.
    { kind: "weekly_scoped", percent: 55, resets_at: RESET_7D, scope: { model: { display_name: "Fable" } } },
    // No display name and no scope: parsed but never surfaced as a window.
    { kind: "weekly_scoped", percent: 10, resets_at: null, scope: null },
    { kind: "other", percent: 5 },
  ],
  spend: {
    enabled: true,
    used: { amount_minor: 1575, currency: "USD", exponent: 2 },
    limit: { amount_minor: 10000, currency: "USD", exponent: 2 },
  },
  account_id: "acct_9f3e2d1c",
  email: "dev@example.com",
};

const EXPECTED_WINDOWS: readonly UsageWindow[] = [
  {
    id: "anthropic:5h",
    label: "Claude 5 Hour",
    unit: "percent",
    resolvedFraction: 42.5 / 100,
    severity: "ok",
    used: 42.5,
    limit: 100,
    resetsAtMs: Date.parse(RESET_5H),
  },
  {
    id: "anthropic:7d",
    label: "Claude 7 Day",
    unit: "percent",
    resolvedFraction: 77.2 / 100,
    severity: "ok",
    used: 77.2,
    limit: 100,
    resetsAtMs: Date.parse(RESET_7D),
  },
  {
    id: "anthropic:7d:fable",
    label: "Claude 7 Day (Fable)",
    unit: "percent",
    resolvedFraction: 91.4 / 100,
    severity: "warning",
    used: 91.4,
    limit: 100,
    resetsAtMs: Date.parse(RESET_7D),
  },
  {
    id: "anthropic:7d:mythos",
    label: "Claude 7 Day (Mythos)",
    unit: "percent",
    resolvedFraction: 33.3 / 100,
    severity: "ok",
    used: 33.3,
    limit: 100,
    resetsAtMs: Date.parse(RESET_7D),
  },
  {
    id: "anthropic:extra",
    label: "Claude Extra Usage",
    unit: "usd",
    resolvedFraction: 15.75 / 100,
    severity: "ok",
    used: 15.75,
    limit: 100,
  },
];

function oauthCredential(oauth: Partial<OAuthCredential["oauth"]> = {}): OAuthCredential {
  return {
    kind: "oauth",
    secret: ACCESS,
    oauth: { access: ACCESS, ...oauth },
  };
}

function anthropicUsageRequest(
  overrides: { readonly providerId?: string; readonly credential?: OAuthCredential } = {},
): BridgeRequest {
  return buildUsageRequest({
    providerId: overrides.providerId ?? "anthropic",
    connectorId: "anthropic",
    credential: overrides.credential ?? oauthCredential(),
  });
}

/** Credential that never triggers pre-rotation (fresh expiry, rotatable). */
function freshRotatableCredential(): OAuthCredential {
  return oauthCredential({ refresh: REFRESH, refreshEndpoint: TOKEN_URL, clientId: CLIENT_ID, expiresAtMs: NOW_MS + 3_600_000 });
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
// Usage connector — quota mapping
// ---------------------------------------------------------------------------

describe("anthropicConnector — quota mapping", () => {
  test("maps the OMP usage payload to normalized windows over the exact upstream call", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const request = anthropicUsageRequest();
    const response = await anthropicConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    // Identity ships inline with the payload: no best-effort profile call.
    expect(fetcher.calls.length).toBe(1);
    const usageCall = fetcher.calls[0];
    if (usageCall === undefined) {
      throw new Error("expected the usage endpoint to be called");
    }
    expect(usageCall.method).toBe("GET");
    expect(usageCall.url).toBe(USAGE_URL);
    const headers = new Headers(usageCall.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headers.get("accept")).toBe("application/json, text/plain, */*");
    expect(headers.get("accept-encoding")).toBe("gzip, compress, deflate, br");
    expect(headers.get("anthropic-beta")).toBe(CLAUDE_BETA);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe(CLAUDE_USER_AGENT);
    expect(headers.get("connection")).toBe("keep-alive");
    expect(usageCall.init.body).toBeUndefined();
    expect(usageCall.init.signal).toBeInstanceOf(AbortSignal);

    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(request.requestId);
    expect(response.providerId).toBe("anthropic");
    expect(response.connectorId).toBe("anthropic");
    expect(response.accountRef).toBe(request.accountRef);
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();

    const report = response.report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("privateApi");
    expect(report.fetchedAtMs).toBe(NOW_MS);
    expect(report.connectorVersion).toBe("anthropic-1");
    expect(report.windows).toEqual(EXPECTED_WINDOWS);
    expectNoModelFields(response);
  });

  test("keeps the access token out of the serialized response", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const response = await anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(JSON.stringify(response)).not.toContain(ACCESS);
  });

  test("falls back to limits[] session/weekly_all, clamps over-100 percent, maps legacy extra_usage, and swallows profile failures", async () => {
    // No five_hour/seven_day buckets and no payload identity: the connector
    // must use the generic limits fallbacks and attempt the best-effort
    // profile call, whose 404 may not fail the report.
    const fallbackBody = {
      five_hour: null,
      seven_day: null,
      seven_day_opus: { utilization: 9.9 },
      seven_day_sonnet: null,
      limits: [
        // Numeric-string percent (toNumber tolerance), over 100 -> clamped.
        { kind: "session", percent: "120", resets_at: "2026-08-19T20:00:00.000Z" },
        { kind: "weekly_all", percent: 88 },
      ],
      extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 250, decimal_places: 2, currency: "usd" },
    };
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: fallbackBody },
      [`GET ${PROFILE_URL}`]: { status: 404, body: { error: "not_found" } },
    });

    const response = await anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.length).toBe(2);
    const profileCall = fetcher.calls[1];
    if (profileCall === undefined) {
      throw new Error("expected the profile endpoint to be called");
    }
    expect(profileCall.method).toBe("GET");
    expect(profileCall.url).toBe(PROFILE_URL);
    expect(new Headers(profileCall.init.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(new Headers(profileCall.init.headers).get("anthropic-beta")).toBe(CLAUDE_BETA);

    expect(response.status).toBe("ok");
    expect(response.report.windows).toEqual([
      {
        id: "anthropic:5h",
        label: "Claude 5 Hour",
        unit: "percent",
        resolvedFraction: 1,
        severity: "exhausted",
        used: 100,
        limit: 100,
        resetsAtMs: Date.parse("2026-08-19T20:00:00.000Z"),
      },
      {
        id: "anthropic:7d",
        label: "Claude 7 Day",
        unit: "percent",
        resolvedFraction: 88 / 100,
        severity: "ok",
        used: 88,
        limit: 100,
      },
      {
        id: "anthropic:7d:opus",
        label: "Claude 7 Day (Opus)",
        unit: "percent",
        resolvedFraction: 9.9 / 100,
        severity: "ok",
        used: 9.9,
        limit: 100,
      },
      {
        // No monthly limit: spent dollars with no fraction and unknown severity.
        id: "anthropic:extra",
        label: "Claude Extra Usage",
        unit: "usd",
        severity: "unknown",
        used: 2.5,
      },
    ]);
    expectNoModelFields(response);
  });
});

// ---------------------------------------------------------------------------
// Usage connector — typed error paths
// ---------------------------------------------------------------------------

describe("anthropicConnector — typed error paths", () => {
  test("rejects a foreign providerId with invalidProvider", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        request: anthropicUsageRequest({ providerId: "zai" }),
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
      schemaVersion: "1.2.0",
      requestId: "00000000-0000-4000-8000-000000000001",
      operation: "fetchUsage",
      providerId: "anthropic",
      connectorId: "anthropic",
      accountRef: "00000000-0000-4000-8000-000000000002",
      requestedAtMs: 1787011200000,
      deadlineAtMs: 1787011210000,
    };
    const error = await bridgeErrorFrom(() => anthropicConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("missingCredential");
  });

  test("rejects a non-OAuth credential with invalidRequest", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        request: buildUsageRequest({ providerId: "anthropic", connectorId: "anthropic", credential: { kind: "bearer", secret: "sk-ant" } }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(fetcher.calls.length).toBe(0);
  });

  test("maps 401 to authRequired without rotation material", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 401, body: { error: "invalid oauth token" } } });
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        request: anthropicUsageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(ACCESS);
    expect(fetcher.calls.length).toBe(1);
  });

  test("maps 429 with Retry-After to rateLimited with retryAfterMs", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { type: "error", error: { type: "rate_limit_error" } } },
    });
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = async () => new Response("not-json{", { status: 200, headers: { "Content-Type": "application/json" } });
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps a non-object JSON body to malformedPayload", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: [] } });
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps a payload without usable rows to noData (no-usable-rows rule)", async () => {
    // A resets-only bucket is not a usable row (OMP buildUsageLimit drops it).
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: { five_hour: { resets_at: RESET_5H }, seven_day: null, limits: [] } },
    });
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("noData");
    // The noData throw happens before the best-effort profile call.
    expect(fetcher.calls.length).toBe(1);
  });

  test("maps a network failure to transport", async () => {
    const fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("transport");
  });

  test("maps an aborted request to timeout", async () => {
    const fetcher = async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({ request: anthropicUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Usage connector — OAuth rotation
// ---------------------------------------------------------------------------

const ROTATED_ACCESS = "anthropic-access-rotated";
const ROTATED_REFRESH = "anthropic-refresh-rotated";
const REFRESH_BODY = { access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 28800 };

describe("anthropicConnector — OAuth rotation", () => {
  test("pre-rotates an expiring token before the upstream call and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: REFRESH_BODY },
      [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_BODY },
    });
    // Expires in 30s: inside the 60s pre-rotation window.
    const credential = oauthCredential({ refresh: REFRESH, refreshEndpoint: TOKEN_URL, clientId: CLIENT_ID, expiresAtMs: NOW_MS + 30_000 });

    const response = await anthropicConnector.fetchUsage({
      request: anthropicUsageRequest({ credential }),
      fetcher,
      nowMs: NOW_MS,
    });

    // Rotation first, then the usage call rides the rotated Bearer token.
    expect(fetcher.calls.length).toBe(2);
    const refreshCall = fetcher.calls[0];
    const usageCall = fetcher.calls[1];
    if (refreshCall === undefined || usageCall === undefined) {
      throw new Error("expected a refresh call followed by a usage call");
    }
    expect(refreshCall.method).toBe("POST");
    expect(refreshCall.url).toBe(TOKEN_URL);
    const refreshHeaders = new Headers(refreshCall.init.headers);
    // CC sends these on refresh but not on the initial code exchange.
    expect(refreshHeaders.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(refreshHeaders.get("User-Agent")).toBe("anthropic-sdk-typescript/0.94.0 userOAuthProvider");
    expect(refreshHeaders.get("Content-Type")).toBe("application/json");
    expect(refreshHeaders.get("Authorization")).toBeNull();
    expect(refreshHeaders.get("Accept")).toBeNull();
    expect(JSON.parse(String(refreshCall.init.body))).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: REFRESH,
    });

    expect(usageCall.method).toBe("GET");
    expect(usageCall.url).toBe(USAGE_URL);
    expect(new Headers(usageCall.init.headers).get("Authorization")).toBe(`Bearer ${ROTATED_ACCESS}`);

    // OMP expiry: now + expires_in - 5min safety margin.
    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ROTATED_ACCESS,
      oauth: {
        access: ROTATED_ACCESS,
        refresh: ROTATED_REFRESH,
        expiresAtMs: NOW_MS + 28_800_000 - 300_000,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expect(JSON.stringify(response)).not.toContain(REFRESH);
  });

  test("skips rotation when the token is missing expiry but has no refresh material", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const response = await anthropicConnector.fetchUsage({
      request: anthropicUsageRequest({ credential: oauthCredential() }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.length).toBe(1);
    expect(fetcher.calls[0]?.url).toBe(USAGE_URL);
    expect(response.refreshedCredential).toBeUndefined();
    expect(response.status).toBe("ok");
  });

  test("does not rotate a fresh token", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const response = await anthropicConnector.fetchUsage({
      request: anthropicUsageRequest({ credential: freshRotatableCredential() }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.length).toBe(1);
    expect(response.refreshedCredential).toBeUndefined();
  });

  test("rotates once and retries once after a mid-flow 401", async () => {
    let usageCalls = 0;
    const fetcher = mockFetcher([
      { when: (method, url) => method === "GET" && url === USAGE_URL && ++usageCalls === 1, respond: { status: 401, body: {} } },
      { when: (method, url) => method === "GET" && url === USAGE_URL, respond: { status: 200, body: USAGE_BODY } },
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: REFRESH_BODY } },
    ]);
    const response = await anthropicConnector.fetchUsage({
      request: anthropicUsageRequest({ credential: freshRotatableCredential() }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${USAGE_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${USAGE_URL}`,
    ]);
    expect(new Headers(fetcher.calls[2]?.init.headers).get("Authorization")).toBe(`Bearer ${ROTATED_ACCESS}`);
    expect(response.status).toBe("ok");
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expect(response.refreshedCredential?.kind).toBe("oauth");
  });

  test("propagates authRequired when a 401 hits a credential that cannot rotate", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 401, body: {} } });
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        request: anthropicUsageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(1);
  });

  test("propagates a failed rotation after a mid-flow 401", async () => {
    const fetcher = mockFetcher([
      { when: (method, url) => method === "GET" && url === USAGE_URL, respond: { status: 401, body: {} } },
      { when: `POST ${TOKEN_URL}`, respond: { status: 400, body: { error: "invalid_grant" } } },
    ]);
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        request: anthropicUsageRequest({ credential: freshRotatableCredential() }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(fetcher.calls.length).toBe(2);
  });

  test("keeps the pre-rotated credential on the error envelope when the usage call fails afterwards", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: REFRESH_BODY } },
      {
        when: `GET ${USAGE_URL}`,
        respond: { status: 429, headers: { "retry-after": "17" }, body: { error: "slow down" } },
      },
    ]);
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        // Missing expiresAtMs forces the pre-rotation; the refresh material exists.
        request: anthropicUsageRequest({
          credential: oauthCredential({ refresh: REFRESH, refreshEndpoint: TOKEN_URL, clientId: CLIENT_ID }),
        }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(17_000);
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${USAGE_URL}`,
    ]);
    // The rotated bundle must ride the error so the caller persists it before
    // surfacing the failure — rotation is single-use server-side.
    expect(error.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ROTATED_ACCESS,
      oauth: {
        access: ROTATED_ACCESS,
        refresh: ROTATED_REFRESH,
        expiresAtMs: NOW_MS + 28_800_000 - 300_000,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
  });

  test("keeps the mid-flow-rotated credential on the error envelope when the retried usage call fails", async () => {
    let usageCalls = 0;
    const fetcher = mockFetcher([
      { when: (method, url) => method === "GET" && url === USAGE_URL && ++usageCalls === 1, respond: { status: 401, body: {} } },
      { when: (method, url) => method === "GET" && url === USAGE_URL, respond: { status: 500, body: { error: "boom" } } },
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: REFRESH_BODY } },
    ]);
    const error = await bridgeErrorFrom(() =>
      anthropicConnector.fetchUsage({
        request: anthropicUsageRequest({ credential: freshRotatableCredential() }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.refreshedCredential?.kind).toBe("oauth");
    if (error.refreshedCredential?.kind !== "oauth") {
      throw new Error("expected the rotated credential on the error envelope");
    }
    expect(error.refreshedCredential.oauth.access).toBe(ROTATED_ACCESS);
    expect(error.refreshedCredential.oauth.refresh).toBe(ROTATED_REFRESH);
    expect(error.message).not.toContain(ROTATED_ACCESS);
  });
});

// ---------------------------------------------------------------------------
// Auth module — refresh()
// ---------------------------------------------------------------------------

describe("refreshAnthropicCredential", () => {
  test("refreshes via the OMP refresh grant and keeps the stored org identity", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ROTATED_ACCESS } },
    });
    const credential = oauthCredential({
      refresh: REFRESH,
      refreshEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      expiresAtMs: 1_000,
      identity: { accountId: "acct_9f3e2d1c", email: "dev@example.com", orgId: "org_1a2b3c" },
    });

    const rotated = await refreshAnthropicCredential(credential, fetcher, new AbortController().signal);

    expect(fetcher.calls.length).toBe(1);
    expect(JSON.parse(String(fetcher.calls[0]?.init.body))).toEqual({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: REFRESH,
    });
    // Response omitted refresh_token/expires_in: the old values survive
    // (OMP: data.refresh_token || refreshToken).
    expect(rotated).toEqual({
      kind: "oauth",
      secret: ROTATED_ACCESS,
      oauth: {
        access: ROTATED_ACCESS,
        refresh: REFRESH,
        expiresAtMs: 1_000,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: "acct_9f3e2d1c", email: "dev@example.com", orgId: "org_1a2b3c" },
      },
    });
  });

  test("rejects a non-OAuth credential with invalidRequest", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      refreshAnthropicCredential({ kind: "apiKey", secret: "sk-ant" }, fetcher, new AbortController().signal),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(fetcher.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auth module — browser login (Claude Pro/Max OAuth)
// ---------------------------------------------------------------------------

const LOGIN_ACCESS = "anthropic-access-login-unit";
const LOGIN_REFRESH = "anthropic-refresh-login-unit";
const AUTH_CODE = "anthropic-auth-code-unit";

const LOGIN_TOKEN_BODY = {
  access_token: LOGIN_ACCESS,
  refresh_token: LOGIN_REFRESH,
  expires_in: 28800,
  account: { uuid: "acct_9f3e2d1c", email_address: "dev@example.com" },
  organization: { uuid: "org_1a2b3c", name: "Acme Team" },
};

/**
 * Runs the browser flow end-to-end against mocked endpoints + a real loopback.
 *
 * Upstream mock calls are gated until the loopback response has fully
 * drained: the module stops the callback server in its `finally` (the
 * loopback's stop(true) closes live sockets), so letting the exchange race
 * the response read would make the callback fetch fail with ECONNRESET.
 */
async function runBrowserFlow(
  routes: Parameters<typeof mockFetcher>[0],
): Promise<{
  readonly result: Awaited<ReturnType<typeof loginAnthropic>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly openedUrls: string[];
  readonly authorizeUrl: URL;
  readonly redirectUri: string;
  readonly state: string;
}> {
  const innerFetcher = mockFetcher(routes);
  const callbackDrained = Promise.withResolvers<void>();
  const fetcher = (url: string, init: RequestInit): Promise<Response> =>
    callbackDrained.promise.then(() => innerFetcher(url, init));
  const collector = eventCollector();
  const openedUrls: string[] = [];
  const controller = new AbortController();

  const loginPromise = loginAnthropic("browser", {}, collector.events, controller.signal, {
    fetcher,
    openBrowser: (url) => {
      openedUrls.push(url);
    },
  });

  const openUrlEvent = await collector.waitFor("openUrl");
  if (openUrlEvent.type !== "openUrl") {
    throw new Error("expected an openUrl event");
  }
  const authorizeUrl = new URL(openUrlEvent.url);
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  if (redirectUri === null) {
    throw new Error("authorize URL carries no redirect_uri");
  }
  const state = authorizeUrl.searchParams.get("state");
  if (state === null) {
    throw new Error("authorize URL carries no state");
  }

  // Complete the loopback callback over the real local server, then let the
  // upstream mocks run only once the callback response has been consumed.
  const callbackResponse = await fetch(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
  expect(callbackResponse.status).toBe(200);
  await callbackResponse.text();
  callbackDrained.resolve();

  const result = await loginPromise;
  return { result, fetcher: innerFetcher, collector, openedUrls, authorizeUrl, redirectUri, state };
}

describe("anthropicAuth — browser login", () => {
  test("completes the PKCE browser flow and returns the OAuth credential with inline identity", async () => {
    const { result, fetcher, collector, openedUrls, authorizeUrl, redirectUri, state } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY },
    });

    // Authorize URL: claude.ai, the decoded OMP client id, CC scopes, PKCE
    // S256 challenge, and the actual loopback redirect_uri + 32-hex state.
    expect(authorizeUrl.origin).toBe("https://claude.ai");
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("code")).toBe("true");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(openedUrls).toEqual([]);

    // Events: openUrl first, the OMP paste-fallback hint, progress waits.
    expect(collector.received()[0]?.type).toBe("openUrl");
    expect(collector.received().some((event) => event.type === "pasteHint")).toBe(true);
    expect(collector.received().filter((event) => event.type === "waiting").length).toBeGreaterThanOrEqual(2);

    // Token exchange: JSON authorization_code grant, Content-Type only —
    // CC omits Accept on OAuth token requests — and no Authorization header.
    expect(fetcher.calls.length).toBe(1);
    const tokenCall = fetcher.calls[0];
    if (tokenCall === undefined) {
      throw new Error("expected a token exchange call");
    }
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).toBe(TOKEN_URL);
    const tokenHeaders = new Headers(tokenCall.init.headers);
    expect(tokenHeaders.get("Content-Type")).toBe("application/json");
    expect(tokenHeaders.get("Authorization")).toBeNull();
    expect(tokenHeaders.get("Accept")).toBeNull();
    const body = JSON.parse(String(tokenCall.init.body)) as Record<string, string>;
    expect(body["grant_type"]).toBe("authorization_code");
    expect(body["client_id"]).toBe(CLIENT_ID);
    expect(body["code"]).toBe(AUTH_CODE);
    expect(body["state"]).toBe(state);
    expect(body["redirect_uri"]).toBe(redirectUri);
    // The PKCE pair is internally consistent: challenge == S256(verifier).
    const verifier = body["code_verifier"];
    const codeChallenge = authorizeUrl.searchParams.get("code_challenge");
    if (typeof verifier !== "string" || codeChallenge === null) {
      throw new Error("token exchange body missing code_verifier or challenge");
    }
    expect(await pkceChallengeFromVerifier(verifier)).toBe(codeChallenge);

    // Credential shape: OMP expiry margin (expires_in - 5min), refresh
    // endpoint/client id for rotation, and identity from the token response.
    expect(result.credential.kind).toBe("oauth");
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    const oauth = result.credential.oauth;
    expect(result.credential.secret).toBe(LOGIN_ACCESS);
    expect(oauth.access).toBe(LOGIN_ACCESS);
    expect(oauth.refresh).toBe(LOGIN_REFRESH);
    expect(oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(oauth.clientId).toBe(CLIENT_ID);
    // The exchange happened moments ago: now + 28800s - 5min, within a minute.
    const expectedExpiry = Date.now() + 28_800_000 - 300_000;
    expect(oauth.expiresAtMs).toBeGreaterThan(expectedExpiry - 60_000);
    expect(oauth.expiresAtMs).toBeLessThanOrEqual(expectedExpiry);
    expect(oauth.identity).toEqual({
      accountId: "acct_9f3e2d1c",
      email: "dev@example.com",
      orgId: "org_1a2b3c",
      orgName: "Acme Team",
    });
    expect(result.accountLabel).toBe("dev@example.com");
    expect(JSON.stringify(result.credential)).not.toContain(AUTH_CODE);
  });

  test("recovers identity from the bootstrap endpoint when the token response has none", async () => {
    const { result, fetcher } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: LOGIN_ACCESS, refresh_token: LOGIN_REFRESH, expires_in: 28800 },
      },
      [`GET ${BOOTSTRAP_URL}?entrypoint=cli&model=claude-opus-4-8`]: {
        status: 200,
        body: {
          oauth_account: {
            account_uuid: "acct_bootstrap",
            account_email: "boot@example.com",
            organization_uuid: "org_bootstrap",
            organization_name: "Bootstrap Org",
          },
        },
      },
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${BOOTSTRAP_URL}?entrypoint=cli&model=claude-opus-4-8`,
    ]);
    const bootstrapCall = fetcher.calls[1];
    if (bootstrapCall === undefined) {
      throw new Error("expected a bootstrap call");
    }
    const headers = new Headers(bootstrapCall.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${LOGIN_ACCESS}`);
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(headers.get("User-Agent")).toBe("claude-code/2.1.220");
    expect(headers.get("Accept")).toBe("application/json, text/plain, */*");

    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.identity).toEqual({
      accountId: "acct_bootstrap",
      email: "boot@example.com",
      orgId: "org_bootstrap",
      orgName: "Bootstrap Org",
    });
    expect(result.accountLabel).toBe("boot@example.com");
  });

  test("still logs in when the best-effort bootstrap endpoint fails", async () => {
    const { result, fetcher } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: LOGIN_ACCESS, refresh_token: LOGIN_REFRESH, expires_in: 28800 },
      },
      [`GET ${BOOTSTRAP_URL}?entrypoint=cli&model=claude-opus-4-8`]: { status: 500, body: { error: "boom" } },
    });

    expect(fetcher.calls.length).toBe(2);
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.identity).toBeUndefined();
    expect(result.accountLabel).toBeUndefined();
    expect(result.credential.oauth.access).toBe(LOGIN_ACCESS);
  });

  test("maps a rejected token exchange to the callProviderHttp status map", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 400, body: { error: "invalid_grant", error_description: "bad verifier" } },
      }),
    );
    expect(error.kind).toBe("upstreamError");
  });

  test("maps a token response without an access token to malformedPayload", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: { refresh_token: LOGIN_REFRESH, expires_in: 28800 } },
      }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps an aborted login signal to a timeout BridgeError with a cancelled message", async () => {
    const fetcher = mockFetcher([]);
    const collector = eventCollector();
    const controller = new AbortController();
    const loginPromise = loginAnthropic("browser", {}, collector.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
    });
    await collector.waitFor("openUrl");
    controller.abort(new Error("user closed the browser"));

    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(fetcher.calls.length).toBe(0);
  });
});

describe("anthropicAuth — manual paste fallback (OMP onManualCodeInput race)", () => {
  /** AuthEvents whose requestInput records prompts and replays pastes on demand. */
  function pasteCollector(collector: ReturnType<typeof eventCollector>): {
    readonly events: AuthEvents;
    readonly ready: EventTarget;
    prompts(): readonly AuthPrompt[];
    waitForPrompts(count: number, signal: AbortSignal): Promise<void>;
    pendingResponses(): number;
    respond(paste: string): void;
  } {
    const prompts: AuthPrompt[] = [];
    const responders: Array<(value: string) => void> = [];
    const ready = new EventTarget();
    return {
      ready,
      events: {
        onEvent: collector.events.onEvent,
        requestInput: (prompt, requestSignal) => {
          prompts.push(prompt);
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

  test("resolves the login through a pasted redirect URL on the duplex channel", async () => {
    const fetcher = mockFetcher({ [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY } });
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginAnthropic("browser", {}, pastes.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
    });
    await Promise.all([collector.waitFor("openUrl"), firstPrompt]);
    const { redirectUri, state } = redirectFrom(collector);

    pastes.respond(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
    const result = await loginPromise;
    expect(pastes.pendingResponses()).toBe(0);
    await expectLoopbackClosed(redirectUri);

    expect(pastes.prompts()).toHaveLength(1);
    const prompt = pastes.prompts()[0];
    if (prompt === undefined) {
      throw new Error("expected a manual paste prompt");
    }
    expect(prompt.inputKind).toBe("redirectUrl");
    expect(prompt.sensitive).toBe(true);

    expect(fetcher.calls.length).toBe(1);
    const body = JSON.parse(String(fetcher.calls[0]?.init.body)) as Record<string, string>;
    expect(body["code"]).toBe(AUTH_CODE);
    expect(body["state"]).toBe(state);
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.access).toBe(LOGIN_ACCESS);
  });

  test("re-prompts when the paste carries a mismatched state, then accepts", async () => {
    const fetcher = mockFetcher({ [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY } });
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginAnthropic("browser", {}, pastes.events, controller.signal, {
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
      const body = JSON.parse(String(fetcher.calls[0]?.init.body)) as Record<string, string>;
      expect(body["code"]).toBe(AUTH_CODE);
      expect(body["state"]).toBe(state);
    } finally {
      pastes.ready.removeEventListener("ready", recordReady);
      controller.abort();
      // Drain the login even when a readiness assertion/timeout fails.
      await Promise.allSettled([loginPromise, retryReady]);
      expect(pastes.pendingResponses()).toBe(0);
      await expectLoopbackClosed(redirectUri);
    }
  });

  test("cancellation while a paste is pending closes the loopback listener", async () => {
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginAnthropic("browser", {}, pastes.events, controller.signal, {
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
    await expectLoopbackClosed(redirectUri);
  });
});

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

describe("anthropic module surface", () => {
  test("exposes the browser auth method and the anthropic-1 connector", async () => {
    expect(anthropicAuth.providerId).toBe("anthropic");
    expect(anthropicAuth.methods).toEqual(["browser"]);
    expect(typeof anthropicAuth.refresh).toBe("function");
    expect(anthropicConnector.providerId).toBe("anthropic");
    expect(anthropicConnector.connectorVersion).toBe("anthropic-1");

    const error = await bridgeErrorFrom(() =>
      anthropicAuth.login("apiKey", {}, eventCollector().events, AbortSignal.timeout(50)),
    );
    expect(error.kind).toBe("invalidRequest");
  });

  test("fetchUsage is the exported connector entry point", () => {
    expect(anthropicConnector.fetchUsage).toBe(fetchAnthropicUsage);
  });
});
