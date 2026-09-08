import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  fetchGoogleGeminiCliUsage,
  googleGeminiCliAuth,
  googleGeminiCliConnector,
  loginGoogleGeminiCli,
} from "../src/providers/google-gemini-cli";
import { BridgeError } from "../src/protocol";
import type { BridgeCredential, BridgeRequest, UsageWindow } from "../src/protocol";
import type { AuthEvent, AuthEvents } from "../src/dispatch";
import { buildLoginRequest, buildUsageRequest, expectLoopbackClosed, expectNoModelFields, mockFetcher, waitForCount } from "./helpers";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW_MS = 1787011200500;
const ACCESS = "ya29.unit-access-token";
const REFRESH = "1//unit-refresh-token";
const ROTATED_ACCESS = "ya29.rotated-access-token";
const ROTATED_REFRESH = "1//rotated-refresh-token";
const PROJECT = "unit-project-123";

const AUTH_CODE = "unit-auth-code";
const OAUTH_ACCESS = "ya29.login-access-token";
const EMAIL = "dev@example.com";
const LOGIN_PROJECT = "login-project-77";

// Base64 verbatim from OMP packages/ai/src/registry/oauth/google-gemini-cli.ts @ 8500092,
// matching the bridge src representation (bridge/src/providers/google-gemini-cli.ts).
const CLIENT_ID = atob(
  "NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQu" +
    "Y29t",
);
const CLIENT_SECRET = atob("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const RETRIEVE_USER_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const ONBOARD_USER_URL = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";

const EXPECTED_USER_AGENT = `GeminiCLI/0.46.0/gemini-3.1-pro-preview (${process.platform}; ${process.arch}; terminal)`;
const EXPECTED_CLIENT_METADATA = "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI";
const EXPECTED_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
};

// Realistic OMP-shaped payload (packages/ai/src/usage/gemini.ts shapes):
// mapped-tier models, substring-tier models, an unparseable resetTime, an
// exhausted bucket, a bucket without remainingFraction and a model-less one.
const QUOTA_BODY = {
  buckets: [
    { modelId: "gemini-2.5-flash", remainingFraction: 0.85, resetTime: "2026-08-19T12:00:00Z" },
    { modelId: "gemini-1.5-flash-002", remainingFraction: 0.5, resetTime: "2026-08-19T21:00:00Z" },
    { modelId: "gemini-2.5-pro", remainingFraction: 0.03, resetTime: "2026-08-19T21:00:00Z" },
    { modelId: "gemini-3-flash-preview", remainingFraction: 0.9, resetTime: "not-a-timestamp" },
    { modelId: "gemini-2.0-flash", remainingFraction: 0, resetTime: "2026-08-20T00:00:00Z" },
    { modelId: "gemini-2.0-flash-lite", resetTime: "2026-08-20T00:00:00Z" },
    { remainingFraction: 0.7 },
  ],
};

const LOAD_BODY = {
  cloudaicompanionProject: PROJECT,
  currentTier: { id: "standard-tier", name: "Standard" },
};

const EXPECTED_WINDOWS: readonly UsageWindow[] = [
  {
    id: "gemini-2.5-flash:reset-1787140800000",
    label: "Gemini Flash",
    unit: "percent",
    resolvedFraction: 0.15,
    severity: "ok",
    used: 15,
    limit: 100,
    resetsAtMs: 1787140800000,
  },
  {
    id: "gemini-1.5-flash-002:reset-1787173200000",
    label: "Gemini Flash",
    unit: "percent",
    resolvedFraction: 0.5,
    severity: "ok",
    used: 50,
    limit: 100,
    resetsAtMs: 1787173200000,
  },
  {
    id: "gemini-2.5-pro:reset-1787173200000",
    label: "Gemini Pro",
    unit: "percent",
    resolvedFraction: 0.97,
    severity: "critical",
    used: 97,
    limit: 100,
    resetsAtMs: 1787173200000,
  },
  {
    id: "gemini-3-flash-preview:quota",
    label: "Gemini 3-Flash",
    unit: "percent",
    resolvedFraction: 0.1,
    severity: "ok",
    used: 10,
    limit: 100,
  },
  {
    id: "gemini-2.0-flash:reset-1787184000000",
    label: "Gemini Flash",
    unit: "percent",
    resolvedFraction: 1,
    severity: "exhausted",
    used: 100,
    limit: 100,
    resetsAtMs: 1787184000000,
  },
  {
    id: "unknown:quota",
    label: "Gemini quota",
    unit: "percent",
    resolvedFraction: 0.3,
    severity: "ok",
    used: 30,
    limit: 100,
  },
];

