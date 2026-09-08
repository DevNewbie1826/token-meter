import { describe, expect, test } from "bun:test";
import summaryFixture from "../fixtures/antigravity-summary.json";
import remainingFixture from "../fixtures/antigravity-remaining.json";
import boundaryFixtures from "../fixtures/antigravity-boundaries.json";
import {
  fetchAntigravityUsage,
  googleAntigravityAuth,
  googleAntigravityConnector,
  loginAntigravity,
  refreshAntigravityCredential,
} from "../src/providers/google-antigravity";
import { BridgeError } from "../src/protocol";
import type { BridgeCredential, BridgeRequest, UsageWindow } from "../src/protocol";
import type { AuthEvent, AuthEvents } from "../src/dispatch";
import type { MockResponse, RecordedCall } from "./helpers";
import { buildLoginRequest, buildUsageRequest, expectLoopbackClosed, expectNoModelFields, mockFetcher, waitForCount } from "./helpers";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1787011200500; // 2026-08-18T00:00:00.500Z

// Base64 verbatim from OMP packages/ai/src/registry/oauth/google-antigravity.ts @ 8500092,
// matching the bridge src representation (bridge/src/providers/google-antigravity.ts).
const CLIENT_ID = atob(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50" +
    "LmNvbQ==",
);
const CLIENT_SECRET = atob("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");
const ANTIGRAVITY_UA = "antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const USAGE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const SANDBOX_USAGE_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels";
const LOAD_DAILY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const LOAD_CLOUDCODE_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
const SUMMARY_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const SUMMARY_SANDBOX_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary";
const OPERATION_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal/operations/onboard-unit";

const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

// 12h from NOW (inside one day -> daily) and 3d from NOW (weekly).
const DAILY_RESET_ISO = "2026-08-18T12:00:00Z";
const WEEKLY_RESET_ISO = "2026-08-21T12:00:00Z";
const DAILY_RESET_MS = 1787054400000;
const WEEKLY_RESET_MS = 1787313600000;

const ACCESS = "ag-access-unit";
const REFRESH = "ag-refresh-unit";

function oauthCredential(overrides: { expiresAtMs?: number; dropRefresh?: boolean; dropIdentity?: boolean } = {}): BridgeCredential {
  const oauth = {
    access: ACCESS,
    ...(overrides.dropRefresh ? {} : { refresh: REFRESH }),
    ...(overrides.expiresAtMs !== undefined ? { expiresAtMs: overrides.expiresAtMs } : { expiresAtMs: NOW_MS + 3_600_000 }),
    refreshEndpoint: TOKEN_URL,
    clientId: CLIENT_ID,
    ...(overrides.dropIdentity ? {} : { identity: { projectId: "proj-unit-1", email: "dev@example.com" } }),
  };
  return { kind: "oauth", secret: ACCESS, oauth };
}

