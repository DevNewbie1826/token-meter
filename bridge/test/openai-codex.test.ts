import { describe, expect, test } from "bun:test";
import {
  fetchOpenAICodexUsage,
  loginOpenAICodex,
  openaiCodexAuth,
  openaiCodexConnector,
  refreshOpenAICodexCredential,
} from "../src/providers/openai-codex";
import { BridgeError } from "../src/protocol";
import type { BridgeCredential, BridgeRequest, OAuthCredential, UsageWindow } from "../src/protocol";
import type { AuthEvent, AuthEvents } from "../src/dispatch";
import { pkceChallengeFromVerifier } from "../src/auth/pkce";
import { buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";
import type { MockResponse, MockRouteRule } from "./helpers";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1787011200500;
const ACCESS = "codex-access-unit";
const REFRESH = "codex-refresh-unit";
/** The OMP-embedded Codex OAuth client id. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const USER_AGENT = "omp/17.3.7";
const ACCOUNT_ID = "acct-codex-unit";

/** base64url JWT with the OMP Codex claim layout. */
function codexJwt(payload: Record<string, unknown>): string {
  const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
  return `${encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encode(JSON.stringify(payload))}.sig-unit`;
}

// Realistic OMP-shaped /wham/usage payload (packages/ai/src/usage/
// openai-codex.ts shapes): live primary/secondary chat windows, one Spark
// additional meter, and a positive saved-reset count that triggers the
// detail-endpoint sync.
const HAPPY_BODY = {
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 42.5,
      limit_window_seconds: 18000,
      reset_after_seconds: 7200,
      reset_at: 1787018400,
    },
    secondary_window: {
      used_percent: 96.2,
      limit_window_seconds: 604800,
      reset_at: 1787536800,
    },
  },
  additional_rate_limits: [
    {
      limit_name: "codex_spark",
      metered_feature: "bengalfox",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 },
      },
    },
  ],
  rate_limit_reset_credits: { available_count: 2 },
};

const RESET_CREDITS_BODY = {
  available_count: 1,
  credits: [
    { id: "RateLimitResetCredit_1", status: "available" },
    { id: "RateLimitResetCredit_2", status: "redeemed" },
  ],
};

const HAPPY_WINDOWS: readonly UsageWindow[] = [
  {
    id: "openai-codex:primary",
    label: "5 hours",
    unit: "percent",
    resolvedFraction: 0.425,
    severity: "ok",
    used: 42.5,
    limit: 100,
    resetsAtMs: 1787018400000,
    resetCredits: 1,
  },
  {
    id: "openai-codex:secondary",
    label: "7 days",
    unit: "percent",
    resolvedFraction: 96.2 / 100,
    severity: "critical",
    used: 96.2,
    limit: 100,
    resetsAtMs: 1787536800000,
  },
  {
    id: "openai-codex:spark:primary",
    label: "5 hours (Spark)",
    unit: "percent",
    resolvedFraction: 0.12,
    severity: "ok",
    used: 12,
    limit: 100,
    resetsAtMs: NOW_MS + 3_600_000,
  },
];

/** Overrides for the default credential oauth bundle; undefined deletes the key. */
type CodexOauthOverrides = {
  readonly [K in keyof OAuthCredential["oauth"]]?: OAuthCredential["oauth"][K] | undefined;
};