// Keep the discovery/UA environment hermetic regardless of the host shell.
const SAVED_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID", "PI_AI_GEMINI_CLI_VERSION"]) {
    SAVED_ENV[key] = process.env[key];
    delete process.env[key];
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function oauthCredential(
  options: {
    readonly access?: string | undefined;
    readonly omitRefresh?: boolean;
    readonly omitRefreshEndpoint?: boolean;
    readonly omitExpiresAtMs?: boolean;
    readonly expiresAtMs?: number | undefined;
    readonly identity?: Readonly<Record<string, string>> | undefined;
  } = {},
): BridgeCredential {
  const access = options.access ?? ACCESS;
  return {
    kind: "oauth",
    secret: access,
    oauth: {
      access,
      ...(options.omitRefresh ? {} : { refresh: REFRESH }),
      ...(options.omitExpiresAtMs ? {} : { expiresAtMs: options.expiresAtMs ?? NOW_MS + 3_600_000 }),
      ...(options.omitRefreshEndpoint ? {} : { refreshEndpoint: TOKEN_URL }),
      clientId: CLIENT_ID,
      identity: options.identity ?? { projectId: PROJECT },
    },
  };
}

function geminiUsageRequest(credential: BridgeCredential = oauthCredential()): BridgeRequest {
  return buildUsageRequest({ providerId: "google-gemini-cli", connectorId: "google-gemini-cli", credential });
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

function expectGeminiHeaders(init: RequestInit | undefined, bearer: string): void {
  if (init === undefined) {
    throw new Error("expected a recorded request init");
  }
  const headers = new Headers(init.headers);
  expect(headers.get("Authorization")).toBe(`Bearer ${bearer}`);
  expect(headers.get("User-Agent")).toBe(EXPECTED_USER_AGENT);
  expect(headers.get("Client-Metadata")).toBe(EXPECTED_CLIENT_METADATA);
}

// ---------------------------------------------------------------------------
// Usage connector
// ---------------------------------------------------------------------------

describe("googleGeminiCliConnector — happy path", () => {
  test("maps the OMP quota payload to normalized windows over the exact upstream calls", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const request = geminiUsageRequest();
    const response = await googleGeminiCliConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.length).toBe(2);
    const loadCall = fetcher.calls[0];
    const quotaCall = fetcher.calls[1];
    if (loadCall === undefined || quotaCall === undefined) {
      throw new Error("expected the loadCodeAssist and retrieveUserQuota calls");
    }

    // loadCodeAssist: POST, Bearer access, GeminiCLI wire headers, OMP usage
    // body (cloudaicompanionProject + metadata WITHOUT duetProject).
    expect(loadCall.method).toBe("POST");
    expect(loadCall.url).toBe(LOAD_CODE_ASSIST_URL);
    expectGeminiHeaders(loadCall.init, ACCESS);
    expect(new Headers(loadCall.init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(loadCall.init.body))).toEqual({
      cloudaicompanionProject: PROJECT,
      metadata: EXPECTED_METADATA,
    });

    // retrieveUserQuota: POST with { project: <discovered/identity project> }.
    expect(quotaCall.method).toBe("POST");
    expect(quotaCall.url).toBe(RETRIEVE_USER_QUOTA_URL);
    expectGeminiHeaders(quotaCall.init, ACCESS);
    expect(JSON.parse(String(quotaCall.init.body))).toEqual({ project: PROJECT });

    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(request.requestId);
    expect(response.report.productKind).toBe("quota");
    expect(response.report.sourceKind).toBe("privateApi");
    expect(response.report.connectorVersion).toBe("google-gemini-cli-1");
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expect(response.refreshedCredential).toBeUndefined();
    expectNoModelFields(response);
  });

  test("discovers the project from loadCodeAssist when the credential has none", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: {
        status: 200,
        body: { cloudaicompanionProject: { id: "discovered-project-9" }, currentTier: { id: "standard-tier" } },
      },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const response = await googleGeminiCliConnector.fetchUsage({
      request: geminiUsageRequest(oauthCredential({ identity: {} })),
      fetcher,
      nowMs: NOW_MS,
    });

    // No known project: the load body carries metadata only, and the object
    // form of cloudaicompanionProject feeds { project } into the quota call.
    expect(JSON.parse(String(fetcher.calls[0]?.init.body))).toEqual({ metadata: EXPECTED_METADATA });
    expect(JSON.parse(String(fetcher.calls[1]?.init.body))).toEqual({ project: "discovered-project-9" });
    expect(response.report.windows.length).toBe(EXPECTED_WINDOWS.length);
  });
});