function antigravityUsageRequest(overrides: { providerId?: string; credential?: BridgeCredential } = {}): BridgeRequest {
  return buildUsageRequest({
    providerId: overrides.providerId ?? "google-antigravity",
    connectorId: "google-antigravity",
    credential: overrides.credential ?? oauthCredential(),
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

/** A fetcher whose routes serve a queue of responses per "METHOD url". */
type QueuedFetcher = {
  (url: string, init: RequestInit): Promise<Response>;
  readonly calls: RecordedCall[];
};

function queuedFetcher(routes: Readonly<Record<string, readonly MockResponse[]>>): QueuedFetcher {
  const queues = new Map(Object.entries(routes).map(([key, responses]) => [key, [...responses]]));
  const calls: RecordedCall[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const queue = queues.get(`${method} ${url}`);
    const response = queue?.shift();
    if (response === undefined) {
      throw new Error(`queuedFetcher has no queued response for ${method} ${url}`);
    }
    const text = response.body === undefined ? null : JSON.stringify(response.body);
    return new Response(text, {
      status: response.status,
      ...(response.headers !== undefined ? { headers: response.headers } : {}),
    });
  };
  return Object.assign(fetcher, { calls });
}

// Realistic OMP-shaped payload (packages/ai/src/usage/google-antigravity.ts
// shapes): per-backend counters with explicit WINDOW_* ids, Google counters
// split across two models (dedupe keeps the lower remaining), Anthropic
// counters inferred from reset distance, and an exhausted OpenAI counter that
// keeps only resetTime (OMP's observed shape).
const USAGE_BODY = {
  models: {
    "gemini-3-pro-preview": {
      displayName: "Gemini 3 Pro Preview",
      modelProvider: "MODEL_PROVIDER_GOOGLE",
      quotaInfos: [
        { remainingFraction: 0.5, resetTime: DAILY_RESET_ISO, windowId: "WINDOW_DAILY" },
        { remainingFraction: 0.75, resetTime: WEEKLY_RESET_ISO, windowId: "WINDOW_WEEKLY" },
      ],
    },
    "gemini-3-flash": {
      displayName: "Gemini 3 Flash",
      modelProvider: "MODEL_PROVIDER_GOOGLE",
      quotaInfos: [
        // Same counter/window as above with lower remaining -> dedupe keeps it.
        { remainingFraction: 0.25, resetTime: DAILY_RESET_ISO, windowId: "WINDOW_DAILY" },
      ],
      // dailyQuotaInfo path merges into the same google/daily counter.
      dailyQuotaInfo: { remainingFraction: 0.75, resetTime: DAILY_RESET_ISO },
    },
    "claude-sonnet-4-6": {
      displayName: "Claude Sonnet 4.6",
      modelProvider: "MODEL_PROVIDER_ANTHROPIC",
      // No window ids: daily/weekly inferred from reset distance within the group.
      quotaInfos: [
        { remainingFraction: 0.125, resetTime: DAILY_RESET_ISO },
        { remainingFraction: 0.0625, resetTime: WEEKLY_RESET_ISO },
      ],
    },
    "gpt-oss-120b": {
      displayName: "GPT-OSS 120B",
      modelProvider: "MODEL_PROVIDER_OPENAI",
      // Exhausted until reset: remainingFraction omitted, resetTime kept.
      quotaInfos: [{ resetTime: DAILY_RESET_ISO }],
    },
  },
};

// OMP limit ids (`provider:counter:tier:window`), sorted ascending by
// remaining fraction (most-pressured first).
const EXPECTED_WINDOWS: readonly UsageWindow[] = [
  {
    id: "google-antigravity:openai:default:daily",
    label: "Usage (OpenAI)",
    unit: "percent",
    resolvedFraction: 1,
    severity: "exhausted",
    used: 100,
    limit: 100,
    resetsAtMs: DAILY_RESET_MS,
  },
  {
    id: "google-antigravity:anthropic:default:weekly",
    label: "Usage (Anthropic)",
    unit: "percent",
    resolvedFraction: 0.9375,
    severity: "warning",
    used: 93.75,
    limit: 100,
    resetsAtMs: WEEKLY_RESET_MS,
  },
  {
    id: "google-antigravity:anthropic:default:daily",
    label: "Usage (Anthropic)",
    unit: "percent",
    resolvedFraction: 0.875,
    severity: "warning",
    used: 87.5,
    limit: 100,
    resetsAtMs: DAILY_RESET_MS,
  },
  {
    id: "google-antigravity:google:default:daily",
    label: "Usage (Google)",
    unit: "percent",
    resolvedFraction: 0.75,
    severity: "ok",
    used: 75,
    limit: 100,
    resetsAtMs: DAILY_RESET_MS,
  },
  {
    id: "google-antigravity:google:default:weekly",
    label: "Usage (Google)",
    unit: "percent",
    resolvedFraction: 0.25,
    severity: "ok",
    used: 25,
    limit: 100,
    resetsAtMs: WEEKLY_RESET_MS,
  },
];

// ---------------------------------------------------------------------------
// Usage connector — happy path
// ---------------------------------------------------------------------------

describe("googleAntigravityConnector — quota mapping", () => {
  test("maps the OMP fetchAvailableModels payload to normalized windows over the exact upstream call", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 }, [`POST ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const request = antigravityUsageRequest();
    const response = await googleAntigravityConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.length).toBe(2);
    const usageCall = fetcher.calls[1];
    if (usageCall === undefined) {
      throw new Error("expected the usage endpoint to be called");
    }
    expect(usageCall.method).toBe("POST");
    expect(usageCall.url).toBe(USAGE_URL);
    const headers = new Headers(usageCall.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("User-Agent")).toBe(ANTIGRAVITY_UA);
    expect(JSON.parse(String(usageCall.init.body))).toEqual({ project: "proj-unit-1" });
    expect(usageCall.init.signal).toBeInstanceOf(AbortSignal);

    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(request.requestId);
    expect(response.providerId).toBe("google-antigravity");
    expect(response.connectorId).toBe("google-antigravity");
    expect(response.accountRef).toBe(request.accountRef);
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();

    const report = response.report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("privateApi");
    expect(report.fetchedAtMs).toBe(NOW_MS);
    expect(report.connectorVersion).toBe("google-antigravity-1");
    expect(report.windows).toEqual(EXPECTED_WINDOWS);
    expectNoModelFields(response);
  });

  test("falls back to the sandbox endpoint on a transient daily failure", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 },
      [`POST ${USAGE_URL}`]: { status: 503, body: { error: "backend unavailable" } },
      [`POST ${SANDBOX_USAGE_URL}`]: { status: 200, body: USAGE_BODY },
    });
    const response = await googleAntigravityConnector.fetchUsage({
      request: antigravityUsageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, USAGE_URL, SANDBOX_USAGE_URL]);
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
  });

  test("keeps the credential out of the serialized response", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 }, [`POST ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const response = await googleAntigravityConnector.fetchUsage({
      request: antigravityUsageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(JSON.stringify(response)).not.toContain(ACCESS);
    expect(JSON.stringify(response)).not.toContain(REFRESH);
  });
});

// ---------------------------------------------------------------------------
// Usage connector — OAuth rotation
// ---------------------------------------------------------------------------

describe("googleAntigravityConnector — OAuth rotation", () => {
  test("pre-rotates an expiring token and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: "ag-access-rotated", refresh_token: "ag-refresh-rotated", expires_in: 3600 },
      },
      [`POST ${USAGE_URL}`]: { status: 200, body: USAGE_BODY },
    });
    // expiresAtMs within the 60s rotation window.
    const request = antigravityUsageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 30_000 }) });
    const response = await googleAntigravityConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    // Rotation happens before the usage call, at the pinned token endpoint.
    expect(fetcher.calls.length).toBe(3);
    const rotateCall = fetcher.calls[0];
    if (rotateCall === undefined) {
      throw new Error("expected a rotation call");
    }
    expect(rotateCall.method).toBe("POST");
    expect(rotateCall.url).toBe(TOKEN_URL);
    expect(new Headers(rotateCall.init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(String(rotateCall.init.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
    expect(params.get("refresh_token")).toBe(REFRESH);

    const usageCall = fetcher.calls[2];
    if (usageCall === undefined) {
      throw new Error("expected the usage call");
    }
    expect(usageCall.url).toBe(USAGE_URL);
    expect(new Headers(usageCall.init.headers).get("Authorization")).toBe("Bearer ag-access-rotated");

    const refreshed = response.refreshedCredential;
    expect(refreshed?.kind).toBe("oauth");
    if (refreshed?.kind === "oauth") {
      expect(refreshed.secret).toBe("ag-access-rotated");
      expect(refreshed.oauth.access).toBe("ag-access-rotated");
      expect(refreshed.oauth.refresh).toBe("ag-refresh-rotated");
      expect(refreshed.oauth.refreshEndpoint).toBe(TOKEN_URL);
      expect(refreshed.oauth.clientId).toBe(CLIENT_ID);
      expect(refreshed.oauth.identity).toEqual({ projectId: "proj-unit-1", email: "dev@example.com" });
      // OMP expiry skew: now + expires_in - 5 minutes.
      expect(refreshed.oauth.expiresAtMs).toBeGreaterThan(Date.now());
      expect(refreshed.oauth.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3_600_000 - 5 * 60 * 1000 + 5000);
    }
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
  });

  test("rotates once after a mid-flow 401 and retries successfully", async () => {
    const fetcher = queuedFetcher({ [`POST ${SUMMARY_URL}`]: [{ status: 404 }, { status: 404 }],
      [`POST ${USAGE_URL}`]: [
        { status: 401, body: { error: "invalid_token" } },
        { status: 200, body: USAGE_BODY },
      ],
      [`POST ${TOKEN_URL}`]: [
        { status: 200, body: { access_token: "ag-access-rotated", expires_in: 3600 } },
      ],
    });
    const response = await googleAntigravityConnector.fetchUsage({
      request: antigravityUsageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, USAGE_URL, TOKEN_URL, SUMMARY_URL, USAGE_URL]);
    expect(new Headers(fetcher.calls[4]?.init.headers).get("Authorization")).toBe("Bearer ag-access-rotated");
    // Response rotation kept the prior refresh token (OMP behavior).
    expect(response.refreshedCredential).toMatchObject({
      kind: "oauth",
      secret: "ag-access-rotated",
      oauth: { access: "ag-access-rotated", refresh: REFRESH },
    });
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
  });

  test("short-circuits an expired token without a refresh path (OMP null-report rule)", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({
        request: antigravityUsageRequest({
          credential: oauthCredential({ expiresAtMs: NOW_MS - 1000, dropRefresh: true }),
        }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("noData");
    expect(fetcher.calls.length).toBe(0);
  });

  test("keeps the pre-rotated credential on the error envelope when the usage call fails afterwards", async () => {
    const fetcher = queuedFetcher({ [`POST ${SUMMARY_URL}`]: [{ status: 404 }, { status: 404 }],
      [`POST ${TOKEN_URL}`]: [
        { status: 200, body: { access_token: "ag-access-rotated", refresh_token: "ag-refresh-rotated", expires_in: 3600 } },
      ],
      [`POST ${USAGE_URL}`]: [{ status: 429, headers: { "retry-after": "11" }, body: { error: "slow down" } }],
      [`POST ${SANDBOX_USAGE_URL}`]: [{ status: 429, headers: { "retry-after": "11" }, body: { error: "slow down" } }],
    });
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({
        request: antigravityUsageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 30_000 }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(11_000);
    // The daily endpoint's 429 falls back to sandbox; the second 429 is final.
    expect(fetcher.calls.map((call) => call.url)).toEqual([TOKEN_URL, SUMMARY_URL, USAGE_URL, SANDBOX_USAGE_URL]);
    // The rotated bundle rides the error so the caller persists it before
    // surfacing the failure — Google rotation burns the old refresh token.
    expect(error.refreshedCredential?.kind).toBe("oauth");
    if (error.refreshedCredential?.kind !== "oauth") {
      throw new Error("expected the rotated credential on the error envelope");
    }
    expect(error.refreshedCredential.oauth.access).toBe("ag-access-rotated");
    expect(error.refreshedCredential.oauth.refresh).toBe("ag-refresh-rotated");
    expect(error.refreshedCredential.oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(error.refreshedCredential.oauth.identity).toEqual({ projectId: "proj-unit-1", email: "dev@example.com" });
    expect(error.message).not.toContain("ag-access-rotated");
  });

  test("keeps the mid-flow-rotated credential on the error envelope when the retried usage call 401s again", async () => {
    const fetcher = queuedFetcher({ [`POST ${SUMMARY_URL}`]: [{ status: 404 }, { status: 404 }],
      [`POST ${USAGE_URL}`]: [
        { status: 401, body: { error: "invalid_token" } },
        { status: 401, body: { error: "invalid_token" } },
      ],
      [`POST ${TOKEN_URL}`]: [{ status: 200, body: { access_token: "ag-access-rotated", expires_in: 3600 } }],
    });
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(5);
    expect(error.refreshedCredential?.kind).toBe("oauth");
    if (error.refreshedCredential?.kind !== "oauth") {
      throw new Error("expected the rotated credential on the error envelope");
    }
    expect(error.refreshedCredential.oauth.access).toBe("ag-access-rotated");
  });
});

// ---------------------------------------------------------------------------
// Usage connector — typed error paths
// ---------------------------------------------------------------------------

describe("googleAntigravityConnector — typed error paths", () => {
  test("rejects a foreign providerId with invalidProvider", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({
        request: antigravityUsageRequest({ providerId: "anthropic" }),
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
      providerId: "google-antigravity",
      connectorId: "google-antigravity",
      accountRef: "00000000-0000-4000-8000-000000000002",
      requestedAtMs: 1787011200000,
      deadlineAtMs: 1787011210000,
    };
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("missingCredential");
  });

  test("maps a 401 to authRequired without the sandbox fallback", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 }, [`POST ${USAGE_URL}`]: { status: 401, body: { error: "unauthorized" } } });
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({
        // No refresh token: the 401 is final (no rotation retry, no sandbox).
        request: antigravityUsageRequest({ credential: oauthCredential({ dropRefresh: true }) }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(2);
    expect(error.message).not.toContain(ACCESS);
  });

  test("maps 429 with Retry-After on both endpoints to rateLimited with retryAfterMs", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 },
      [`POST ${USAGE_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { error: "rate limited" } },
      [`POST ${SANDBOX_USAGE_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { error: "rate limited" } },
    });
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30000);
    expect(fetcher.calls.length).toBe(3);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = async () => new Response("not-json{", { status: 200, headers: { "Content-Type": "application/json" } });
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps an empty models map to noData (no-usable-rows rule)", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 }, [`POST ${USAGE_URL}`]: { status: 200, body: { models: {} } } });
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("noData");
  });

  test("maps a non-OAuth credential and a missing project id to noData (OMP null-report rule)", async () => {
    const bearer = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({
        request: antigravityUsageRequest({ credential: { kind: "bearer", secret: "token" } }),
        fetcher: mockFetcher([]),
        nowMs: NOW_MS,
      }),
    );
    expect(bearer.kind).toBe("noData");

    const noProject = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({
        request: antigravityUsageRequest({ credential: oauthCredential({ dropIdentity: true }) }),
        fetcher: mockFetcher([]),
        nowMs: NOW_MS,
      }),
    );
    expect(noProject.kind).toBe("noData");
  });

  test("maps a network failure to transport", async () => {
    const fetcher = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("transport");
  });

  test("maps an aborted request to timeout", async () => {
    const fetcher = async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    };
    const error = await bridgeErrorFrom(() =>
      googleAntigravityConnector.fetchUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Auth module — browser method
// ---------------------------------------------------------------------------

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

const AUTH_CODE = "ag-auth-code-unit";
const LOGIN_ACCESS = "ag-access-login";
const LOGIN_REFRESH = "ag-refresh-login";
const TOKEN_BODY = { access_token: LOGIN_ACCESS, refresh_token: LOGIN_REFRESH, expires_in: 3600 };
const USER_EMAIL = "dev@example.com";

/** Pin the OMP Antigravity env-dependent constants for deterministic assertions. */
async function withPinnedAntigravityEnv<T>(fn: () => Promise<T>): Promise<T> {
  const names = ["PI_AI_ANTIGRAVITY_VERSION", "PI_AI_ANTIGRAVITY_CL", "PI_AI_ANTIGRAVITY_OS", "PI_AI_ANTIGRAVITY_ARCH"];
  const saved = names.map((name) => process.env[name]);
  for (const name of names) {
    delete process.env[name];
  }
  try {
    return await fn();
  } finally {
    names.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    });
  }
}