function codexCredential(oauth: CodexOauthOverrides = {}): OAuthCredential {
  const base: Record<string, unknown> = {
    access: ACCESS,
    refresh: REFRESH,
    refreshEndpoint: TOKEN_URL,
    clientId: CLIENT_ID,
    expiresAtMs: NOW_MS + 3_600_000,
    identity: { accountId: ACCOUNT_ID },
  };
  for (const [key, value] of Object.entries(oauth)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return { kind: "oauth", secret: ACCESS, oauth: base as OAuthCredential["oauth"] };
}

function codexUsageRequest(
  overrides: { readonly providerId?: string; readonly credential?: BridgeCredential } = {},
): BridgeRequest {
  return buildUsageRequest({
    providerId: overrides.providerId ?? "openai-codex",
    connectorId: "openai-codex",
    credential: overrides.credential ?? codexCredential(),
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
// Usage connector — quota mapping
// ---------------------------------------------------------------------------

describe("openaiCodexConnector — quota mapping", () => {
  test("maps the OMP wham/usage payload to normalized windows over the exact upstream calls", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: HAPPY_BODY },
      [`GET ${RESET_CREDITS_URL}`]: { status: 200, body: RESET_CREDITS_BODY },
    });
    const request = codexUsageRequest();
    const response = await openaiCodexConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    // /wham/usage first, then the saved-reset sync the payload triggers.
    expect(fetcher.calls.length).toBe(2);
    const usageCall = fetcher.calls[0];
    if (usageCall === undefined) {
      throw new Error("expected the usage endpoint to be called");
    }
    expect(usageCall.method).toBe("GET");
    expect(usageCall.url).toBe(USAGE_URL);
    const headers = new Headers(usageCall.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headers.get("User-Agent")).toBe(USER_AGENT);
    expect(headers.get("ChatGPT-Account-Id")).toBe(ACCOUNT_ID);
    expect(headers.get("Content-Type")).toBeNull();
    expect(usageCall.init.body).toBeUndefined();
    expect(usageCall.init.signal).toBeInstanceOf(AbortSignal);

    const creditsCall = fetcher.calls[1];
    if (creditsCall === undefined) {
      throw new Error("expected the reset-credits endpoint to be called");
    }
    expect(creditsCall.method).toBe("GET");
    expect(creditsCall.url).toBe(RESET_CREDITS_URL);
    const creditHeaders = new Headers(creditsCall.init.headers);
    expect(creditHeaders.get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(creditHeaders.get("User-Agent")).toBe(USER_AGENT);
    expect(creditHeaders.get("ChatGPT-Account-Id")).toBe(ACCOUNT_ID);

    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(request.requestId);
    expect(response.providerId).toBe("openai-codex");
    expect(response.connectorId).toBe(request.connectorId);
    expect(response.accountRef).toBe(request.accountRef);
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();

    const report = response.report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("privateApi");
    expect(report.fetchedAtMs).toBe(NOW_MS);
    expect(report.connectorVersion).toBe("openai-codex-1");
    expect(report.windows).toEqual(HAPPY_WINDOWS);
    expectNoModelFields(response);
    expect(JSON.stringify(response)).not.toContain(ACCESS);
  });

  test("derives the account-id header from the access-token JWT claim", async () => {
    const jwtAccess = codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-from-jwt" },
      "https://api.openai.com/profile": { email: "jwt-user@example.com" },
    });
    const body = { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } };
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body } });
    await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest({ credential: codexCredential({ access: jwtAccess, identity: undefined }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(new Headers(fetcher.calls[0]?.init.headers).get("ChatGPT-Account-Id")).toBe("acct-from-jwt");
  });

  test("normalizes an identity base URL override and falls back for foreign hosts", async () => {
    const body = { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } };

    const overrideFetcher = mockFetcher({
      "GET https://chat.openai.com/backend-api/wham/usage": { status: 200, body },
    });
    await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest({
        credential: codexCredential({
          identity: { accountId: ACCOUNT_ID, baseUrl: "https://chat.openai.com/backend-api/codex/responses" },
        }),
      }),
      fetcher: overrideFetcher,
      nowMs: NOW_MS,
    });
    // The streaming-proxy path is collapsed to the canonical /backend-api.
    expect(overrideFetcher.calls[0]?.url).toBe("https://chat.openai.com/backend-api/wham/usage");

    const foreignFetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body } });
    await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest({
        credential: codexCredential({ identity: { accountId: ACCOUNT_ID, baseUrl: "https://proxy.example.com/api" } }),
      }),
      fetcher: foreignFetcher,
      nowMs: NOW_MS,
    });
    expect(foreignFetcher.calls[0]?.url).toBe(USAGE_URL);
  });

  test("keeps the stale saved-reset count when the detail endpoint fails", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: HAPPY_BODY },
      [`GET ${RESET_CREDITS_URL}`]: { status: 500, body: { error: "boom" } },
    });
    const response = await openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.length).toBe(2);
    const primary = response.report.windows.find((window) => window.id === "openai-codex:primary");
    expect(primary?.resetCredits).toBe(2);
  });

  test("maps wire severity bands, slug fallback and reset-only windows", async () => {
    const run = async (body: unknown, credential?: OAuthCredential): Promise<readonly UsageWindow[]> => {
      const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body } });
      const response = await openaiCodexConnector.fetchUsage({
        request: codexUsageRequest(credential === undefined ? {} : { credential }),
        fetcher,
        nowMs: NOW_MS,
      });
      return response.report.windows;
    };

    // 100% is exhausted even when the shared meter explicitly allows;
    // 250% clamps to 100. Both windows share the rate_limit flags.
    const flagged = await run({
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 100, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 250, limit_window_seconds: 604800 },
      },
    });
    expect(flagged).toEqual([
      {
        id: "openai-codex:primary",
        label: "5 hours",
        unit: "percent",
        resolvedFraction: 1,
        severity: "exhausted",
        used: 100,
        limit: 100,
      },
      {
        id: "openai-codex:secondary",
        label: "7 days",
        unit: "percent",
        resolvedFraction: 1,
        severity: "exhausted",
        used: 100,
        limit: 100,
      },
    ]);

    // Without the explicit allow verdict, 100% is exhausted.
    const exhausted = await run({
      rate_limit: {
        primary_window: { used_percent: 100, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 96.2, limit_window_seconds: 604800 },
      },
    });
    expect(exhausted[0]?.severity).toBe("exhausted");
    expect(exhausted[1]?.severity).toBe("critical");

    // A non-spark additional meter: slug from the codex_-stripped limit name,
    // fallback window labels without limit_window_seconds, unknown severity
    // and no fraction without a percent.
    const additional = await run({
      additional_rate_limits: [
        {
          limit_name: "codex_extra_thing",
          rate_limit: { primary_window: { reset_after_seconds: 600 } },
        },
      ],
    });
    expect(additional).toEqual([
      {
        id: "openai-codex:extra-thing:primary",
        label: "Primary window (codex_extra_thing)",
        unit: "percent",
        severity: "unknown",
        resetsAtMs: NOW_MS + 600_000,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Usage connector — typed error paths
// ---------------------------------------------------------------------------

describe("openaiCodexConnector — typed error paths", () => {
  test("rejects a foreign providerId with invalidProvider", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({
        request: codexUsageRequest({ providerId: "zai" }),
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
      providerId: "openai-codex",
      connectorId: "openai-codex",
      accountRef: "00000000-0000-4000-8000-000000000002",
      requestedAtMs: 1787011200000,
      deadlineAtMs: 1787011210000,
    };
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("missingCredential");
  });

  test("rejects a non-OAuth credential with invalidRequest", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({
        request: codexUsageRequest({ credential: { kind: "bearer", secret: "sk-openai" } }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(fetcher.calls.length).toBe(0);
  });

  test("short-circuits an expired token without refresh material to noData", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({
        request: codexUsageRequest({
          credential: codexCredential({ refresh: undefined, refreshEndpoint: undefined, expiresAtMs: NOW_MS - 1_000 }),
        }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("noData");
    expect(fetcher.calls.length).toBe(0);
  });

  test("maps 401 to authRequired without rotation material", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 401, body: { error: "invalid_token" } } });
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({
        request: codexUsageRequest({
          credential: codexCredential({ refresh: undefined, refreshEndpoint: undefined }),
        }),
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
      [`GET ${USAGE_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { error: "rate_limited" } },
    });
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = async () => new Response("not-json{", { status: 200, headers: { "Content-Type": "application/json" } });
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps a payload without usable rows to noData (no-usable-rows rule)", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { plan_type: "pro", rate_limit: null } } });
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("noData");
    expect(fetcher.calls.length).toBe(1);
  });

  test("maps a network failure to transport", async () => {
    const fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("transport");
  });

  test("maps an aborted request to timeout", async () => {
    const fetcher = async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Usage connector — OAuth rotation
// ---------------------------------------------------------------------------

const ROTATED_ACCESS = "codex-access-rotated";
const ROTATED_REFRESH = "codex-refresh-rotated";
const REFRESH_BODY = { access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3600 };
const MINIMAL_BODY = { rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } } };

describe("openaiCodexConnector — OAuth rotation", () => {
  test("pre-rotates a token without expiry before the upstream call and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: REFRESH_BODY },
      [`GET ${USAGE_URL}`]: { status: 200, body: MINIMAL_BODY },
    });
    // Missing expiresAtMs: inside the pre-rotation rule.
    const credential = codexCredential({ expiresAtMs: undefined });

    const response = await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest({ credential }),
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
    expect(refreshHeaders.get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(refreshHeaders.get("Authorization")).toBeNull();
    expect(new URLSearchParams(String(refreshCall.init.body))).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: REFRESH,
      }),
    );
    expect(usageCall.method).toBe("GET");
    expect(usageCall.url).toBe(USAGE_URL);
    expect(new Headers(usageCall.init.headers).get("Authorization")).toBe(`Bearer ${ROTATED_ACCESS}`);
    expect(new Headers(usageCall.init.headers).get("ChatGPT-Account-Id")).toBe(ACCOUNT_ID);

    // OMP expiry: now + expires_in (no skew); identity survives verbatim.
    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ROTATED_ACCESS,
      oauth: {
        access: ROTATED_ACCESS,
        refresh: ROTATED_REFRESH,
        expiresAtMs: NOW_MS + 3_600_000,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: ACCOUNT_ID },
      },
    });
    expect(response.status).toBe("ok");
    expect(JSON.stringify(response)).not.toContain(REFRESH);
  });

  test("expires within 60s also pre-rotates", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: REFRESH_BODY },
      [`GET ${USAGE_URL}`]: { status: 200, body: MINIMAL_BODY },
    });
    const response = await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest({ credential: codexCredential({ expiresAtMs: NOW_MS + 30_000 }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${USAGE_URL}`,
    ]);
    expect(response.refreshedCredential?.kind).toBe("oauth");
  });

  test("does not rotate a fresh token", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: MINIMAL_BODY } });
    const response = await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.length).toBe(1);
    expect(response.refreshedCredential).toBeUndefined();
    expect(response.status).toBe("ok");
  });

  test("rotates once and retries once after a mid-flow 401", async () => {
    let usageCalls = 0;
    const fetcher = mockFetcher([
      { when: (method, url) => method === "GET" && url === USAGE_URL && ++usageCalls === 1, respond: { status: 401, body: {} } },
      { when: (method, url) => method === "GET" && url === USAGE_URL, respond: { status: 200, body: MINIMAL_BODY } },
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: REFRESH_BODY } },
    ]);
    const response = await openaiCodexConnector.fetchUsage({
      request: codexUsageRequest(),
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
    expect(response.refreshedCredential?.kind).toBe("oauth");
  });

  test("keeps a pre-rotated credential when the usage call is rate limited", async () => {
    const fetcher = mockFetcher([
      {
        when: `POST ${TOKEN_URL}`,
        respond: {
          status: 200,
          body: REFRESH_BODY,
        },
      },
      {
        when: `GET ${USAGE_URL}`,
        respond: {
          status: 429,
          headers: { "retry-after": "7" },
          body: { error: "rate_limited" },
        },
      },
    ]);
    const error = await bridgeErrorFrom(
      () =>
        openaiCodexConnector.fetchUsage({
          request: codexUsageRequest({
            credential: codexCredential({ expiresAtMs: NOW_MS + 1 }),
          }),
          fetcher,
          nowMs: NOW_MS,
        }),
    );

    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(7_000);
    expect(error.refreshedCredential).toMatchObject({
      kind: "oauth",
      secret: ROTATED_ACCESS,
      oauth: {
        access: ROTATED_ACCESS,
        refresh: ROTATED_REFRESH,
      },
    });
  });

  test("propagates a failed pre-rotation", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${TOKEN_URL}`, respond: { status: 400, body: { error: "invalid_grant" } } },
    ]);
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({
        request: codexUsageRequest({ credential: codexCredential({ expiresAtMs: undefined }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.message).not.toContain(REFRESH);
    expect(fetcher.calls.length).toBe(1);
  });

  test("propagates authRequired when a 401 hits a credential that cannot rotate", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 401, body: {} } });
    const error = await bridgeErrorFrom(() =>
      openaiCodexConnector.fetchUsage({
        request: codexUsageRequest({
          credential: codexCredential({ refresh: undefined, refreshEndpoint: undefined }),
        }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Auth module — refresh()
// ---------------------------------------------------------------------------

describe("refreshOpenAICodexCredential", () => {
  test("refreshes via the OMP refresh grant, keeping identity and filling the embedded client id", async () => {
    const fetcher = mockFetcher({ [`POST ${TOKEN_URL}`]: { status: 200, body: REFRESH_BODY } });
    const credential = codexCredential({
      clientId: undefined,
      identity: { accountId: "acct-codex-unit", email: "dev@example.com" },
    });

    const rotated = await refreshOpenAICodexCredential(credential, fetcher, new AbortController().signal);

    expect(new URLSearchParams(String(fetcher.calls[0]?.init.body))).toEqual(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: REFRESH,
      }),
    );
    if (rotated.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(rotated.oauth.access).toBe(ROTATED_ACCESS);
    expect(rotated.oauth.refresh).toBe(ROTATED_REFRESH);
    expect(rotated.oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(rotated.oauth.clientId).toBe(CLIENT_ID);
    expect(rotated.oauth.identity).toEqual({ accountId: "acct-codex-unit", email: "dev@example.com" });
  });

  test("rejects a token response missing required fields with malformedPayload", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ROTATED_ACCESS, expires_in: 3600 } },
    });
    const error = await bridgeErrorFrom(() =>
      refreshOpenAICodexCredential(codexCredential(), fetcher, new AbortController().signal),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toBe("Token response missing required fields");
  });

  test("rejects a non-OAuth credential with invalidRequest", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      refreshOpenAICodexCredential({ kind: "apiKey", secret: "sk-openai" }, fetcher, new AbortController().signal),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(fetcher.calls.length).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// Auth module — browser login (fixed loopback listener + paste race)
// ---------------------------------------------------------------------------

const AUTH_CODE = "codex-auth-code-unit";
const LOGIN_ACCESS = codexJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-login-unit", chatgpt_plan_type: "Pro" },
  "https://api.openai.com/profile": { email: "dev@example.com" },
});
const LOGIN_REFRESH = "codex-refresh-login-unit";
const LOGIN_TOKEN_BODY = {
  access_token: LOGIN_ACCESS,
  refresh_token: LOGIN_REFRESH,
  expires_in: 28800,
  // The id token's plan claim must lose to the access token's.
  id_token: codexJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "Team" } }),
};

/** Produces the pasted value, given the authorize flow's state. */
type PasteSource = (state: string) => Promise<string> | string;

/** Runs the paste-race login against the mocked token endpoint. */
async function runLoginFlow(
  tokenResponse: Parameters<typeof mockFetcher>[0],
  pasteSource: PasteSource,
  inputs: Parameters<typeof loginOpenAICodex>[1] = {},
): Promise<{
  readonly result: Awaited<ReturnType<typeof loginOpenAICodex>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly openedUrls: string[];
  readonly authorizeUrl: URL;
}> {
  const fetcher = mockFetcher(tokenResponse);
  const collector = eventCollector();
  const openedUrls: string[] = [];
  const controller = new AbortController();

  const loginPromise = loginOpenAICodex("browser", inputs, collector.events, controller.signal, {
    fetcher,
    openBrowser: (url) => {
      openedUrls.push(url);
    },
    readPaste: async () => {
      // The paste needs the state from the authorize URL the flow just opened.
      const openUrlEvent = await collector.waitFor("openUrl");
      if (openUrlEvent.type !== "openUrl") {
        throw new Error("expected an openUrl event");
      }
      return await pasteSource(new URL(openUrlEvent.url).searchParams.get("state") ?? "");
    },
  });

  const openUrlEvent = await collector.waitFor("openUrl");
  if (openUrlEvent.type !== "openUrl") {
    throw new Error("expected an openUrl event");
  }
  const result = await loginPromise;
  return { result, fetcher, collector, openedUrls, authorizeUrl: new URL(openUrlEvent.url) };
}

/** Runs a listener-only login (no paste source); the caller drives the redirect. */
async function runLoopbackLogin(
  tokenResponse: Parameters<typeof mockFetcher>[0],
): Promise<{
  readonly loginPromise: Promise<Awaited<ReturnType<typeof loginOpenAICodex>>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly controller: AbortController;
  readonly authorizeUrl: Promise<URL>;
  /** Blocks the token exchange until released (the redirect response must land first). */
  readonly releaseExchange: () => void;
}> {
  const rawFetcher = mockFetcher(tokenResponse);
  const gate = Promise.withResolvers<void>();
  // The exchange may not start (and stop the listener) before the browser
  // received the redirect response: gate it deterministically.
  const fetcher = Object.assign(
    async (url: string, init: RequestInit) => {
      if (url === TOKEN_URL) {
        await gate.promise;
      }
      return await rawFetcher(url, init);
    },
    { calls: rawFetcher.calls },
  );
  const collector = eventCollector();
  const controller = new AbortController();
  const loginPromise = loginOpenAICodex("browser", {}, collector.events, controller.signal, {
    fetcher,
    openBrowser: () => undefined,
  });
  const authorizeUrl = collector.waitFor("openUrl").then((event) => {
    if (event.type !== "openUrl") {
      throw new Error("expected an openUrl event");
    }
    return new URL(event.url);
  });
  return { loginPromise, fetcher, collector, controller, authorizeUrl, releaseExchange: () => gate.resolve() };
}

describe("openaiCodexAuth — browser login", () => {
  test("captures the fixed localhost:1455/auth/callback redirect on the loopback listener", async () => {
    const { loginPromise, fetcher, collector, authorizeUrl: urlPromise, releaseExchange } = await runLoopbackLogin({
      [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY },
    });
    const authorizeUrl = await urlPromise;
    const state = authorizeUrl.searchParams.get("state") ?? "";

    // The provider redirects the browser to the fixed loopback redirect; the
    // gated exchange starts only after the response reached the browser.
    const redirect = await fetch(
      `http://127.0.0.1:1455/auth/callback?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`,
    );
    expect(redirect.status).toBe(200);
    releaseExchange();
    const result = await loginPromise;

    // Authorize URL: the OMP client id, scope, PKCE S256 challenge, the
    // fixed localhost:1455 redirect, and OMP's extra Codex parameters.
    expect(authorizeUrl.origin).toBe("https://auth.openai.com");
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorizeUrl.searchParams.get("scope")).toBe(SCOPE);
    expect(authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(authorizeUrl.searchParams.get("id_token_add_organizations")).toBe("true");
    expect(authorizeUrl.searchParams.get("codex_cli_simplified_flow")).toBe("true");
    expect(authorizeUrl.searchParams.get("originator")).toBe("pi");

    // Events: openUrl, paste hint (the race), then the two progress waits.
    expect(collector.received().map((event) => event.type)).toEqual([
      "openUrl",
      "pasteHint",
      "waiting",
      "waiting",
    ]);
    expect(collector.received()[2]).toEqual({ type: "waiting", detail: "Waiting for browser authentication..." });
    expect(collector.received()[3]).toEqual({
      type: "waiting",
      detail: "Exchanging authorization code for tokens...",
    });

    // Token exchange: form-urlencoded authorization_code grant with PKCE over
    // the fixed redirect URI.
    expect(fetcher.calls.length).toBe(1);
    const tokenCall = fetcher.calls[0];
    if (tokenCall === undefined) {
      throw new Error("expected a token exchange call");
    }
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).toBe(TOKEN_URL);
    const body = new URLSearchParams(String(tokenCall.init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("code")).toBe(AUTH_CODE);
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    const verifier = body.get("code_verifier") ?? "";
    expect(await pkceChallengeFromVerifier(verifier)).toBe(authorizeUrl.searchParams.get("code_challenge") ?? "");

    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.access).toBe(LOGIN_ACCESS);
    expect(result.credential.oauth.identity).toEqual({
      accountId: "acct-login-unit",
      email: "dev@example.com",
      planType: "pro",
    });
    expect(result.accountLabel).toBe("dev@example.com");

    // The listener released the fixed port when login finished.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch: () => new Response("ok") });
    probe.stop(true);
  });

  test("the paste race wins while the listener stays up, over the fixed redirect exchange", async () => {
    const { result, fetcher, collector, openedUrls, authorizeUrl } = await runLoginFlow(
      { [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY } },
      (state) => `${REDIRECT_URI}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`,
    );

    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(openedUrls).toEqual([]);
    expect(collector.received()[0]?.type).toBe("openUrl");
    expect(collector.received().some((event) => event.type === "pasteHint")).toBe(true);

    expect(fetcher.calls.length).toBe(1);
    const body = new URLSearchParams(String(fetcher.calls[0]?.init.body));
    expect(body.get("code")).toBe(AUTH_CODE);
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(await pkceChallengeFromVerifier(body.get("code_verifier") ?? "")).toBe(
      authorizeUrl.searchParams.get("code_challenge") ?? "",
    );

    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    const oauth = result.credential.oauth;
    expect(oauth.access).toBe(LOGIN_ACCESS);
    expect(oauth.refresh).toBe(LOGIN_REFRESH);
    expect(oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(oauth.clientId).toBe(CLIENT_ID);
    const expectedExpiry = Date.now() + 28_800_000;
    expect(oauth.expiresAtMs).toBeGreaterThan(expectedExpiry - 60_000);
    expect(oauth.expiresAtMs).toBeLessThanOrEqual(expectedExpiry);
    expect(oauth.identity).toEqual({ accountId: "acct-login-unit", email: "dev@example.com", planType: "pro" });
    expect(result.accountLabel).toBe("dev@example.com");
    expect(JSON.stringify(result.credential)).not.toContain(AUTH_CODE);

    // The listener released the fixed port when login finished.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch: () => new Response("ok") });
    probe.stop(true);
  });

  test("a forged-state redirect is ignored by the listener; the genuine redirect completes the login", async () => {
    const { loginPromise, fetcher, authorizeUrl: urlPromise, releaseExchange } = await runLoopbackLogin({
      [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY },
    });
    const authorizeUrl = await urlPromise;
    const state = authorizeUrl.searchParams.get("state") ?? "";

    const forged = await fetch("http://127.0.0.1:1455/auth/callback?code=forged&state=deadbeef");
    expect(forged.status).toBe(500);

    const genuine = await fetch(
      `http://127.0.0.1:1455/auth/callback?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`,
    );
    expect(genuine.status).toBe(200);
    releaseExchange();
    const result = await loginPromise;
    expect(fetcher.calls).toHaveLength(1);
    expect(result.credential.kind).toBe("oauth");
  });

  test("routes the production paste race through AuthEvents.requestInput", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY },
    });
    const collector = eventCollector();
    const events: AuthEvents = {
      onEvent: collector.events.onEvent,
      requestInput: async (prompt) => {
        expect(prompt).toEqual({
          prompt: expect.stringContaining("paste that full redirected URL"),
          inputKind: "redirectUrl",
          sensitive: true,
        });
        const openEvent = collector.received().find(event => event.type === "openUrl");
        if (openEvent?.type !== "openUrl") {
          throw new Error("expected the authorization URL before the prompt");
        }
        const state = new URL(openEvent.url).searchParams.get("state") ?? "";
        return `${REDIRECT_URI}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`;
      },
    };

    const result = await loginOpenAICodex(
      "browser",
      {},
      events,
      new AbortController().signal,
      { fetcher, openBrowser: () => {} },
    );

    expect(result.credential.kind).toBe("oauth");
    expect(fetcher.calls).toHaveLength(1);
  });

  test("re-prompts when a pasted code omits state", async () => {
    let promptCount = 0;
    const { result } = await runLoginFlow(
      { [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY } },
      (state) => {
        promptCount += 1;
        return promptCount === 1 ? AUTH_CODE : `${AUTH_CODE}#${state}`;
      },
    );
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.access).toBe(LOGIN_ACCESS);
    expect(result.accountLabel).toBe("dev@example.com");
    expect(promptCount).toBe(2);
  });

  test("re-prompts when the pasted state does not match (OMP manual-input loop)", async () => {
    const pastes: string[] = [];
    const { result } = await runLoginFlow(
      { [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY } },
      (state) => {
        pastes.push(state);
        if (pastes.length === 1) {
          // First paste carries a forged state: rejected, re-prompt.
          return `${REDIRECT_URI}?code=${encodeURIComponent(`${AUTH_CODE}-forged`)}&state=deadbeef`;
        }
        return `${REDIRECT_URI}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`;
      },
    );
    expect(pastes.length).toBe(2);
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.access).toBe(LOGIN_ACCESS);
  });

  test("stores a trimmed inputs.apiBaseUrl as identity.baseUrl", async () => {
    const { result } = await runLoginFlow(
      { [`POST ${TOKEN_URL}`]: { status: 200, body: LOGIN_TOKEN_BODY } },
      (state) => `${AUTH_CODE}#${state}`,
      { apiBaseUrl: " https://chatgpt.com/backend-api " },
    );
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.identity?.["baseUrl"]).toBe("https://chatgpt.com/backend-api");
  });

  test("maps a token response missing refresh_token to malformedPayload", async () => {
    const error = await bridgeErrorFrom(() =>
      runLoginFlow(
        { [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: LOGIN_ACCESS, expires_in: 28800 } } },
        (state) => `${AUTH_CODE}#${state}`,
      ),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toBe("Token response missing required fields");
  });

  test("maps a non-JWT access token without an account id to malformedPayload", async () => {
    const error = await bridgeErrorFrom(() =>
      runLoginFlow(
        {
          [`POST ${TOKEN_URL}`]: {
            status: 200,
            body: { access_token: "opaque-access", refresh_token: LOGIN_REFRESH, expires_in: 28800 },
          },
        },
        (state) => `${AUTH_CODE}#${state}`,
      ),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toBe("Failed to extract accountId from token");
  });

  test("maps a rejected token exchange to the callProviderHttp status map", async () => {
    const error = await bridgeErrorFrom(() =>
      runLoginFlow(
        { [`POST ${TOKEN_URL}`]: { status: 400, body: { error: "invalid_grant", error_description: "bad verifier" } } },
        (state) => `${AUTH_CODE}#${state}`,
      ),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.message).not.toContain(AUTH_CODE);
  });

  test("maps an aborted login signal to a timeout BridgeError with a cancelled message", async () => {
    const fetcher = mockFetcher([]);
    const collector = eventCollector();
    const controller = new AbortController();
    const loginPromise = loginOpenAICodex("browser", {}, collector.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
      readPaste: () => new Promise<string>(() => undefined),
    });
    await collector.waitFor("openUrl");
    controller.abort(new Error("user closed the browser"));

    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(fetcher.calls.length).toBe(0);
  });

  test("aborts a listener-only login with a cancelled timeout", async () => {
    const { loginPromise, collector, controller } = await runLoopbackLogin({});
    await collector.waitFor("openUrl");
    controller.abort(new Error("user closed the browser"));

    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
  });

  test("maps a busy port 1455 to dependencyUnavailable without any token call", async () => {
    const blocker = Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch: () => new Response("no") });
    try {
      const fetcher = mockFetcher([]);
      const error = await bridgeErrorFrom(() =>
        loginOpenAICodex("browser", {}, eventCollector().events, new AbortController().signal, {
          fetcher,
          openBrowser: () => undefined,
          readPaste: async () => AUTH_CODE,
        }),
      );
      expect(error.kind).toBe("dependencyUnavailable");
      expect(error.message).toContain("1455");
      expect(error.message).toContain("device");
      expect(fetcher.calls.length).toBe(0);
    } finally {
      blocker.stop(true);
    }
  });

  test("rejects an already-aborted signal before opening the browser", async () => {
    const collector = eventCollector();
    const controller = new AbortController();
    controller.abort();
    const error = await bridgeErrorFrom(() =>
      loginOpenAICodex("browser", {}, collector.events, controller.signal, {
        fetcher: mockFetcher([]),
        readPaste: async () => AUTH_CODE,
      }),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(collector.received().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auth module — device login (OMP headless device authorization)
// ---------------------------------------------------------------------------

const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTHORIZATION = {
  device_auth_id: "dad-1",
  user_code: "WDJB-MJHT",
  interval: 5,
};

/** Virtual sleep: records waits without advancing the real clock. */
function recordingSleep(): {
  readonly sleep: (ms: number) => Promise<void>;
  readonly waits: readonly number[];
} {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

/** Poll responses for the device token endpoint: matched in order, the last repeats. */
function devicePollRules(
  responses: ReadonlyArray<{ status: number; body?: unknown }>,
): readonly MockRouteRule[] {
  // A single ticker rule counts polls; exactly one predicate may mutate the
  // counter or first-match ordering breaks with double increments.
  let call = 0;
  const last = responses[responses.length - 1] ?? { status: 403, body: {} };
  const isTokenPoll = (method: string, url: string) => method === "POST" && url === DEVICE_TOKEN_URL;
  return [
    { when: (method, url) => (isTokenPoll(method, url) ? ((call += 1), false) : false), respond: { status: 599, body: {} } },
    ...responses.slice(0, -1).map((response, index) => ({
      when: (method: string, url: string) => isTokenPoll(method, url) && call === index + 1,
      respond: response,
    })),
    { when: (method: string, url: string) => isTokenPoll(method, url) && call >= responses.length, respond: last },
  ];
}

/** Runs the device login against mocked endpoints. */
async function runDeviceLogin(
  usercode: MockResponse,
  pollResponses: ReadonlyArray<{ status: number; body?: unknown }>,
  exchange: MockResponse,
): Promise<{
  readonly run: () => Promise<Awaited<ReturnType<typeof loginOpenAICodex>>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly waits: readonly number[];
}> {
  const fetcher = mockFetcher([
    { when: `POST ${DEVICE_USERCODE_URL}`, respond: usercode },
    ...devicePollRules(pollResponses),
    { when: `POST ${TOKEN_URL}`, respond: exchange },
  ]);
  const collector = eventCollector();
  const { sleep, waits } = recordingSleep();
  return {
    run: () => loginOpenAICodex("device", {}, collector.events, new AbortController().signal, { fetcher, sleep }),
    fetcher,
    collector,
    waits,
  };
}

describe("openaiCodexAuth — device login", () => {
  test("completes the OMP headless device flow and returns the OAuth credential", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: DEVICE_AUTHORIZATION },
      [
        { status: 403, body: {} },
        { status: 404, body: {} },
        { status: 200, body: { authorization_code: AUTH_CODE, code_verifier: "server-verifier-unit" } },
      ],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    const result = await device.run();

    // Events: progress, the device page URL + code, waits, exchange.
    expect(device.collector.received()).toEqual([
      { type: "waiting", detail: "Initiating device authorization..." },
      { type: "openUrl", url: `${DEVICE_AUTH_URL}?user_code=WDJB-MJHT` },
      { type: "code", code: "WDJB-MJHT", verificationUrl: DEVICE_AUTH_URL },
      { type: "waiting", detail: "Enter code: WDJB-MJHT" },
      { type: "waiting", detail: "Waiting for browser authorization..." },
      { type: "waiting", detail: "Exchanging authorization code for tokens..." },
    ]);

    expect(device.fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${DEVICE_USERCODE_URL}`,
      `POST ${DEVICE_TOKEN_URL}`,
      `POST ${DEVICE_TOKEN_URL}`,
      `POST ${DEVICE_TOKEN_URL}`,
      `POST ${TOKEN_URL}`,
    ]);
    const usercodeCall = device.fetcher.calls[0];
    const usercodeHeaders = new Headers(usercodeCall?.init.headers);
    expect(usercodeHeaders.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(usercodeCall?.init.body))).toEqual({ client_id: CLIENT_ID });
    expect(usercodeCall?.init.signal).toBeInstanceOf(AbortSignal);

    const pollCall = device.fetcher.calls[1];
    expect(JSON.parse(String(pollCall?.init.body))).toEqual({
      device_auth_id: "dad-1",
      user_code: "WDJB-MJHT",
    });

    // Waits: first min(8000, 5000) = 5000, then the 5s + 3s margin intervals.
    expect(device.waits).toEqual([5000, 8000, 8000]);

    // Exchange: the server-provided verifier over the device redirect URI.
    const exchangeCall = device.fetcher.calls[4];
    const exchangeBody = new URLSearchParams(String(exchangeCall?.init.body));
    expect(exchangeCall?.url).toBe(TOKEN_URL);
    expect(exchangeBody.get("grant_type")).toBe("authorization_code");
    expect(exchangeBody.get("client_id")).toBe(CLIENT_ID);
    expect(exchangeBody.get("code")).toBe(AUTH_CODE);
    expect(exchangeBody.get("code_verifier")).toBe("server-verifier-unit");
    expect(exchangeBody.get("redirect_uri")).toBe(DEVICE_REDIRECT_URI);

    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.access).toBe(LOGIN_ACCESS);
    expect(result.credential.oauth.refresh).toBe(LOGIN_REFRESH);
    expect(result.credential.oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(result.credential.oauth.clientId).toBe(CLIENT_ID);
    expect(result.credential.oauth.identity).toEqual({
      accountId: "acct-login-unit",
      email: "dev@example.com",
      planType: "pro",
    });
    expect(result.accountLabel).toBe("dev@example.com");
    expect(JSON.stringify(result.credential)).not.toContain("server-verifier-unit");
  });

  test("honors a string interval and applies the 3s safety margin", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: { ...DEVICE_AUTHORIZATION, interval: "10" } },
      [
        { status: 403, body: {} },
        { status: 200, body: { authorization_code: AUTH_CODE, code_verifier: "v" } },
      ],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    await device.run();
    // (10 * 1000) + 3000 per wait; the first wait is capped at 5000.
    expect(device.waits).toEqual([5000, 13000]);
  });

  test("defaults the interval to 5s when omitted", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: { device_auth_id: "dad-1", user_code: "WDJB-MJHT" } },
      [{ status: 200, body: { authorization_code: AUTH_CODE, code_verifier: "v" } }],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    await device.run();
    expect(device.waits).toEqual([5000]);
  });

  test("maps a failed initiation to the status map with the OMP message", async () => {
    const device = await runDeviceLogin(
      { status: 500, body: { error: "boom" } },
      [{ status: 200, body: { authorization_code: AUTH_CODE, code_verifier: "v" } }],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    const error = await bridgeErrorFrom(() => device.run());
    expect(error.kind).toBe("upstreamError");
    expect(error.message).toBe("Device authorization initiation failed: 500");
    expect(device.fetcher.calls).toHaveLength(1);
  });

  test("maps a missing usercode field to malformedPayload", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: { device_auth_id: "dad-1" } },
      [{ status: 200, body: { authorization_code: AUTH_CODE, code_verifier: "v" } }],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    const error = await bridgeErrorFrom(() => device.run());
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toBe("Device authorization response missing required fields");
  });

  test("maps a terminal polling status to upstreamError with the OMP message", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: DEVICE_AUTHORIZATION },
      [{ status: 400, body: { error: "expired_token" } }],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    const error = await bridgeErrorFrom(() => device.run());
    expect(error.kind).toBe("upstreamError");
    expect(error.message).toBe("Device token polling failed: 400");
    expect(device.fetcher.calls).toHaveLength(2);
  });

  test("maps an incomplete poll payload to malformedPayload", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: DEVICE_AUTHORIZATION },
      [{ status: 200, body: { authorization_code: AUTH_CODE } }],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    const error = await bridgeErrorFrom(() => device.run());
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toBe("Device token response missing authorization_code or code_verifier");
  });

  test("stops after the OMP poll cap with the timeout message", async () => {
    const device = await runDeviceLogin(
      { status: 200, body: DEVICE_AUTHORIZATION },
      [{ status: 403, body: {} }],
      { status: 200, body: LOGIN_TOKEN_BODY },
    );
    const error = await bridgeErrorFrom(() => device.run());
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("Device authorization timed out - user did not complete login in time");
    // 120 polls maximum (OMP DEVICE_MAX_POLLS), plus the initiation request.
    expect(device.fetcher.calls).toHaveLength(1 + 120);
  });

  test("cancels with a timeout when the signal aborts during polling", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${DEVICE_USERCODE_URL}`, respond: { status: 200, body: DEVICE_AUTHORIZATION } },
      { when: `POST ${DEVICE_TOKEN_URL}`, respond: { status: 403, body: {} } },
    ]);
    const controller = new AbortController();
    const waits: number[] = [];
    const error = await bridgeErrorFrom(() =>
      loginOpenAICodex("device", {}, eventCollector().events, controller.signal, {
        fetcher,
        sleep: async (ms: number) => {
          waits.push(ms);
          if (waits.length === 2) {
            controller.abort(new Error("user gave up"));
          }
        },
      }),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("Device authorization cancelled");
    // Aborted during the second wait: the second poll never fires.
    expect(waits).toEqual([5000, 8000]);
    expect(fetcher.calls).toHaveLength(2);
  });

  test("rejects an already-aborted signal before initiating", async () => {
    const fetcher = mockFetcher([]);
    const controller = new AbortController();
    controller.abort();
    const error = await bridgeErrorFrom(() =>
      loginOpenAICodex("device", {}, eventCollector().events, controller.signal, { fetcher }),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(fetcher.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Module surface
// ---------------------------------------------------------------------------

describe("openaiCodex module surface", () => {
  test("exposes the browser and device auth methods and the openai-codex-1 connector", async () => {
    expect(openaiCodexAuth.providerId).toBe("openai-codex");
    expect(openaiCodexAuth.methods).toEqual(["browser", "device"]);
    expect(typeof openaiCodexAuth.refresh).toBe("function");
    expect(openaiCodexConnector.providerId).toBe("openai-codex");
    expect(openaiCodexConnector.connectorVersion).toBe("openai-codex-1");

    const error = await bridgeErrorFrom(() =>
      openaiCodexAuth.login("apiKey", {}, eventCollector().events, AbortSignal.timeout(50)),
    );
    expect(error.kind).toBe("invalidRequest");
  });

  test("fetchUsage is the exported connector entry point", () => {
    expect(openaiCodexConnector.fetchUsage).toBe(fetchOpenAICodexUsage);
  });
});

// Identity claims intentionally disagree: equal fixtures cannot prove precedence.
const IDENTITY_ID_TOKEN = codexJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-id-only", chatgpt_plan_type: " Team " },
  "https://api.openai.com/profile": { email: " ID-Only@Example.COM " },
});

async function identityLogin(method: "browser" | "device", access: string, idToken?: string) {
  const body = { access_token: access, refresh_token: LOGIN_REFRESH, expires_in: 28800,
    ...(idToken !== undefined ? { id_token: idToken } : {}) };
  if (method === "browser") {
    return (await runLoginFlow({ [`POST ${TOKEN_URL}`]: { status: 200, body } },
      (state) => `${AUTH_CODE}#${state}`)).result;
  }
  const device = await runDeviceLogin({ status: 200, body: DEVICE_AUTHORIZATION },
    [{ status: 200, body: { authorization_code: AUTH_CODE, code_verifier: "identity-verifier" } }],
    { status: 200, body });
  return await device.run();
}

describe("Codex login identity fallback and refresh isolation", () => {
  for (const method of ["browser", "device"] as const) {
    for (const access of ["opaque-access", codexJwt({})]) {
      test(`${method} uses ID-only account/email for absent access claims (${access === "opaque-access" ? "opaque" : "JWT"})`, async () => {
        const result = await identityLogin(method, access, IDENTITY_ID_TOKEN);
        expect(result.credential).toMatchObject({ kind: "oauth", oauth: { identity: {
          accountId: "acct-id-only", email: "id-only@example.com", planType: "team",
        } } });
        expect(result.accountLabel).toBe("id-only@example.com");
        expect(JSON.stringify(result)).not.toContain(IDENTITY_ID_TOKEN);
      });
    }
    test(`${method} keeps distinct access claims ahead of ID claims`, async () => {
      const result = await identityLogin(method, LOGIN_ACCESS, IDENTITY_ID_TOKEN);
      expect(result.credential).toMatchObject({ kind: "oauth", oauth: { identity: {
        accountId: "acct-login-unit", email: "dev@example.com", planType: "pro",
      } } });
    });
    test(`${method} falls back field-wise when only access email is absent`, async () => {
      const access = codexJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-access" } });
      const result = await identityLogin(method, access, IDENTITY_ID_TOKEN);
      expect(result.credential).toMatchObject({ kind: "oauth", oauth: { identity: {
        accountId: "acct-access", email: "id-only@example.com", planType: "team",
      } } });
    });
    test(`${method} falls back field-wise when only access account is absent`, async () => {
      const access = codexJwt({ "https://api.openai.com/profile": { email: " ACCESS@Example.COM " } });
      const result = await identityLogin(method, access, IDENTITY_ID_TOKEN);
      expect(result.credential).toMatchObject({ kind: "oauth", oauth: { identity: {
        accountId: "acct-id-only", email: "access@example.com", planType: "team",
      } } });
    });
    for (const idToken of [undefined, "broken.jwt.payload", codexJwt({})]) {
      test(`${method} rejects missing identity with unusable ID token (${idToken === undefined ? "absent" : idToken === "broken.jwt.payload" ? "malformed" : "empty"})`, async () => {
        const error = await bridgeErrorFrom(() => identityLogin(method, "opaque-access", idToken));
        expect(error.kind).toBe("malformedPayload");
        expect(error.message).not.toContain("opaque-access");
        expect(error.message).not.toContain(LOGIN_REFRESH);
      });
    }
  }

  const changedTokens = {
    access_token: codexJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-refresh-access", chatgpt_plan_type: "free" },
      "https://api.openai.com/profile": { email: "refresh-access@example.com" },
    }),
    id_token: IDENTITY_ID_TOKEN, refresh_token: ROTATED_REFRESH, expires_in: 3600,
  };
  const identity = { accountId: "acct-login-fixed", email: "login-fixed@example.com", planType: "pro",
    baseUrl: "https://chatgpt.com/backend-api" };

  test("direct refresh never re-infers identity from distinct access/ID claims", async () => {
    const fetcher = mockFetcher({ [`POST ${TOKEN_URL}`]: { status: 200, body: changedTokens } });
    const rotated = await refreshOpenAICodexCredential(codexCredential({ identity }), fetcher, AbortSignal.timeout(5000));
    expect(rotated).toMatchObject({ kind: "oauth", oauth: { access: changedTokens.access_token, identity } });
    expect(JSON.stringify(rotated)).not.toContain(IDENTITY_ID_TOKEN);
  });

  for (const mode of ["preflight", "401", "rateLimited", "noData"] as const) {
    test(`${mode} rotation preserves login identity in credentials and outgoing usage/reset-credit headers`, async () => {
      let calls = 0;
      const fetcher = mockFetcher([
        { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: changedTokens } },
        { when: (method, url) => method === "GET" && url === USAGE_URL && ++calls === 1 && mode === "401",
          respond: { status: 401, body: {} } },
        { when: `GET ${USAGE_URL}`, respond: mode === "rateLimited" ? { status: 429, body: {} }
          : { status: 200, body: mode === "noData" ? {} : HAPPY_BODY } },
        { when: `GET ${RESET_CREDITS_URL}`, respond: { status: 200, body: RESET_CREDITS_BODY } },
      ]);
      const run = () => openaiCodexConnector.fetchUsage({ request: codexUsageRequest({
        credential: codexCredential({ identity, expiresAtMs: mode === "401" ? NOW_MS + 3600000 : NOW_MS }),
      }), fetcher, nowMs: NOW_MS });
      const response = mode === "rateLimited" || mode === "noData" ? await bridgeErrorFrom(run) : await run();
      expect(response.refreshedCredential).toMatchObject({ kind: "oauth", oauth: { identity, access: changedTokens.access_token } });
      for (const call of fetcher.calls.filter(call => call.method === "GET")) {
        expect(new Headers(call.init.headers).get("ChatGPT-Account-Id")).toBe(identity.accountId);
      }
      expect(JSON.stringify(response)).not.toContain(IDENTITY_ID_TOKEN);
    });
  }
});

describe("Codex closed-wire severity boundaries", () => {
  for (const [percent, severity] of [[79.9, "ok"], [80, "warning"], [87.5, "warning"],
    [89.9, "warning"], [95, "critical"], [99.9, "critical"], [100, "exhausted"]] as const) {
    test(`uses ${severity} at ${percent}% even with explicitly allowed flags`, async () => {
      const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { rate_limit: {
        allowed: true, limit_reached: false, primary_window: { used_percent: percent },
      } } } });
      const response = await openaiCodexConnector.fetchUsage({ request: codexUsageRequest(), fetcher, nowMs: NOW_MS });
      expect(response.report.windows[0]?.resolvedFraction).toBe(percent / 100);
      expect(response.report.windows[0]?.severity).toBe(severity);
    });
  }
});