describe("googleGeminiCliConnector — request guards", () => {
  test("rejects a foreign providerId with invalidProvider", async () => {
    const fetcher = mockFetcher([]);
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({
        request: buildUsageRequest({ providerId: "zai", connectorId: "google-gemini-cli" }),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("invalidProvider");
    expect(fetcher.calls.length).toBe(0);
  });

  test("rejects an absent credential with missingCredential", async () => {
    const request: BridgeRequest = {
      schemaVersion: "1.3.0",
      requestId: "00000000-0000-4000-8000-000000000001",
      operation: "fetchUsage",
      providerId: "google-gemini-cli",
      connectorId: "google-gemini-cli",
      accountRef: "00000000-0000-4000-8000-000000000002",
      requestedAtMs: 1787011200000,
      deadlineAtMs: 1787011210000,
    };
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request, fetcher: mockFetcher([]), nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("missingCredential");
  });

  test("rejects non-OAuth credentials with invalidRequest", async () => {
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({
        request: geminiUsageRequest({ kind: "bearer", secret: ACCESS }),
        fetcher: mockFetcher([]),
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("invalidRequest");
  });

  test("rejects an OAuth credential without an access token", async () => {
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({
        request: geminiUsageRequest(oauthCredential({ access: "" })),
        fetcher: mockFetcher([]),
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("missingCredential");
  });
});

describe("googleGeminiCliConnector — error branches", () => {
  test("maps a 401 to authRequired when no rotation is possible", async () => {
    const credential = oauthCredential({ omitRefresh: true, identity: {} });
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 401, body: {} },
    });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(credential), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.length).toBe(2);
  });

  test("maps a 429 with Retry-After to rateLimited carrying retryAfterMs", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: {} },
    });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200 },
    });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("maps a non-array buckets field to malformedPayload", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: { buckets: "nope" } },
    });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("buckets");
  });

  test("maps an empty bucket list to noData", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: {} },
    });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("noData");
  });

  test("keeps a loadCodeAssist HTTP failure non-fatal (OMP warns and continues)", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 500, body: {} },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const response = await googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expectNoModelFields(response);
  });

  test("propagates a loadCodeAssist transport failure", async () => {
    const fetcher = mockFetcher({
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("transport");
  });
});