/**
 * Runs the browser flow end-to-end against mocked endpoints + a real loopback.
 * Upstream mock calls are gated until the callback response has drained (the
 * module stops the callback server in its finally, closing live sockets).
 */
async function runBrowserFlow(
  routes: Parameters<typeof mockFetcher>[0] | QueuedFetcher,
): Promise<{
  readonly result: Awaited<ReturnType<typeof loginAntigravity>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly openedUrls: string[];
  readonly authorizeUrl: URL;
  readonly redirectUri: string;
}> {
  const innerFetcher = typeof routes === "function" ? routes : mockFetcher(routes);
  const callbackDrained = Promise.withResolvers<void>();
  const fetcher = (url: string, init: RequestInit): Promise<Response> =>
    callbackDrained.promise.then(() => innerFetcher(url, init));
  const collector = eventCollector();
  const openedUrls: string[] = [];
  const controller = new AbortController();

  const loginPromise = withPinnedAntigravityEnv(() =>
    loginAntigravity("browser", {}, collector.events, controller.signal, {
      fetcher,
      openBrowser: (url) => {
        openedUrls.push(url);
      },
    }),
  );

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
  return { result, fetcher: innerFetcher, collector, openedUrls, authorizeUrl, redirectUri };
}

describe("googleAntigravityAuth — browser method (existing project)", () => {
  test("mints the OAuth credential through the exact OMP authorization-code flow", async () => {
    const { result, fetcher, collector, openedUrls, authorizeUrl, redirectUri } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: USER_EMAIL } },
      [`POST ${LOAD_DAILY_URL}`]: {
        status: 200,
        body: { cloudaicompanionProject: { id: "proj-existing-77" }, currentTier: { id: "tier-individual" }, paidTier: {} },
      },
    });

    // Authorize URL: accounts.google.com, embedded client id, response_type
    // code, the actual loopback redirect_uri, all five scopes, offline
    // access + consent, 32-hex state, and NO PKCE challenge.
    expect(authorizeUrl.origin).toBe("https://accounts.google.com");
    expect(authorizeUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
    expect(authorizeUrl.searchParams.get("scope")).toBe(SCOPES);
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(authorizeUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizeUrl.searchParams.has("code_challenge")).toBe(false);
    expect(openedUrls).toEqual([]);

    // Events: openUrl, the paste fallback hint, and progress events.
    expect(collector.received().some((event) => event.type === "pasteHint")).toBe(true);
    expect(collector.received().filter((event) => event.type === "waiting").length).toBeGreaterThanOrEqual(2);

    // Token exchange: OMP form body (client_id, client_secret, code,
    // grant_type=authorization_code, redirect_uri).
    const tokenCall = fetcher.calls[0];
    if (tokenCall === undefined) {
      throw new Error("expected a token exchange call");
    }
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).toBe(TOKEN_URL);
    expect(new Headers(tokenCall.init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(String(tokenCall.init.body))).toEqual(
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: AUTH_CODE,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    );

    // Userinfo lookup rides the OAuth access token.
    const userinfoCall = fetcher.calls[1];
    if (userinfoCall === undefined) {
      throw new Error("expected a userinfo call");
    }
    expect(userinfoCall.method).toBe("GET");
    expect(userinfoCall.url).toBe(USERINFO_URL);
    expect(new Headers(userinfoCall.init.headers).get("Authorization")).toBe(`Bearer ${LOGIN_ACCESS}`);

    // Project discovery: loadCodeAssist on the daily endpoint with the exact
    // OMP headers/body; the existing project ends the flow.
    const loadCall = fetcher.calls[2];
    if (loadCall === undefined) {
      throw new Error("expected a loadCodeAssist call");
    }
    expect(loadCall.method).toBe("POST");
    expect(loadCall.url).toBe(LOAD_DAILY_URL);
    const loadHeaders = new Headers(loadCall.init.headers);
    expect(loadHeaders.get("Authorization")).toBe(`Bearer ${LOGIN_ACCESS}`);
    expect(loadHeaders.get("Content-Type")).toBe("application/json");
    expect(loadHeaders.get("User-Agent")).toBe(ANTIGRAVITY_UA);
    expect(JSON.parse(String(loadCall.init.body))).toEqual({ metadata: { ideType: "ANTIGRAVITY" } });
    expect(fetcher.calls.length).toBe(4);

    // Credential: OAuth bundle with the project id stored in identity.
    expect(result.credential).toEqual({
      kind: "oauth",
      secret: LOGIN_ACCESS,
      oauth: {
        access: LOGIN_ACCESS,
        refresh: LOGIN_REFRESH,
        expiresAtMs: expect.any(Number),
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { projectId: "proj-existing-77", email: USER_EMAIL },
      },
    });
    if (result.credential.kind === "oauth") {
      // OMP expiry skew: now + expires_in - 5 minutes.
      expect(result.credential.oauth.expiresAtMs).toBeGreaterThan(Date.now());
      expect(result.credential.oauth.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3_600_000 - 5 * 60 * 1000 + 5000);
    }
    expect(result.accountLabel).toBe(USER_EMAIL);
  });

  test("ignores userinfo failures (email is optional)", async () => {
    const { result } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 403, body: { error: "forbidden" } },
      [`POST ${LOAD_DAILY_URL}`]: { status: 200, body: { cloudaicompanionProject: "proj-string-form", currentTier: {}, paidTier: {} } },
    });
    expect(result.credential.kind).toBe("oauth");
    if (result.credential.kind === "oauth") {
      expect(result.credential.oauth.identity).toEqual({ projectId: "proj-string-form" });
    }
    expect(result.accountLabel).toBeUndefined();
  });
});