describe("Codex decoded profile type boundary", () => {
  const authClaim = "https://api.openai.com/auth";
  const profileClaim = "https://api.openai.com/profile";
  const unusable = [["number", 17], ["object", {}], ["array", []], ["boolean", false],
    ["absent", undefined], ["null", null], ["empty", ""], ["whitespace", " \t "]] as const;
  const claims = (accountId?: unknown, email?: unknown, plan?: unknown) => ({
    [authClaim]: { chatgpt_account_id: accountId, chatgpt_plan_type: plan }, [profileClaim]: { email },
  });
  const identityOf = (result: Awaited<ReturnType<typeof identityLogin>>) => {
    if (result.credential.kind !== "oauth") throw new Error("expected OAuth result");
    return result.credential.oauth.identity;
  };
  for (const method of ["browser", "device"] as const) {
    test(`${method} normalizes usable strings without changing workspace case`, async () => {
      const result = await identityLogin(method, codexJwt(claims(" Workspace-Access ", " ACCESS@Example.COM ", " PRO ")),
        IDENTITY_ID_TOKEN);
      expect(identityOf(result)).toEqual({ accountId: "Workspace-Access", email: "access@example.com", planType: "pro" });
      expect(result.accountLabel).toBe("access@example.com");
    });
    for (const [label, value] of unusable) {
      for (const field of ["email", "plan"] as const) {
        test(`${method} ignores ${label} optional ID ${field} with a valid access workspace`, async () => {
          const id = field === "email" ? claims(undefined, value, " Team ") : claims(undefined, " ID@Example.COM ", value);
          const result = await identityLogin(method, codexJwt(claims("Workspace-Access")), codexJwt(id));
          expect(identityOf(result)).toEqual(field === "email"
            ? { accountId: "Workspace-Access", planType: "team" }
            : { accountId: "Workspace-Access", email: "id@example.com" });
          expect(result.accountLabel).toBe(field === "email" ? "Workspace-Access" : "id@example.com");
        });
      }
      test(`${method} falls back field-wise from ${label} access claims to usable ID strings`, async () => {
        const result = await identityLogin(method, codexJwt(claims(value, value, value)), IDENTITY_ID_TOKEN);
        expect(identityOf(result)).toEqual({ accountId: "acct-id-only", email: "id-only@example.com", planType: "team" });
      });
      test(`${method} valid access fields beat ${label} ID claims`, async () => {
        const result = await identityLogin(method, LOGIN_ACCESS, codexJwt(claims(value, value, value)));
        expect(identityOf(result)).toEqual({ accountId: "acct-login-unit", email: "dev@example.com", planType: "pro" });
      });
      test(`${method} rejects ${label} required workspace in both tokens with malformedPayload`, async () => {
        const error = await bridgeErrorFrom(() => identityLogin(method,
          codexJwt(claims(value)), codexJwt(claims(value))));
        expect(error.kind).toBe("malformedPayload");
        expect(error.refreshedCredential).toBeUndefined();
      });
    }
    for (const [label, value] of unusable.slice(0, 6)) {
      test(`${method} ignores ${label} nested claim blocks before ID fallback`, async () => {
        const result = await identityLogin(method, codexJwt({ [authClaim]: value, [profileClaim]: value }), IDENTITY_ID_TOKEN);
        expect(identityOf(result)).toEqual({ accountId: "acct-id-only", email: "id-only@example.com", planType: "team" });
      });
    }
  }
  for (const [label, value] of unusable) {
    test(`usage JWT workspace extraction ignores ${label} optional email and plan`, async () => {
      const access = codexJwt(claims("Workspace-Usage", value, value));
      const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: MINIMAL_BODY } });
      await fetchOpenAICodexUsage({ request: codexUsageRequest({ credential: codexCredential({ access, identity: undefined }) }),
        fetcher, nowMs: NOW_MS });
      expect(new Headers(fetcher.calls[0]?.init.headers).get("ChatGPT-Account-Id")).toBe("Workspace-Usage");
    });
  }
});