describe("googleGeminiCliConnector — OAuth rotation", () => {
  test("pre-rotates a near-expiry token before the first upstream call and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3600 } },
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const credential = oauthCredential({ expiresAtMs: NOW_MS + 30_000 });
    const response = await googleGeminiCliConnector.fetchUsage({
      request: geminiUsageRequest(credential),
      fetcher,
      nowMs: NOW_MS,
    });

    // Rotation happens BEFORE any upstream call, with the OMP refresh body.
    const rotateCall = fetcher.calls[0];
    if (rotateCall === undefined) {
      throw new Error("expected a token refresh call");
    }
    expect(rotateCall.method).toBe("POST");
    expect(rotateCall.url).toBe(TOKEN_URL);
    const params = new URLSearchParams(String(rotateCall.init.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
    expect(params.get("refresh_token")).toBe(REFRESH);

    // Upstream calls ride the rotated access token.
    expect(fetcher.calls.length).toBe(3);
    expectGeminiHeaders(fetcher.calls[1]?.init, ROTATED_ACCESS);
    expectGeminiHeaders(fetcher.calls[2]?.init, ROTATED_ACCESS);

    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    const refreshed = response.refreshedCredential;
    if (refreshed?.kind !== "oauth") {
      throw new Error("expected a refreshed oauth credential");
    }
    expect(refreshed.secret).toBe(ROTATED_ACCESS);
    expect(refreshed.oauth.access).toBe(ROTATED_ACCESS);
    expect(refreshed.oauth.refresh).toBe(ROTATED_REFRESH);
    // OMP keeps a 5-minute safety margin: now + 3600s - 300s.
    expect(refreshed.oauth.expiresAtMs).toBeGreaterThan(NOW_MS + 3_000_000);
    expect(refreshed.oauth.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3_300_000);
    expect(refreshed.oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(refreshed.oauth.clientId).toBe(CLIENT_ID);
    expect(refreshed.oauth.identity).toEqual({ projectId: PROJECT });
    expectNoModelFields(response);
  });

  test("pre-rotates when expiresAtMs is missing entirely", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ROTATED_ACCESS, expires_in: 3600 } },
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const response = await googleGeminiCliConnector.fetchUsage({
      request: geminiUsageRequest(oauthCredential({ omitExpiresAtMs: true })),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls[0]?.url).toBe(TOKEN_URL);
    // Google omitted a new refresh token: the old one is preserved (OMP).
    expect(response.refreshedCredential?.kind).toBe("oauth");
    if (response.refreshedCredential?.kind === "oauth") {
      expect(response.refreshedCredential.oauth.refresh).toBe(REFRESH);
    }
  });

  test("does not rotate a still-valid token (happy path makes exactly two calls)", async () => {
    const fetcher = mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });
    const response = await googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), fetcher, nowMs: NOW_MS });
    expect(fetcher.calls.length).toBe(2);
    expect(fetcher.calls[0]?.url).toBe(LOAD_CODE_ASSIST_URL);
    expect(response.refreshedCredential).toBeUndefined();
  });

  test("rotates once on a mid-flow 401 and retries the sequence", async () => {
    let quotaAttempts = 0;
    const fetcher = mockFetcher([
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: { access_token: ROTATED_ACCESS, expires_in: 3600 } } },
      { when: `POST ${LOAD_CODE_ASSIST_URL}`, respond: { status: 200, body: LOAD_BODY } },
      {
        when: (method, url) => method === "POST" && url === RETRIEVE_USER_QUOTA_URL && quotaAttempts++ === 0,
        respond: { status: 401, body: {} },
      },
      { when: `POST ${RETRIEVE_USER_QUOTA_URL}`, respond: { status: 200, body: QUOTA_BODY } },
    ]);
    const response = await googleGeminiCliConnector.fetchUsage({
      request: geminiUsageRequest(oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 })),
      fetcher,
      nowMs: NOW_MS,
    });

    // Sequence: load + quota (401) -> rotate -> load + quota (200).
    expect(fetcher.calls.map((call) => call.url)).toEqual([
      LOAD_CODE_ASSIST_URL,
      RETRIEVE_USER_QUOTA_URL,
      TOKEN_URL,
      LOAD_CODE_ASSIST_URL,
      RETRIEVE_USER_QUOTA_URL,
    ]);
    expectGeminiHeaders(fetcher.calls[0]?.init, ACCESS);
    expectGeminiHeaders(fetcher.calls[1]?.init, ACCESS);
    expectGeminiHeaders(fetcher.calls[3]?.init, ROTATED_ACCESS);
    expectGeminiHeaders(fetcher.calls[4]?.init, ROTATED_ACCESS);
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expect(response.refreshedCredential?.kind).toBe("oauth");
    if (response.refreshedCredential?.kind === "oauth") {
      expect(response.refreshedCredential.oauth.access).toBe(ROTATED_ACCESS);
    }
  });

  test("rotates only once: a 401 that persists surfaces as authRequired", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: { access_token: ROTATED_ACCESS, expires_in: 3600 } } },
      { when: `POST ${LOAD_CODE_ASSIST_URL}`, respond: { status: 200, body: LOAD_BODY } },
      { when: `POST ${RETRIEVE_USER_QUOTA_URL}`, respond: { status: 401, body: {} } },
    ]);
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({
        request: geminiUsageRequest(oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 })),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("authRequired");
    expect(fetcher.calls.filter((call) => call.url === TOKEN_URL).length).toBe(1);
  });

  test("keeps the pre-rotated credential on the error envelope when the quota call fails afterwards", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: { access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3600 } } },
      { when: `POST ${LOAD_CODE_ASSIST_URL}`, respond: { status: 200, body: LOAD_BODY } },
      {
        when: `POST ${RETRIEVE_USER_QUOTA_URL}`,
        respond: { status: 429, headers: { "retry-after": "29" }, body: { error: "quota" } },
      },
    ]);
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({
        request: geminiUsageRequest(oauthCredential({ omitExpiresAtMs: true })),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(29_000);
    expect(fetcher.calls.map((call) => call.url)).toEqual([TOKEN_URL, LOAD_CODE_ASSIST_URL, RETRIEVE_USER_QUOTA_URL]);
    // The rotated bundle rides the error so the caller persists it before
    // surfacing the failure — Google rotation burns the old refresh token.
    expect(error.refreshedCredential?.kind).toBe("oauth");
    if (error.refreshedCredential?.kind !== "oauth") {
      throw new Error("expected the rotated credential on the error envelope");
    }
    expect(error.refreshedCredential.oauth.access).toBe(ROTATED_ACCESS);
    expect(error.refreshedCredential.oauth.refresh).toBe(ROTATED_REFRESH);
    expect(error.refreshedCredential.oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(error.refreshedCredential.oauth.identity).toEqual({ projectId: PROJECT });
    expect(error.message).not.toContain(ROTATED_ACCESS);
  });

  test("keeps the mid-flow-rotated credential on the error envelope when the retried quota call fails", async () => {
    let quotaAttempts = 0;
    const fetcher = mockFetcher([
      { when: `POST ${TOKEN_URL}`, respond: { status: 200, body: { access_token: ROTATED_ACCESS, expires_in: 3600 } } },
      { when: `POST ${LOAD_CODE_ASSIST_URL}`, respond: { status: 200, body: LOAD_BODY } },
      {
        when: (method, url) => method === "POST" && url === RETRIEVE_USER_QUOTA_URL && quotaAttempts++ === 0,
        respond: { status: 401, body: {} },
      },
      { when: `POST ${RETRIEVE_USER_QUOTA_URL}`, respond: { status: 500, body: { error: "boom" } } },
    ]);
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliConnector.fetchUsage({
        request: geminiUsageRequest(oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 })),
        fetcher,
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(fetcher.calls.filter((call) => call.url === TOKEN_URL).length).toBe(1);
    expect(error.refreshedCredential?.kind).toBe("oauth");
    if (error.refreshedCredential?.kind !== "oauth") {
      throw new Error("expected the rotated credential on the error envelope");
    }
    expect(error.refreshedCredential.oauth.access).toBe(ROTATED_ACCESS);
  });
});