describe("googleAntigravityAuth — browser method (provisioning)", () => {
  test("provisions a project through onboardUser with the exact OMP request", async () => {
    const { result, fetcher } = await runBrowserFlow(queuedFetcher({
      [`POST ${TOKEN_URL}`]: [{ status: 200, body: TOKEN_BODY }],
      [`GET ${USERINFO_URL}`]: [{ status: 200, body: { email: USER_EMAIL } }],
      [`POST ${LOAD_DAILY_URL}`]: [
        { status: 200, body: { allowedTiers: [{ id: "free-tier" }] } },
        { status: 200, body: { currentTier: {}, paidTier: {}, cloudaicompanionProject: "proj-provisioned-9" } },
      ],
      [`POST ${ONBOARD_URL}`]: [{ status: 200, body: { done: true, response: { "@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse" } } }],
    }));

    expect(fetcher.calls[2]?.url).toBe(LOAD_DAILY_URL);
    expect(fetcher.calls[4]?.url).toBe(LOAD_DAILY_URL);
    const onboardCall = fetcher.calls[3];
    if (onboardCall === undefined) throw new Error("expected an onboardUser call");
    expect(onboardCall.method).toBe("POST");
    expect(onboardCall.url).toBe(ONBOARD_URL);
    const headers = new Headers(onboardCall.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${LOGIN_ACCESS}`);
    expect(headers.get("User-Agent")).toBe(ANTIGRAVITY_UA);
    expect(JSON.parse(String(onboardCall.init.body))).toEqual({ tierId: "free-tier", metadata: { ideType: "ANTIGRAVITY" } });
    expect(fetcher.calls.length).toBe(5);

    expect(result.credential).toMatchObject({
      kind: "oauth",
      oauth: { identity: { projectId: "proj-provisioned-9", email: USER_EMAIL } },
    });
  });

  test("surfaces a failed loadCodeAssist on every endpoint as the mapped error", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
        [`GET ${USERINFO_URL}`]: { status: 200, body: { email: USER_EMAIL } },
        [`POST ${LOAD_DAILY_URL}`]: { status: 403, body: { error: "denied" } },
        [`POST ${LOAD_CLOUDCODE_URL}`]: { status: 403, body: { error: "denied" } },
      }),
    );
    expect(error.kind).toBe("permissionDenied");
  });

  test("rejects a token response without a refresh token (OMP message)", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: LOGIN_ACCESS, expires_in: 3600 } },
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(error.message).toBe("No refresh token received. Please try again.");
  });

  test("maps an aborted login signal to a timeout BridgeError with a cancelled message", async () => {
    const fetcher = mockFetcher([]);
    const collector = eventCollector();
    const controller = new AbortController();
    const loginPromise = withPinnedAntigravityEnv(() =>
      loginAntigravity("browser", {}, collector.events, controller.signal, {
        fetcher,
        openBrowser: () => undefined,
      }),
    );
    await collector.waitFor("openUrl");
    controller.abort(new Error("user closed the browser"));

    const error = await bridgeErrorFrom(() => loginPromise);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancel");
    expect(fetcher.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auth module — refresh + surface
// ---------------------------------------------------------------------------

describe("googleAntigravityAuth — refresh", () => {
  test("refreshes with the pinned token endpoint and client credentials when the credential omits them", async () => {
    const credential: BridgeCredential = {
      kind: "oauth",
      secret: ACCESS,
      oauth: { access: ACCESS, refresh: REFRESH, identity: { projectId: "proj-unit-1" } },
    };
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: "ag-access-refreshed", expires_in: 3600 },
      },
    });
    const rotated = await refreshAntigravityCredential(credential, fetcher, new AbortController().signal);

    const call = fetcher.calls[0];
    if (call === undefined) {
      throw new Error("expected a refresh call");
    }
    const params = new URLSearchParams(String(call.init.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
    expect(params.get("refresh_token")).toBe(REFRESH);

    expect(rotated.kind).toBe("oauth");
    expect(rotated.secret).toBe("ag-access-refreshed");
    if (rotated.kind === "oauth") {
      // OMP keeps the prior refresh token when the response omits one.
      expect(rotated.oauth.refresh).toBe(REFRESH);
      expect(rotated.oauth.identity).toEqual({ projectId: "proj-unit-1" });
    }
  });

  test("rejects a non-OAuth credential with authRequired", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      refreshAntigravityCredential({ kind: "bearer", secret: "x" }, fetcher, new AbortController().signal),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(0);
  });
});

describe("googleAntigravityAuth — module surface", () => {
  test("offers the browser method and rejects unknown methods", async () => {
    expect(googleAntigravityAuth.providerId).toBe("google-antigravity");
    expect(googleAntigravityAuth.methods).toEqual(["browser"]);
    expect(googleAntigravityConnector.providerId).toBe("google-antigravity");
    expect(googleAntigravityConnector.connectorVersion).toBe("google-antigravity-1");
    expect(typeof googleAntigravityAuth.refresh).toBe("function");

    const error = await bridgeErrorFrom(() =>
      googleAntigravityAuth.login("device", {}, eventCollector().events, AbortSignal.timeout(50)),
    );
    expect(error.kind).toBe("invalidRequest");
  });

  test("exports a working fetchUsage bound to the connector", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 404 }, [`POST ${USAGE_URL}`]: { status: 200, body: USAGE_BODY } });
    const response = await fetchAntigravityUsage({
      request: antigravityUsageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
  });
});

describe("googleAntigravityAuth — manual paste fallback (OMP onManualCodeInput race)", () => {
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

  test("resolves the login through a pasted redirect URL on the duplex channel", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: USER_EMAIL } },
      [`POST ${LOAD_DAILY_URL}`]: {
        status: 200,
        body: { cloudaicompanionProject: { id: "proj-existing-77" }, currentTier: { id: "tier-individual" }, paidTier: {} },
      },
    });
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = withPinnedAntigravityEnv(() =>
      loginAntigravity("browser", {}, pastes.events, controller.signal, {
        fetcher,
        openBrowser: () => undefined,
      }),
    );
    await Promise.all([collector.waitFor("openUrl"), firstPrompt]);
    const { redirectUri, state } = redirectFrom(collector);

    pastes.respond(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
    const result = await loginPromise;
    expect(pastes.pendingResponses()).toBe(0);
    await expectLoopbackClosed(redirectUri);

    expect(pastes.prompts()).toEqual([{ inputKind: "redirectUrl", sensitive: true }]);
    const exchangeBody = new URLSearchParams(String(fetcher.calls[0]?.init.body));
    expect(exchangeBody.get("code")).toBe(AUTH_CODE);
    expect(exchangeBody.get("redirect_uri")).toBe(redirectUri);
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.identity).toEqual({ projectId: "proj-existing-77", email: USER_EMAIL });
  });

  test("re-prompts when the paste carries a mismatched state, then accepts", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: USER_EMAIL } },
      [`POST ${LOAD_DAILY_URL}`]: {
        status: 200,
        body: { cloudaicompanionProject: { id: "proj-existing-77" }, currentTier: { id: "tier-individual" }, paidTier: {} },
      },
    });
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = withPinnedAntigravityEnv(() =>
      loginAntigravity("browser", {}, pastes.events, controller.signal, {
        fetcher,
        openBrowser: () => undefined,
      }),
    );
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
      const exchangeBody = new URLSearchParams(String(fetcher.calls[0]?.init.body));
      expect(exchangeBody.get("code")).toBe(AUTH_CODE);
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
    const loginPromise = withPinnedAntigravityEnv(() =>
      loginAntigravity("browser", {}, pastes.events, controller.signal, {
        fetcher: mockFetcher([]),
        openBrowser: () => undefined,
      }),
    );
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

describe("Antigravity current summary contract", () => {
  test("prefers grouped summary and keeps shared third-party buckets once", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 200, body: summaryFixture } });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL]);
    expect(JSON.parse(String(fetcher.calls[0]?.init.body))).toEqual({ project: "proj-unit-1" });
    expect(new Headers(fetcher.calls[0]?.init.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(response.report.windows).toHaveLength(4);
    expect(response.report.windows.map(w => w.resolvedFraction)).toEqual([0.95, 0.875, 0.8, 0]);
    expect(response.report.windows.map(w => w.severity)).toEqual(["critical", "warning", "warning", "ok"]);
    expect(response.report.windows.filter(w => w.id.includes("3p-"))).toHaveLength(2);
    expect(new Set(response.report.windows.map(w => w.id)).size).toBe(4);
    expectNoModelFields(response);
  });

  test("preserves remaining-only amounts including zero without percentage or denominator", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 200, body: remainingFixture } });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows.map(w => w.remaining)).toEqual([42.5, 0]);
    for (const window of response.report.windows) {
      expect(window.unit).toBe("unknown");
      expect(window.severity).toBe("unknown");
      expect(window.used).toBeUndefined();
      expect(window.limit).toBeUndefined();
      expect(window.resolvedFraction).toBeUndefined();
    }
  });

  for (const body of [{}, { buckets: [] }, { groups: [{ buckets: [] }] }]) {
    test(`empty summary falls back: ${JSON.stringify(body)}`, async () => {
      const fetcher = mockFetcher({
        [`POST ${SUMMARY_URL}`]: { status: 200, body },
        [`POST ${USAGE_URL}`]: { status: 200, body: USAGE_BODY },
      });
      const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
      expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, USAGE_URL]);
      expect(response.report.windows).toHaveLength(5);
    });
  }
  test("unavailable summary falls back to legacy without inventing unmetered sibling quota", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 404 },
      [`POST ${USAGE_URL}`]: { status: 200, body: { models: {
        autocomplete: { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1 } },
        metered: { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { resetTime: WEEKLY_RESET_ISO } },
        independent: { modelProvider: "MODEL_PROVIDER_ANTHROPIC", quotaInfo: { remainingFraction: 0.125 } },
      } } },
    });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, USAGE_URL]);
    expect(response.report.windows.map(w => w.resolvedFraction)).toEqual([1, 0.875]);
    expect(response.report.windows.map(w => w.severity)).toEqual(["exhausted", "warning"]);
  });
  test("transient summary probes sandbox before legacy", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 503 },
      [`POST ${SUMMARY_SANDBOX_URL}`]: { status: 503 },
      [`POST ${USAGE_URL}`]: { status: 200, body: USAGE_BODY },
    });
    await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, SUMMARY_SANDBOX_URL, USAGE_URL]);
  });
  test("summary sandbox success never reaches legacy", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 503 },
      [`POST ${SUMMARY_SANDBOX_URL}`]: { status: 200, body: remainingFixture },
    });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows[0]?.remaining).toBe(42.5);
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, SUMMARY_SANDBOX_URL]);
  });
  for (const [status, kind] of [[401, "authRequired"], [403, "permissionDenied"]] as const) {
    test(`summary ${status} is terminal without fallback`, async () => {
      const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status } });
      const error = await bridgeErrorFrom(() => fetchAntigravityUsage({
        request: antigravityUsageRequest({ credential: oauthCredential({ dropRefresh: true }) }), fetcher, nowMs: NOW_MS,
      }));
      expect(error.kind).toBe(kind);
      expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL]);
    });
  }
  test("disabled summary is authoritative noData, not fallback", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: {
      status: 200, body: { buckets: [{ bucketId: "disabled", disabled: true, remainingFraction: 0 }] },
    } });
    const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL]);
  });
  for (const body of [null, [], { buckets: "bad" }, { groups: [null] }, { buckets: [null] },
    { buckets: [{ remainingFraction: "0.2" }] }, { buckets: [{ remainingAmount: -1 }] },
    { buckets: [{ remainingAmount: "" }] }, { buckets: [{ remainingAmount: "NaN" }] },
    { buckets: [{ disabled: "true" }] }]) {
    test(`malformed summary is typed and never silently replaced: ${JSON.stringify(body)}`, async () => {
      const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 200, body } });
      const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }));
      expect(error.kind).toBe("malformedPayload");
      expect(fetcher.calls).toHaveLength(1);
    });
  }
  test("empty quota records and invalid reset strings do not fabricate legacy exhaustion", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 200, body: {} },
      [`POST ${USAGE_URL}`]: { status: 200, body: { models: { a: { quotaInfos: [{}, { resetTime: "bad" }] } } } },
    });
    const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
  });
});

// Scripted control-plane requests are exact gates, not timers. Browser callback is
// satisfied through the real correlated manual-input path; finally reaps listener.
async function currentControlPlane(
  script: readonly { readonly url: string; readonly method?: string; readonly body: unknown; readonly status?: number;
    readonly elapsedMs?: number; readonly interruptBody?: "timeout" | "cancel" }[],
  options: { readonly cancelAtSleep?: boolean; readonly advanceBy?: number } = {},
): Promise<{ readonly result?: Awaited<ReturnType<typeof loginAntigravity>>; readonly error?: BridgeError;
  readonly calls: RecordedCall[]; readonly waits: number[]; readonly timeouts: number[] }> {
  const calls: RecordedCall[] = [];
  const waits: number[] = [];
  const timeouts: number[] = [];
  const timeoutControllers: AbortController[] = [];
  let clock = NOW_MS;
  let redirect = "";
  let state = "";
  const controller = new AbortController();
  const queue = [...script];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    if (url === TOKEN_URL) return Response.json(TOKEN_BODY);
    if (url === USERINFO_URL) return Response.json({ email: USER_EMAIL });
    calls.push({ method: init.method ?? "GET", url, init });
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected control-plane request");
    expect(url).toBe(next.url);
    expect(init.method).toBe(next.method ?? "POST");
    clock += next.elapsedMs ?? 0;
    if (next.interruptBody !== undefined) {
      const signal = init.signal;
      if (!signal) throw new Error("request missing cancellation signal");
      const timeoutController = timeoutControllers.at(-1);
      if (!timeoutController) throw new Error("request missing deadline signal");
      const stream = new ReadableStream<Uint8Array>({ start(streamController) {
        signal.addEventListener("abort", () => streamController.error(signal.reason), { once: true });
        if (next.interruptBody === "cancel") controller.abort(new DOMException("cancelled", "AbortError"));
        else timeoutController.abort(new DOMException("deadline", "TimeoutError"));
      } });
      return new Response(stream);
    }
    return Response.json(next.body, { status: next.status ?? 200 });
  };
  try {
    const result = await loginAntigravity("browser", {}, {
      onEvent(event) {
        if (event.type === "openUrl") {
          const url = new URL(event.url);
          redirect = url.searchParams.get("redirect_uri") ?? "";
          state = url.searchParams.get("state") ?? "";
        }
      },
      requestInput: async () => `${redirect}?code=${AUTH_CODE}&state=${state}`,
    }, controller.signal, {
      fetcher, now: () => clock,
      timeoutSignal: (ms) => {
        timeouts.push(ms);
        const deadline = new AbortController();
        timeoutControllers.push(deadline);
        return deadline.signal;
      },
      sleep: async (ms) => {
        waits.push(ms);
        clock += options.advanceBy ?? ms;
        if (options.cancelAtSleep) controller.abort();
      },
    });
    return { result, calls, waits, timeouts };
  } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    return { error, calls, waits, timeouts };
  } finally {
    controller.abort();
    if (redirect) await expectLoopbackClosed(redirect);
  }
}

const CURRENT_PROJECT = { currentTier: { id: "free-tier" }, paidTier: { id: "paid" }, cloudaicompanionProject: "refreshed-project" };
const PENDING_OPERATION = { name: "operations/onboard-unit", done: false };
const DONE_OPERATION = { name: "operations/onboard-unit", done: true,
  response: { "@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse", cloudaicompanionProject: "stale-operation-project" } };

describe("Antigravity current control plane", () => {
  test("hydrates project without paidTier then returns refreshed discovery", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: { currentTier: {}, cloudaicompanionProject: "initial-project" } },
      { url: LOAD_DAILY_URL, body: { ...CURRENT_PROJECT, cloudaicompanionProject: "hydrated-project" } },
      { url: LOAD_DAILY_URL, body: CURRENT_PROJECT },
    ]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.credential).toMatchObject({ oauth: { identity: { projectId: "refreshed-project" } } });
    expect(outcome.calls).toHaveLength(3);
    expect(JSON.parse(String(outcome.calls[1]?.init.body))).toEqual({ cloudaicompanionProject: "initial-project", metadata: { ideType: "ANTIGRAVITY" } });
  });
  test("posts native free-tier onboarding once then polls GET and refreshes project", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: { allowedTiers: [{ id: "free-tier" }] } },
      { url: ONBOARD_URL, body: PENDING_OPERATION },
      { url: OPERATION_URL, method: "GET", body: DONE_OPERATION },
      { url: LOAD_DAILY_URL, body: CURRENT_PROJECT },
    ]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.calls.map(c => c.method)).toEqual(["POST", "POST", "GET", "POST"]);
    expect(JSON.parse(String(outcome.calls[1]?.init.body))).toEqual({ tierId: "free-tier", metadata: { ideType: "ANTIGRAVITY" } });
    expect(outcome.calls[2]?.init.body).toBeUndefined();
    expect(outcome.waits).toEqual([1000]);
    expect(outcome.result?.credential).toMatchObject({ oauth: { identity: { projectId: "refreshed-project" } } });
  });
  test("failed named operation returns typed error without repeated POST or project refresh", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: {} }, { url: ONBOARD_URL, body: PENDING_OPERATION },
      { url: OPERATION_URL, method: "GET", body: { done: true, error: { code: 7, message: LOGIN_ACCESS } } },
    ]);
    expect(outcome.error?.kind).toBe("upstreamError");
    expect(outcome.error?.message).not.toContain(LOGIN_ACCESS);
    expect(outcome.calls).toHaveLength(3);
  });
  test("onboarding has one 30s deadline, not an attempt count", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: {} }, { url: ONBOARD_URL, body: PENDING_OPERATION },
    ], { advanceBy: 30_000 });
    expect(outcome.error?.kind).toBe("timeout");
    expect(outcome.calls.map(c => c.url)).toEqual([LOAD_DAILY_URL, ONBOARD_URL]);
  });
  test("user abort after exact pending-operation gate prevents GET", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: {} }, { url: ONBOARD_URL, body: PENDING_OPERATION },
    ], { cancelAtSleep: true });
    expect(outcome.error?.kind).toBe("timeout");
    expect(outcome.calls.map(c => c.url)).toEqual([LOAD_DAILY_URL, ONBOARD_URL]);
  });
  test("free-tier ineligibility prevents onboarding even with an old project", async () => {
    const outcome = await currentControlPlane([{ url: LOAD_DAILY_URL, body: {
      ...CURRENT_PROJECT, allowedTiers: [], ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "denied" }],
    } }]);
    expect(outcome.error?.kind).toBe("permissionDenied");
    expect(outcome.calls).toHaveLength(1);
  });
  for (const body of [null, { currentTier: "bad" }, { allowedTiers: [null] }]) {
    test(`malformed load response is typed: ${JSON.stringify(body)}`, async () => {
      const outcome = await currentControlPlane([{ url: LOAD_DAILY_URL, body }]);
      expect(outcome.error?.kind).toBe("malformedPayload");
      expect(outcome.calls).toHaveLength(1);
    });
  }
  for (const body of [{ done: true }, { done: true, response: {} }, { done: "yes" }, { done: false }]) {
    test(`malformed operation is typed: ${JSON.stringify(body)}`, async () => {
      const outcome = await currentControlPlane([{ url: LOAD_DAILY_URL, body: {} }, { url: ONBOARD_URL, body }]);
      expect(outcome.error?.kind).toBe("malformedPayload");
      expect(outcome.calls).toHaveLength(2);
    });
  }
  test("native control plane rejects non-200 success statuses", async () => {
    const outcome = await currentControlPlane([{ url: LOAD_DAILY_URL, status: 201, body: CURRENT_PROJECT }]);
    expect(outcome.error?.kind).toBe("upstreamError");
    expect(outcome.calls).toHaveLength(1);
  });

  test("POST and repeated GET response time consume one onboarding budget", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: {} },
      { url: ONBOARD_URL, body: PENDING_OPERATION, elapsedMs: 5000 },
      { url: OPERATION_URL, method: "GET", body: PENDING_OPERATION, elapsedMs: 3000 },
      { url: OPERATION_URL, method: "GET", body: DONE_OPERATION },
      { url: LOAD_DAILY_URL, body: CURRENT_PROJECT },
    ]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.timeouts).toEqual([30000, 30000, 24000, 20000, 30000]);
    expect(outcome.waits).toEqual([1000, 1000]);
  });
  for (const interruptBody of ["timeout", "cancel"] as const) {
    for (const path of [ONBOARD_URL, OPERATION_URL]) {
      test(`${interruptBody} during ${path} response body stays typed and closes callback`, async () => {
        const outcome = await currentControlPlane([
          { url: LOAD_DAILY_URL, body: {} },
          { url: ONBOARD_URL, body: PENDING_OPERATION, ...(path === ONBOARD_URL ? { interruptBody } : {}) },
          ...(path === OPERATION_URL ? [{ url: OPERATION_URL, method: "GET", body: {}, interruptBody }] : []),
        ]);
        expect(outcome.error?.kind).toBe("timeout");
        expect(outcome.calls.at(-1)?.url).toBe(path);
        expect(outcome.result).toBeUndefined();
      });
    }
  }
  test("a late completed operation cannot bypass the 30s deadline", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: {} },
      { url: ONBOARD_URL, body: DONE_OPERATION, elapsedMs: 30000 },
    ]);
    expect(outcome.error?.kind).toBe("timeout");
    expect(outcome.calls).toHaveLength(2);
  });
  test("explicit free-tier allowance wins over ineligible-tier history", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: { ...CURRENT_PROJECT, allowedTiers: [{ id: "free-tier" }],
        ineligibleTiers: [{ tierId: "free-tier", reasonMessage: "previous denial" }] } },
      { url: LOAD_DAILY_URL, body: CURRENT_PROJECT },
    ]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.calls).toHaveLength(2);
  });
  test("completed operation still requires a project from refreshed discovery", async () => {
    const outcome = await currentControlPlane([
      { url: LOAD_DAILY_URL, body: {} }, { url: ONBOARD_URL, body: DONE_OPERATION },
      { url: LOAD_DAILY_URL, body: { currentTier: {}, paidTier: {} } },
    ]);
    expect(outcome.error?.kind).toBe("upstreamError");
    expect(outcome.result).toBeUndefined();
  });
});

describe("Antigravity revision boundaries", () => {
  for (const [scenario, ids, fractions, resets] of [
    ["legacy-independent", ["weekly", "daily"], [0.99, 0.1], [undefined, 1787029200000]],
    ["weeklyreset", ["weekly", "daily"], [0.99, 0.1], [WEEKLY_RESET_MS, 1787029200000]],
    ["truebarephantom", ["weekly"], [0.99], [WEEKLY_RESET_MS]],
    ["consumed-no-reset", ["daily", "weekly"], [0.99, 0.1], [undefined, WEEKLY_RESET_MS]],
  ] as const) {
    test(`preserves independent legacy evidence: ${scenario}`, async () => {
      const fixture = boundaryFixtures[scenario];
      const fetcher = mockFetcher({
        [`POST ${SUMMARY_URL}`]: { status: 200, body: fixture.summary },
        [`POST ${USAGE_URL}`]: { status: 200, body: fixture.legacy },
      });
      const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
      expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, USAGE_URL]);
      expect(response.report.windows.map(w => w.id)).toEqual(ids.map(id => `google-antigravity:google:default:${id}`));
      expect(response.report.windows.map(w => w.resetsAtMs)).toEqual([...resets]);
      for (const [index, window] of response.report.windows.entries()) {
        const fraction = fractions[index];
        if (fraction === undefined) throw new Error("unexpected quota row");
        expect(window.resolvedFraction).toBeCloseTo(fraction, 12);
        expect(window.used).toBeCloseTo(fraction * 100, 12);
        expect(window.limit).toBe(100);
        expect(window.unit).toBe("percent");
        expect(window.severity).toBe(fraction === 0.99 ? "critical" : "ok");
      }
    });
  }

  for (const explicit of [{ windowId: "daily" }, { windowLabel: "Daily" }]) {
    for (const reverse of [false, true]) {
      test(`preserves explicit full-remaining window through bare duplicate merge: ${JSON.stringify(explicit)} reverse=${reverse}`, async () => {
        const entries = [{ remainingFraction: 1 }, { ...explicit, remainingFraction: 1 }];
        const fetcher = mockFetcher({
          [`POST ${SUMMARY_URL}`]: { status: 200, body: {} },
          [`POST ${USAGE_URL}`]: { status: 200, body: { models: { google: {
            modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfos: [
              ...(reverse ? entries.toReversed() : entries),
              { windowId: "weekly", remainingFraction: 0.01, resetTime: WEEKLY_RESET_ISO },
            ],
          } } } },
        });
        const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
        expect(response.report.windows.map(w => w.id)).toEqual([
          "google-antigravity:google:default:weekly", "google-antigravity:google:default:daily",
        ]);
        expect(response.report.windows.map(w => w.resolvedFraction)).toEqual([0.99, 0]);
        expect(response.report.windows.map(w => w.severity)).toEqual(["critical", "ok"]);
        expect(response.report.windows[1]?.resetsAtMs).toBeUndefined();
      });
    }
  }

  test("preserves a full-remaining window identified by its legacy container", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 200, body: {} },
      [`POST ${USAGE_URL}`]: { status: 200, body: { models: { google: {
        modelProvider: "MODEL_PROVIDER_GOOGLE", dailyQuotaInfo: { remainingFraction: 1 },
        weeklyQuotaInfo: { remainingFraction: 0.01, resetTime: WEEKLY_RESET_ISO },
      } } } },
    });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows.map(w => w.id)).toEqual([
      "google-antigravity:google:default:weekly", "google-antigravity:google:default:daily",
    ]);
    expect(response.report.windows.map(w => w.resolvedFraction)).toEqual([0.99, 0]);
  });

  test("preserves bare full remaining when no metered sibling evidences a phantom", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 200, body: {} },
      [`POST ${USAGE_URL}`]: { status: 200, body: { models: { google: {
        modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 1 },
      } } } },
    });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows).toHaveLength(1);
    expect(response.report.windows[0]).toMatchObject({
      id: "google-antigravity:google:default:daily", resolvedFraction: 0, severity: "ok", used: 0, limit: 100,
    });
  });

  test("populated amountless summary returns noData without legacy fallback", async () => {
    const fixture = boundaryFixtures["empty-bucket"];
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 200, body: fixture.summary },
      [`POST ${USAGE_URL}`]: { status: 200, body: fixture.legacy },
    });
    const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL]);
  });

  test("valid sibling survives populated amountless summary without legacy fallback", async () => {
    const fixture = boundaryFixtures["empty-sibling"];
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 200, body: fixture.summary },
      [`POST ${USAGE_URL}`]: { status: 200, body: fixture.legacy },
    });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL]);
    expect(response.report.windows).toEqual([{
      id: "google-antigravity:summary:0:usable:0", label: "Usage", unit: "percent", severity: "ok",
      remaining: 50, remainingFraction: 0.5, used: 50, limit: 100, resolvedFraction: 0.5,
    }]);
  });
});

describe("Antigravity summary adversarial controls", () => {
  test("summary 401 rotates once and retries the summary rather than the catalog", async () => {
    const fetcher = queuedFetcher({
      [`POST ${SUMMARY_URL}`]: [{ status: 401 }, { status: 200, body: remainingFixture }],
      [`POST ${TOKEN_URL}`]: [{ status: 200, body: { access_token: "ag-rotated", expires_in: 3600 } }],
    });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, TOKEN_URL, SUMMARY_URL]);
    expect(new Headers(fetcher.calls[2]?.init.headers).get("Authorization")).toBe("Bearer ag-rotated");
    expect(response.refreshedCredential).toMatchObject({ oauth: { access: "ag-rotated", refresh: REFRESH } });
    expect(response.report.windows[0]?.remaining).toBe(42.5);
  });
  test("malformed summary after pre-rotation carries the rotated credential", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: "ag-rotated", refresh_token: "ag-refresh-new", expires_in: 3600 } },
      [`POST ${SUMMARY_URL}`]: { status: 200, body: { buckets: [null] } },
    });
    const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest({
      credential: oauthCredential({ expiresAtMs: NOW_MS + 1000 }),
    }), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("malformedPayload");
    expect(error.refreshedCredential).toMatchObject({ oauth: { access: "ag-rotated", refresh: "ag-refresh-new" } });
  });
  test("summary throttling remains typed with Retry-After and does not call legacy", async () => {
    const fetcher = mockFetcher({
      [`POST ${SUMMARY_URL}`]: { status: 429, headers: { "retry-after": "7" } },
      [`POST ${SUMMARY_SANDBOX_URL}`]: { status: 429, headers: { "retry-after": "11" } },
    });
    const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(11000);
    expect(fetcher.calls.map(c => c.url)).toEqual([SUMMARY_URL, SUMMARY_SANDBOX_URL]);
  });
  test("fraction takes precedence over unrelated raw remaining amount", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 200,
      body: { buckets: [{ bucketId: "fraction", remainingFraction: 0.125, remainingAmount: "999" }] },
    } });
    const response = await fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows[0]).toMatchObject({ remaining: 12.5, remainingFraction: 0.125,
      used: 87.5, limit: 100, resolvedFraction: 0.875, severity: "warning", unit: "percent" });
  });
  test("both empty sources produce noData without phantom rows", async () => {
    const fetcher = mockFetcher({ [`POST ${SUMMARY_URL}`]: { status: 200, body: {} },
      [`POST ${USAGE_URL}`]: { status: 200, body: { models: {} } } });
    const error = await bridgeErrorFrom(() => fetchAntigravityUsage({ request: antigravityUsageRequest(), fetcher, nowMs: NOW_MS }));
    expect(error.kind).toBe("noData");
    expect(fetcher.calls).toHaveLength(2);
  });
});