// ---------------------------------------------------------------------------
// Auth module
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

/**
 * Runs the browser flow end-to-end against mocked endpoints + a real loopback.
 *
 * Upstream mock calls are gated until the loopback response has fully
 * drained (the module stops the callback server in its `finally`), so letting
 * the provisioning calls race the response read would fail with ECONNRESET.
 */
async function runBrowserFlow(
  routes: Parameters<typeof mockFetcher>[0],
): Promise<{
  readonly result: Awaited<ReturnType<typeof loginGoogleGeminiCli>>;
  readonly fetcher: ReturnType<typeof mockFetcher>;
  readonly collector: ReturnType<typeof eventCollector>;
  readonly openedUrls: string[];
  readonly authorizeUrl: URL;
  readonly redirectUri: string;
}> {
  const innerFetcher = mockFetcher(routes);
  const callbackDrained = Promise.withResolvers<void>();
  const fetcher = (url: string, init: RequestInit): Promise<Response> =>
    callbackDrained.promise.then(() => innerFetcher(url, init));
  const collector = eventCollector();
  const openedUrls: string[] = [];
  const controller = new AbortController();

  const loginPromise = loginGoogleGeminiCli("browser", {}, collector.events, controller.signal, {
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

  const callbackResponse = await fetch(`${redirectUri}?code=${encodeURIComponent(AUTH_CODE)}&state=${encodeURIComponent(state)}`);
  expect(callbackResponse.status).toBe(200);
  await callbackResponse.text();
  callbackDrained.resolve();

  const result = await loginPromise;
  return { result, fetcher: innerFetcher, collector, openedUrls, authorizeUrl, redirectUri };
}

const TOKEN_BODY = { access_token: OAUTH_ACCESS, refresh_token: REFRESH, expires_in: 3599 };

describe("googleGeminiCliAuth — browser method", () => {
  test("runs the full Google authorization-code flow with project discovery", async () => {
    const { result, fetcher, collector, openedUrls, authorizeUrl, redirectUri } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: { currentTier: { id: "standard-tier", name: "Standard" }, cloudaicompanionProject: LOGIN_PROJECT } },
    });

    // Authorize URL: accounts.google.com, Gemini CLI client id, the actual
    // loopback redirect_uri, 32-hex state, offline access + consent.
    expect(authorizeUrl.origin).toBe("https://accounts.google.com");
    expect(authorizeUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
    );
    expect(authorizeUrl.searchParams.get("access_type")).toBe("offline");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("consent");
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
    expect(authorizeUrl.searchParams.has("code_challenge")).toBe(false);
    expect(openedUrls).toEqual([]);

    // Events: openUrl first, the OMP paste-fallback hint, progress events.
    expect(collector.received()[0]?.type).toBe("openUrl");
    expect(collector.received().some((event) => event.type === "pasteHint")).toBe(true);
    expect(collector.received().filter((event) => event.type === "waiting").length).toBeGreaterThanOrEqual(3);

    // Token exchange: form-encoded authorization_code grant with the
    // embedded client id + secret.
    const tokenCall = fetcher.calls[0];
    if (tokenCall === undefined) {
      throw new Error("expected a token exchange call");
    }
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.url).toBe(TOKEN_URL);
    expect(new Headers(tokenCall.init.headers).get("Content-Type")).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(String(tokenCall.init.body));
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("client_secret")).toBe(CLIENT_SECRET);
    expect(params.get("code")).toBe(AUTH_CODE);
    expect(params.get("grant_type")).toBe("authorization_code");
    expect(params.get("redirect_uri")).toBe(redirectUri);

    // User info probe rides the OAuth access token.
    const userCall = fetcher.calls[1];
    if (userCall === undefined) {
      throw new Error("expected a user info call");
    }
    expect(userCall.method).toBe("GET");
    expect(userCall.url).toBe(USERINFO_URL);
    expect(new Headers(userCall.init.headers).get("Authorization")).toBe(`Bearer ${OAUTH_ACCESS}`);

    // Project discovery: the login body shape (no duetProject without an env
    // project) with the GeminiCLI wire headers.
    const loadCall = fetcher.calls[2];
    if (loadCall === undefined) {
      throw new Error("expected a loadCodeAssist call");
    }
    expect(loadCall.method).toBe("POST");
    expect(loadCall.url).toBe(LOAD_CODE_ASSIST_URL);
    expectGeminiHeaders(loadCall.init, OAUTH_ACCESS);
    expect(JSON.parse(String(loadCall.init.body))).toEqual({ metadata: EXPECTED_METADATA });
    expect(fetcher.calls.length).toBe(3);

    // Credential: OAuth bundle with the discovered project in identity.
    const credential = result.credential;
    expect(credential.kind).toBe("oauth");
    if (credential.kind !== "oauth") {
      throw new Error("unreachable");
    }
    expect(credential.secret).toBe(OAUTH_ACCESS);
    expect(credential.oauth.access).toBe(OAUTH_ACCESS);
    expect(credential.oauth.refresh).toBe(REFRESH);
    expect(typeof credential.oauth.expiresAtMs).toBe("number");
    expect(credential.oauth.expiresAtMs).toBeGreaterThan(NOW_MS);
    expect(credential.oauth.refreshEndpoint).toBe(TOKEN_URL);
    expect(credential.oauth.clientId).toBe(CLIENT_ID);
    expect(credential.oauth.identity).toEqual({ projectId: LOGIN_PROJECT, email: EMAIL });
    expect(result.accountLabel).toBe(EMAIL);
  });

  test("onboards a free-tier account and provisions the project (LRO done inline)", async () => {
    const { result, fetcher } = await runBrowserFlow({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: { allowedTiers: [{ id: "free-tier", isDefault: true }] } },
      [`POST ${ONBOARD_USER_URL}`]: {
        status: 200,
        body: { done: true, response: { cloudaicompanionProject: { id: "provisioned-project-42" } } },
      },
    });

    const onboardCall = fetcher.calls.find((call) => call.url === ONBOARD_USER_URL);
    if (onboardCall === undefined) {
      throw new Error("expected an onboardUser call");
    }
    expect(onboardCall.method).toBe("POST");
    expectGeminiHeaders(onboardCall.init, OAUTH_ACCESS);
    expect(JSON.parse(String(onboardCall.init.body))).toEqual({ tierId: "free-tier", metadata: EXPECTED_METADATA });
    expect(result.credential.kind).toBe("oauth");
    if (result.credential.kind === "oauth") {
      expect(result.credential.oauth.identity).toEqual({ projectId: "provisioned-project-42", email: EMAIL });
    }
  });

  test("uses the GOOGLE_CLOUD_PROJECT env project in the discovery body when set", async () => {
    process.env["GOOGLE_CLOUD_PROJECT"] = "env-project-9";
    try {
      const { result, fetcher } = await runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
        [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
        [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: { currentTier: { id: "standard-tier" } } },
      });
      const loadCall = fetcher.calls[2];
      if (loadCall === undefined) {
        throw new Error("expected a loadCodeAssist call");
      }
      // Login body shape: cloudaicompanionProject + metadata.duetProject.
      expect(JSON.parse(String(loadCall.init.body))).toEqual({
        cloudaicompanionProject: "env-project-9",
        metadata: { ...EXPECTED_METADATA, duetProject: "env-project-9" },
      });
      expect(result.credential.kind).toBe("oauth");
      if (result.credential.kind === "oauth") {
        expect(result.credential.oauth.identity).toEqual({ projectId: "env-project-9", email: EMAIL });
      }
    } finally {
      delete process.env["GOOGLE_CLOUD_PROJECT"];
    }
  });

  test("maps a VPC-SC-rejected account without an env project to invalidRequest", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
        [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
        [`POST ${LOAD_CODE_ASSIST_URL}`]: {
          status: 403,
          body: { error: { details: [{ reason: "SECURITY_POLICY_VIOLATED" }] } },
        },
      }),
    );
    // The VPC-SC branch falls back to currentTier=standard-tier, which then
    // requires GOOGLE_CLOUD_PROJECT (OMP configuration error).
    expect(error.kind).toBe("invalidRequest");
    expect(error.message).toContain("GOOGLE_CLOUD_PROJECT");
  });

  test("maps a default standard tier without an env project to invalidRequest", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
        [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
        [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: { allowedTiers: [{ id: "standard-tier", isDefault: true }] } },
      }),
    );
    // Non-free default tier without GOOGLE_CLOUD_PROJECT: OMP configuration error.
    expect(error.kind).toBe("invalidRequest");
    expect(error.message).toContain("GOOGLE_CLOUD_PROJECT");
  });

  test("maps a token exchange HTTP failure to the default status map", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 400, body: { error: "invalid_grant" } },
      }),
    );
    expect(error.kind).toBe("upstreamError");
    expect(error.message).not.toContain(AUTH_CODE);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });

  test("maps a token response without a refresh token to malformedPayload", async () => {
    const error = await bridgeErrorFrom(() =>
      runBrowserFlow({
        [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: OAUTH_ACCESS, expires_in: 3599 } },
      }),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("refresh token");
  });

  test("maps an aborted login signal to a timeout BridgeError with a cancelled message", async () => {
    const fetcher = mockFetcher([]);
    const collector = eventCollector();
    const controller = new AbortController();
    const loginPromise = loginGoogleGeminiCli("browser", {}, collector.events, controller.signal, {
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

describe("googleGeminiCliAuth — manual paste fallback (OMP onManualCodeInput race)", () => {
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
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
      [`POST ${LOAD_CODE_ASSIST_URL}`]: {
        status: 200,
        body: { currentTier: { id: "standard-tier" }, cloudaicompanionProject: LOGIN_PROJECT },
      },
    });
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginGoogleGeminiCli("browser", {}, pastes.events, controller.signal, {
      fetcher,
      openBrowser: () => undefined,
    });
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
    expect(result.credential.oauth.identity).toEqual({ projectId: LOGIN_PROJECT, email: EMAIL });
  });

  test("re-prompts when the paste carries a mismatched state, then accepts", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: TOKEN_BODY },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: EMAIL } },
      [`POST ${LOAD_CODE_ASSIST_URL}`]: {
        status: 200,
        body: { currentTier: { id: "standard-tier" }, cloudaicompanionProject: LOGIN_PROJECT },
      },
    });
    const collector = eventCollector();
    const pastes = pasteCollector(collector);
    const controller = new AbortController();
    const firstPrompt = pastes.waitForPrompts(1, controller.signal);
    const loginPromise = loginGoogleGeminiCli("browser", {}, pastes.events, controller.signal, {
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
    const loginPromise = loginGoogleGeminiCli("browser", {}, pastes.events, controller.signal, {
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

describe("googleGeminiCliAuth — module surface", () => {
  test("offers the browser method and rejects other methods", async () => {
    expect(googleGeminiCliAuth.providerId).toBe("google-gemini-cli");
    expect(googleGeminiCliAuth.methods).toEqual(["browser"]);
    expect(googleGeminiCliConnector.providerId).toBe("google-gemini-cli");
    expect(googleGeminiCliConnector.connectorVersion).toBe("google-gemini-cli-1");
    expect(fetchGoogleGeminiCliUsage).toBe(googleGeminiCliConnector.fetchUsage);

    const request = buildLoginRequest({ providerId: "google-gemini-cli", method: "device" });
    const error = await bridgeErrorFrom(() =>
      googleGeminiCliAuth.login(request.method, request.inputs ?? {}, eventCollector().events, AbortSignal.timeout(50)),
    );
    expect(error.kind).toBe("invalidRequest");
  });
});

describe("Gemini latest quota-tier and wire conformance", () => {
  test.each([
    ["gemini-3-flash-preview", "Gemini 3-Flash"], ["gemini-3.5-flash", "Gemini 3-Flash"],
    ["gemini-2.5-flash-lite", "Gemini Flash"], ["gemini-pro-agent", "Gemini Pro"],
    ["new-flash-pro", "Gemini Flash"], ["new-pro", "Gemini Pro"],
    ["NEW-FLASH", "Gemini NEW-FLASH"], ["other", "Gemini other"],
  ] as const)("maps quota id %s without a catalog", async (modelId, label) => {
    const response = await googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), nowMs: NOW_MS, fetcher: mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: { buckets: [{ modelId, remainingFraction: 0.2 }] } },
    }) });
    expect(response.report.windows[0]).toMatchObject({ id: `${modelId}:quota`, label, severity: "warning", resolvedFraction: 0.8 });
  });
  test("omits amountless buckets without losing usable siblings", async () => {
    const response = await googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), nowMs: NOW_MS, fetcher: mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: { buckets: [{ modelId: "empty" }, { modelId: "known", remainingFraction: 0.05 }] } },
    }) });
    expect(response.report.windows.map(window => window.id)).toEqual(["known:quota"]);
  });
  test("returns noData for entirely amountless quota buckets", async () => {
    await expect(googleGeminiCliConnector.fetchUsage({ request: geminiUsageRequest(), nowMs: NOW_MS, fetcher: mockFetcher({
      [`POST ${LOAD_CODE_ASSIST_URL}`]: { status: 200, body: LOAD_BODY },
      [`POST ${RETRIEVE_USER_QUOTA_URL}`]: { status: 200, body: { buckets: [null, {}, { remainingFraction: "bad" }] } },
    }) })).rejects.toMatchObject({ kind: "noData" });
  });
});
