import { describe, expect, test } from "bun:test";
import { createXaiOauthConnector, loginXaiOauth, xaiOauthAuth, xaiOauthConnector } from "../src/providers/xai-oauth";
import { BridgeError } from "../src/protocol";
import type { BridgeCredential, BridgeErrorKind, UsageWindow } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import type { Fetcher } from "../src/connectors/provider-http";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";
import type { RecordedCall } from "./helpers";

const NOW_MS = 1787011200500;
const ACCESS = "xai-first-access";
const REFRESH = "xai-first-refresh";
const ACCESS_2 = "xai-second-access";
const REFRESH_2 = "xai-second-refresh";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const XAI_OAUTH_ISSUER_URL = "https://auth.x.ai";
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
const CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";
/** OMP ACCESS_TOKEN_CLIENT_SKEW_MS. */
const SKEW_MS = 5 * 60 * 1000;

const WEEKLY_RESET_ISO = "2026-08-24T00:00:00Z";
const WEEKLY_RESET_MS = Date.parse(WEEKLY_RESET_ISO);

/** Realistic OMP-shaped legacy weekly credits payload (?format=credits). */
const WEEKLY_PAYLOAD = {
  config: {
    currentPeriod: { start: "2026-08-10T00:00:00Z", end: WEEKLY_RESET_ISO, type: "WEEK" },
    creditUsagePercent: 42,
    productUsage: [
      { product: "GrokBuild", usagePercent: 10 },
      { product: "Api", usagePercent: 0 },
      { product: "DeepSearch", usagePercent: 87.5 },
    ],
    onDemandCap: { val: 100 },
    onDemandUsed: { val: 25 },
  },
};

const WEEKLY_WINDOWS: readonly UsageWindow[] = [
  {
    id: "xai-oauth:credits:1w",
    label: "SuperGrok Weekly Credits",
    unit: "percent",
    resolvedFraction: 0.42,
    severity: "ok",
    used: 42,
    limit: 100,
    resetsAtMs: WEEKLY_RESET_MS,
  },
  {
    id: "xai-oauth:product:grokbuild:1w",
    label: "Grok Build (Weekly)",
    unit: "percent",
    resolvedFraction: 0.1,
    severity: "ok",
    used: 10,
    limit: 100,
    resetsAtMs: WEEKLY_RESET_MS,
  },
  {
    id: "xai-oauth:product:api:1w",
    label: "API (Weekly)",
    unit: "percent",
    resolvedFraction: 0,
    severity: "ok",
    used: 0,
    limit: 100,
    resetsAtMs: WEEKLY_RESET_MS,
  },
  {
    id: "xai-oauth:product:deepsearch:1w",
    label: "DeepSearch (Weekly)",
    unit: "percent",
    resolvedFraction: 0.875,
    severity: "warning",
    used: 87.5,
    limit: 100,
    resetsAtMs: WEEKLY_RESET_MS,
  },
  {
    id: "xai-oauth:on-demand",
    label: "On-demand",
    unit: "unknown",
    resolvedFraction: 0.25,
    severity: "ok",
    used: 25,
    limit: 100,
  },
];

/** Unified-billing credits shape: omitted creditUsagePercent -> inferred weekly. */
const UNIFIED_CREDITS_PAYLOAD = {
  config: {
    currentPeriod: { start: "2026-08-10T00:00:00Z", end: WEEKLY_RESET_ISO, type: "WEEK" },
    isUnifiedBillingUser: true,
  },
};

/** Unified-billing monthly included-quota payload (default billing URL). */
const MONTHLY_PAYLOAD = {
  config: {
    billingPeriodStart: "2026-08-01T00:00:00Z",
    billingPeriodEnd: "2026-09-01T00:00:00Z",
    used: { val: 30 },
    monthlyLimit: { val: 120 },
    onDemandCap: { val: 50 },
    onDemandUsed: { val: 50 },
  },
};

const MONTHLY_WINDOWS: readonly UsageWindow[] = [
  {
    id: "xai-oauth:included:1mo",
    label: "SuperGrok Monthly Included",
    // xAI does not label the unit (OMP keeps "unknown" here).
    unit: "unknown",
    resolvedFraction: 0.25,
    severity: "ok",
    used: 30,
    limit: 120,
    resetsAtMs: Date.parse("2026-09-01T00:00:00Z"),
  },
  {
    id: "xai-oauth:on-demand",
    label: "On-demand",
    unit: "unknown",
    resolvedFraction: 1,
    severity: "exhausted",
    used: 50,
    limit: 50,
  },
];

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, ...(headers !== undefined ? { headers } : {}) });
}

function makeAccessToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.unit-signature`;
}

type OAuthOverrides = {
  readonly access?: string;
  readonly refresh?: string | null;
  readonly expiresAtMs?: number | null;
  readonly identity?: Record<string, string> | undefined;
};

function oauthCredential(overrides: OAuthOverrides = {}): BridgeCredential {
  const access = overrides.access ?? ACCESS;
  return {
    kind: "oauth",
    secret: access,
    oauth: {
      access,
      ...(overrides.refresh !== null ? { refresh: overrides.refresh ?? REFRESH } : {}),
      ...(overrides.expiresAtMs !== null
        ? { expiresAtMs: overrides.expiresAtMs ?? NOW_MS + 3_600_000 }
        : {}),
      refreshEndpoint: TOKEN_URL,
      clientId: CLIENT_ID,
      ...(overrides.identity !== undefined ? { identity: overrides.identity } : {}),
    },
  };
}

function usageRequest(overrides: Parameters<typeof buildUsageRequest>[0] = {}) {
  return buildUsageRequest({
    providerId: "xai-oauth",
    connectorId: "xai-oauth",
    credential: oauthCredential({ identity: { accountId: "sub-1", email: "dev@x.ai" } }),
    ...overrides,
  });
}

async function expectKind(action: () => Promise<unknown>, kind: BridgeErrorKind): Promise<BridgeError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).kind).toBe(kind);
    return error as BridgeError;
  }
  throw new Error(`expected BridgeError ${kind}`);
}

describe("xaiOauthConnector", () => {
  for (const [percent, severity] of [[80, "warning"], [87.5, "warning"], [89.9, "warning"], [95, "critical"], [99.9, "critical"]] as const) {
    test(`uses wire severity for every quota kind at ${percent}%`, async () => {
      const fetcher = mockFetcher({
        [`GET ${CREDITS_URL}`]: { status: 200, body: { config: {
          ...WEEKLY_PAYLOAD.config, creditUsagePercent: percent, isUnifiedBillingUser: true,
          productUsage: [{ product: "GrokBuild", usagePercent: percent }], onDemandUsed: { val: percent },
        } } },
        [`GET ${MONTHLY_URL}`]: { status: 200, body: { config: {
          ...MONTHLY_PAYLOAD.config, used: { val: percent }, monthlyLimit: { val: 100 },
        } } },
      });
      const response = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });
      expect(response.report.windows).toHaveLength(4);
      expect(response.report.windows.map(window => window.severity)).toEqual(Array(4).fill(severity));
    });
  }

  for (const failure of ["500", "transport", "malformed", "timeout"] as const) {
    for (const failedEndpoint of ["credits", "monthly"] as const) {
      test(`keeps useful quota after ${failedEndpoint} ${failure}`, async () => {
        const calls: string[] = [];
        const fetcher: Fetcher = async url => {
          calls.push(url);
          if (url === (failedEndpoint === "credits" ? CREDITS_URL : MONTHLY_URL)) {
            if (failure === "transport") throw new TypeError("synthetic network failure");
            if (failure === "timeout") throw new DOMException("synthetic endpoint timeout", "TimeoutError");
            return failure === "malformed" ? new Response("not JSON") : Response.json({}, { status: 500 });
          }
          return Response.json(url === CREDITS_URL
            ? { config: { ...WEEKLY_PAYLOAD.config, isUnifiedBillingUser: true } } : MONTHLY_PAYLOAD);
        };
        const result = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });
        expect(result.report.windows).toEqual(failedEndpoint === "credits" ? MONTHLY_WINDOWS : WEEKLY_WINDOWS);
        expect(calls).toEqual([CREDITS_URL, MONTHLY_URL]);
      });
    }
  }

  for (const [status, kind] of [[401, "authRequired"], [403, "permissionDenied"], [429, "rateLimited"]] as const) {
    for (const failedEndpoint of [CREDITS_URL, MONTHLY_URL]) {
      test(`does not recover billing ${status} from ${failedEndpoint}`, async () => {
        const calls: string[] = [];
        const fetcher: Fetcher = async url => {
          calls.push(url);
          return url === failedEndpoint ? Response.json({}, { status, headers: { "retry-after": "19" } })
            : Response.json({ config: { ...WEEKLY_PAYLOAD.config, isUnifiedBillingUser: true } });
        };
        const error = await expectKind(() => xaiOauthConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ refresh: null, identity: { email: "synthetic@example.invalid" } }) }),
          fetcher, nowMs: NOW_MS,
        }), kind);
        expect(calls).toEqual(failedEndpoint === CREDITS_URL ? [CREDITS_URL] : [CREDITS_URL, MONTHLY_URL]);
        if (status === 429) expect(error.retryAfterMs).toBe(19_000);
      });
    }
  }

  test("does not invent inferred unified weekly quota after a monthly failure", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: UNIFIED_CREDITS_PAYLOAD },
      [`GET ${MONTHLY_URL}`]: { status: 500, body: {} },
    });
    await expectKind(() => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }), "upstreamError");
  });

  test("rejects stale inferred weekly data", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: { config: {
        currentPeriod: { ...WEEKLY_PAYLOAD.config.currentPeriod, end: new Date(NOW_MS).toISOString() },
      } } },
      [`GET ${MONTHLY_URL}`]: { status: 200, body: { config: {} } },
    });
    await expectKind(() => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }), "noData");
  });

  test("rejects redirects on userinfo, refresh and billing in actual RequestInit", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 } },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { email: "synthetic@example.invalid" } },
      [`GET ${CREDITS_URL}`]: { status: 200, body: { config: { ...WEEKLY_PAYLOAD.config, isUnifiedBillingUser: true } } },
      [`GET ${MONTHLY_URL}`]: { status: 200, body: MONTHLY_PAYLOAD },
    });
    await xaiOauthConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: null }) }), fetcher, nowMs: NOW_MS,
    });
    for (const call of fetcher.calls.filter(call => call.url !== DISCOVERY_URL)) expect(call.init.redirect).toBe("error");
  });

  test("fetches weekly credits with Bearer access and maps the OMP normalization", async () => {
    expect(xaiOauthConnector.providerId).toBe("xai-oauth");
    expect(xaiOauthConnector.connectorVersion).toBe("xai-oauth-1");

    const fetcher = mockFetcher({ [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD } });
    const response = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${CREDITS_URL}`]);
    const headers = new Headers(fetcher.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");

    expect(response.status).toBe("ok");
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();
    expect(response.report).toEqual({
      productKind: "quota",
      sourceKind: "privateApi",
      fetchedAtMs: NOW_MS,
      connectorVersion: "xai-oauth-1",
      windows: WEEKLY_WINDOWS,
    });
    expect(JSON.stringify(response)).not.toContain(ACCESS);
    expectNoModelFields(response);
  });

  test("probes the monthly shape for unified accounts and reports the included quota", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: UNIFIED_CREDITS_PAYLOAD },
      [`GET ${MONTHLY_URL}`]: { status: 200, body: MONTHLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CREDITS_URL}`,
      `GET ${MONTHLY_URL}`,
    ]);
    expect(new Headers(fetcher.calls[1]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
    // A positive monthly quota replaces the inferred weekly credits.
    expect(response.report.windows).toEqual(MONTHLY_WINDOWS);
    expectNoModelFields(response);
  });

  test("falls back to the monthly shape when weekly credits are unusable", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: { config: {} } },
      [`GET ${MONTHLY_URL}`]: { status: 200, body: MONTHLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });
    expect(response.report.windows).toEqual(MONTHLY_WINDOWS);
  });

  test("keeps the inferred weekly shape when the monthly config confirms no monthly quota", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: UNIFIED_CREDITS_PAYLOAD },
      [`GET ${MONTHLY_URL}`]: {
        status: 200,
        body: {
          config: {
            billingPeriodStart: "2026-08-01T00:00:00Z",
            billingPeriodEnd: "2026-09-01T00:00:00Z",
            monthlyLimit: { val: 0 },
          },
        },
      },
    });
    const response = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });
    // Inferred 0% while the weekly period is still active (OMP rule).
    expect(response.report.windows).toEqual([
      {
        id: "xai-oauth:credits:1w",
        label: "SuperGrok Weekly Credits",
        unit: "percent",
        resolvedFraction: 0,
        severity: "ok",
        used: 0,
        limit: 100,
        resetsAtMs: WEEKLY_RESET_MS,
      },
    ]);
  });

  test("rejects the wrong provider, a missing credential and an API-key credential", async () => {
    const fetcher = mockFetcher({ [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD } });
    await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: usageRequest({ providerId: "other" }), fetcher, nowMs: NOW_MS }),
      "invalidProvider",
    );
    const { credential: _credential, ...missing } = usageRequest();
    await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: missing, fetcher, nowMs: NOW_MS }),
      "missingCredential",
    );
    // OMP supports() gate: paid xAI API keys are a separate product.
    await expectKind(
      () =>
        xaiOauthConnector.fetchUsage({
          request: usageRequest({ credential: { kind: "apiKey", secret: "xai-key-1" } }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "invalidPolicy",
    );
  });

  test("maps 401 to authRequired when no refresh material exists", async () => {
    const fetcher = mockFetcher({ [`GET ${CREDITS_URL}`]: { status: 401, body: { error: "unauthorized" } } });
    const error = await expectKind(
      () =>
        xaiOauthConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ refresh: null, identity: undefined }) }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "authRequired",
    );
    expect(error.message).not.toContain(ACCESS);
  });

  test("maps 429 with Retry-After to rateLimited", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { error: "slow_down" } },
    });
    const error = await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("maps a non-JSON billing body to malformedPayload", async () => {
    const fetcher: Fetcher = async () => new Response("not-json", { status: 200 });
    await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "malformedPayload",
    );
  });

  test("maps a payload with no usable rows to noData", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: { config: {} } },
      [`GET ${MONTHLY_URL}`]: { status: 200, body: { config: {} } },
    });
    await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "noData",
    );
  });

  test("drops the inferred weekly for unified accounts whose monthly probe yields nothing", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 200, body: UNIFIED_CREDITS_PAYLOAD },
      [`GET ${MONTHLY_URL}`]: { status: 200, body: {} },
    });
    await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "noData",
    );
  });

  test("pre-rotates when expiresAtMs is missing and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200 },
      },
      [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({
        credential: oauthCredential({
          expiresAtMs: null,
          identity: { accountId: "sub-1", email: "dev@x.ai" },
        }),
      }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${DISCOVERY_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${CREDITS_URL}`,
    ]);
    expect(new Headers(fetcher.calls[0]?.init.headers).get("accept")).toBe("application/json");
    const refreshHeaders = new Headers(fetcher.calls[1]?.init.headers);
    expect(refreshHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(fetcher.calls[1]?.init.body)).toBe(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: REFRESH,
      }).toString(),
    );
    expect(new Headers(fetcher.calls[2]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_2}`);

    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH_2,
        // OMP minting rule: now + expires_in - 5-minute skew.
        expiresAtMs: NOW_MS + 7_200_000 - SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: "sub-1", email: "dev@x.ai" },
      },
    });
    expect(response.report.windows).toEqual(WEEKLY_WINDOWS);
    expect(JSON.stringify(response)).not.toContain(REFRESH);
    expectNoModelFields(response);
  });

  test("pre-rotates when the token expires within 60s", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 },
      },
      [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({
        credential: oauthCredential({
          expiresAtMs: NOW_MS + 30_000,
          identity: { accountId: "sub-1", email: "dev@x.ai" },
        }),
      }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${DISCOVERY_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${CREDITS_URL}`,
    ]);
    expect(response.refreshedCredential).toMatchObject({ kind: "oauth", oauth: { access: ACCESS_2 } });
  });

  test("does not rotate a fresh token", async () => {
    const fetcher = mockFetcher({ [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD } });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({
        credential: oauthCredential({
          expiresAtMs: NOW_MS + 600_000,
          identity: { accountId: "sub-1", email: "dev@x.ai" },
        }),
      }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${CREDITS_URL}`]);
    expect(response.refreshedCredential).toBeUndefined();
  });

  test("rotates once and retries once on a mid-flow 401", async () => {
    const calls: RecordedCall[] = [];
    let creditsCalls = 0;
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ method: init.method ?? "GET", url, init });
      if (url === DISCOVERY_URL) {
        return jsonResponse({ token_endpoint: TOKEN_URL }, 200);
      }
      if (url === TOKEN_URL) {
        // No refresh_token in the response: OMP keeps the previous one.
        return jsonResponse({ access_token: ACCESS_2, expires_in: 3600 }, 200);
      }
      creditsCalls += 1;
      return creditsCalls === 1
        ? jsonResponse({ error: "unauthorized" }, 401)
        : jsonResponse(WEEKLY_PAYLOAD, 200);
    };

    const response = await xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CREDITS_URL}`,
      `GET ${DISCOVERY_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${CREDITS_URL}`,
    ]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(new Headers(calls[3]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_2}`);
    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH,
        expiresAtMs: NOW_MS + 3_600_000 - SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: "sub-1", email: "dev@x.ai" },
      },
    });
    expect(response.report.windows).toEqual(WEEKLY_WINDOWS);
    expectNoModelFields(response);
  });

  test("still fails authRequired when the retried billing call 401s again", async () => {
    const calls: RecordedCall[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ method: init.method ?? "GET", url, init });
      if (url === DISCOVERY_URL) return jsonResponse({ token_endpoint: TOKEN_URL }, 200);
      if (url === TOKEN_URL) return jsonResponse({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 }, 200);
      return jsonResponse({ error: "unauthorized" }, 401);
    };
    const error = await expectKind(
      () => xaiOauthConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "authRequired",
    );
    expect(error.message).not.toContain(ACCESS_2);
    expect(calls).toHaveLength(4);
    // The rotated bundle rides the error envelope so the caller persists it
    // before surfacing the failure — xAI rotation burns the old refresh token.
    expect(error.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH_2,
        expiresAtMs: NOW_MS + 3_600_000 - SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: "sub-1", email: "dev@x.ai" },
      },
    });
  });

  test("keeps the pre-rotated credential on the error envelope when the billing call fails afterwards", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 } },
      [`GET ${CREDITS_URL}`]: { status: 429, headers: { "retry-after": "19" }, body: { error: "slow down" } },
    });
    const error = await expectKind(
      () =>
        xaiOauthConnector.fetchUsage({
          request: usageRequest({
            credential: oauthCredential({ expiresAtMs: null, identity: { accountId: "sub-1", email: "dev@x.ai" } }),
          }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(19_000);
    expect(error.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH_2,
        expiresAtMs: NOW_MS + 3_600_000 - SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: "sub-1", email: "dev@x.ai" },
      },
    });
    expect(error.message).not.toContain(ACCESS_2);
  });

  test("propagates a failing rotation as authRequired without secret material", async () => {
    const fetcher = mockFetcher({
      [`GET ${CREDITS_URL}`]: { status: 401, body: { error: "unauthorized" } },
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: { status: 401, body: { error: "invalid_grant" } },
    });
    const error = await expectKind(
      () =>
        xaiOauthConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ expiresAtMs: null }) }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "authRequired",
    );
    expect(error.message).toContain("xAI token refresh");
    expect(error.message).not.toContain(REFRESH);
  });

  test("keeps the previous refresh token when a rotation response omits refresh_token", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS_2, expires_in: 7200 } },
      [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({
        credential: oauthCredential({
          expiresAtMs: null,
          identity: { accountId: "sub-1", email: "dev@x.ai" },
        }),
      }),
      fetcher,
      nowMs: NOW_MS,
    });
    // OMP parseXAITokenResponse: the previous refresh token is the fallback.
    expect(response.refreshedCredential).toMatchObject({ oauth: { access: ACCESS_2, refresh: REFRESH } });
  });

  test("queries userinfo best-effort when the credential carries no email", async () => {
    const fetcher = mockFetcher({
      [`GET ${USERINFO_URL}`]: { status: 200, body: { sub: "user-42", email: "Dev@X.AI", name: "Dev User" } },
      [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ identity: { accountId: "sub-1" } }) }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${USERINFO_URL}`,
      `GET ${CREDITS_URL}`,
    ]);
    const identityHeaders = new Headers(fetcher.calls[0]?.init.headers);
    expect(identityHeaders.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(identityHeaders.get("accept")).toBe("application/json");
    expect(response.report.windows).toEqual(WEEKLY_WINDOWS);
  });

  test("swallows a failing userinfo identity probe", async () => {
    const fetcher = mockFetcher({
      [`GET ${USERINFO_URL}`]: { status: 401, body: { error: "unauthorized" } },
      [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ identity: undefined }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(response.report.windows).toEqual(WEEKLY_WINDOWS);
  });

  test("merges the userinfo identity into a rotated credential", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200 },
      },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { sub: "user-42", email: "Dev@X.AI" } },
      [`GET ${CREDITS_URL}`]: { status: 200, body: WEEKLY_PAYLOAD },
    });
    const response = await xaiOauthConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: null, identity: { accountId: "sub-1" } }) }),
      fetcher,
      nowMs: NOW_MS,
    });

    // The fresh userinfo sub/email wins over the stored identity (OMP
    // withXAIOAuthIdentity precedence) and the probe uses the rotated token.
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${DISCOVERY_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${USERINFO_URL}`,
      `GET ${CREDITS_URL}`,
    ]);
    expect(new Headers(fetcher.calls[2]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_2}`);
    expect(response.refreshedCredential).toMatchObject({
      oauth: { access: ACCESS_2, identity: { accountId: "user-42", email: "dev@x.ai" } },
    });
  });
});

describe("xaiOauthAuth", () => {
  test("offers only the device method", () => {
    expect(xaiOauthAuth.providerId).toBe("xai-oauth");
    expect(xaiOauthAuth.methods).toEqual(["device"]);
  });

  test("device login discovers the token endpoint, polls, and stores the identity", async () => {
    const accessToken = makeAccessToken({ sub: "user-42" });
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_xai_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://auth.x.ai/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        },
      },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: accessToken, refresh_token: "xai-refresh-login-1", expires_in: 86400, token_type: "bearer" },
      },
      [`GET ${USERINFO_URL}`]: { status: 200, body: { sub: "user-42", email: "Dev@X.AI", name: "Dev User" } },
    });

    const events: AuthEvent[] = [];
    const request = buildLoginRequest({ providerId: "xai-oauth", method: "device", inputs: {} });
    const result = await loginXaiOauth(
      request.method,
      request.inputs ?? {},
      { onEvent: (event) => events.push(event) },
      new AbortController().signal,
      { fetcher, now: () => NOW_MS },
    );

    expect(result).toEqual({
      credential: {
        kind: "oauth",
        secret: accessToken,
        oauth: {
          access: accessToken,
          refresh: "xai-refresh-login-1",
          expiresAtMs: NOW_MS + 86_400_000 - SKEW_MS,
          refreshEndpoint: TOKEN_URL,
          clientId: CLIENT_ID,
          identity: { accountId: "user-42", email: "dev@x.ai" },
        },
      },
      accountLabel: "dev@x.ai",
    });

    expect(events.map(event => event.type)).toEqual(["openUrl", "code", "waiting"]);
    expect(events.slice(0, 2)).toEqual([
      { type: "openUrl", url: "https://auth.x.ai/device?user_code=WDJB-MJHT" },
      { type: "code", code: "WDJB-MJHT", verificationUrl: "https://auth.x.ai/device" },
    ]);

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${DISCOVERY_URL}`,
      `POST ${DEVICE_AUTHORIZATION_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${USERINFO_URL}`,
    ]);
    expect(new Headers(fetcher.calls[0]?.init.headers).get("accept")).toBe("application/json");
    const deviceHeaders = new Headers(fetcher.calls[1]?.init.headers);
    expect(deviceHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(fetcher.calls[1]?.init.body)).toBe(
      new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    );
    expect(String(fetcher.calls[2]?.init.body)).toBe(
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: "dc_xai_unit",
      }).toString(),
    );
    expect(new Headers(fetcher.calls[3]?.init.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
  });

  test("device login polls at the advertised interval after authorization_pending", async () => {
    const accessToken = "xai-opaque-access-unit";
    const sleepCalls: number[] = [];
    let tokenPolls = 0;
    const fetcher: Fetcher = async (url, init) => {
      if (url === DISCOVERY_URL) {
        return jsonResponse({ token_endpoint: TOKEN_URL }, 200);
      }
      if (url === DEVICE_AUTHORIZATION_URL) {
        return jsonResponse(
          {
            device_code: "dc_xai_unit",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.x.ai/device",
            verification_uri_complete: "https://auth.x.ai/device?user_code=WDJB-MJHT",
            interval: 5,
            expires_in: 900,
          },
          200,
        );
      }
      if (url === USERINFO_URL) return Response.json({});
      expect(init.method).toBe("POST");
      tokenPolls += 1;
      // RFC 8628 §3.5: pending/slow_down are 400-class responses carrying an
      // error code; success arrives as 200 with access_token.
      return tokenPolls === 1
        ? jsonResponse({ error: "authorization_pending" }, 400)
        : jsonResponse({ access_token: accessToken, refresh_token: "xai-refresh-login-2", expires_in: 3600 }, 200);
    };

    // Empty optional identity falls back to the opaque access token.
    const result = await loginXaiOauth(
      "device",
      {},
      { onEvent: () => {} },
      new AbortController().signal,
      {
        fetcher,
        now: () => NOW_MS,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    );

    expect(sleepCalls).toEqual([5000]);
    expect(result.credential).toEqual({
      kind: "oauth",
      secret: accessToken,
      oauth: {
        access: accessToken,
        refresh: "xai-refresh-login-2",
        expiresAtMs: NOW_MS + 3_600_000 - SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
    expect(result.accountLabel).toBeUndefined();
  });

  test("falls back to the JWT subject when userinfo yields nothing", async () => {
    const accessToken = makeAccessToken({ sub: "user-42" });
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_xai_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://auth.x.ai/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        },
      },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: accessToken, refresh_token: "xai-refresh-login-3", expires_in: 3600 },
      },
      [`GET ${USERINFO_URL}`]: { status: 200, body: {} },
    });

    const result = await loginXaiOauth(
      "device",
      {},
      { onEvent: () => {} },
      new AbortController().signal,
      { fetcher, now: () => NOW_MS },
    );

    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.identity).toEqual({ accountId: "user-42" });
    expect(result.accountLabel).toBe("user-42");
  });

  test("rejects a device token response without a refresh token", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_xai_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://auth.x.ai/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        },
      },
      // OMP parseXAITokenResponse requires refresh_token in the device flow
      // (there is no previous token to fall back to).
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS, expires_in: 3600 } },
    });
    const error = await expectKind(
      () =>
        loginXaiOauth("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: () => NOW_MS,
        }),
      "authRequired",
    );
    expect(error.message).toContain("missing refresh_token");
  });

  test("maps a denied authorization to authRequired", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_xai_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://auth.x.ai/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        },
      },
      [`POST ${TOKEN_URL}`]: { status: 400, body: { error: "access_denied" } },
    });
    const error = await expectKind(
      () =>
        loginXaiOauth("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: () => NOW_MS,
        }),
      "authRequired",
    );
    expect(error.message).toContain("access_denied");
  });

  test("maps a malformed device authorization response to authRequired", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: { device_code: "dc_xai_unit", user_code: "WDJB-MJHT" },
      },
    });
    await expectKind(
      () =>
        loginXaiOauth("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: () => NOW_MS,
        }),
      "authRequired",
    );
  });

  test("rejects a device verification URI pinned to a foreign host", async () => {
    const fetcher = mockFetcher({
      [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_xai_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://evil.example.com/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        },
      },
    });
    await expectKind(
      () =>
        loginXaiOauth("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: () => NOW_MS,
        }),
      "malformedPayload",
    );
  });

  test("maps a discovery response without token_endpoint to malformedPayload", async () => {
    const fetcher = mockFetcher({ [`GET ${DISCOVERY_URL}`]: { status: 200, body: { issuer: XAI_OAUTH_ISSUER_URL } } });
    await expectKind(
      () =>
        loginXaiOauth("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: () => NOW_MS,
        }),
      "malformedPayload",
    );
  });

  test("maps a pre-aborted signal to a cancelled timeout without upstream calls", async () => {
    const fetcher = mockFetcher({ [`GET ${DISCOVERY_URL}`]: { status: 500, body: { error: "boom" } } });
    const controller = new AbortController();
    controller.abort();
    const error = await expectKind(
      () =>
        loginXaiOauth("device", {}, { onEvent: () => {} }, controller.signal, { fetcher, now: () => NOW_MS }),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("rejects non-device login methods", async () => {
    await expectKind(
      () => xaiOauthAuth.login("apiKey", { apiKey: "xai-key-1" }, { onEvent: () => {} }, new AbortController().signal),
      "invalidRequest",
    );
  });
});

describe("xAI optional identity deadline", () => {
  function loginFetcher(identityFetch: Fetcher): Fetcher {
    return async (url, init) => {
      if (url === DISCOVERY_URL) return Response.json({ token_endpoint: TOKEN_URL });
      if (url === DEVICE_AUTHORIZATION_URL) return Response.json({
        device_code: "synthetic-device", user_code: "SYNTHETIC",
        verification_uri: "https://auth.x.ai/device",
        verification_uri_complete: "https://auth.x.ai/device?user_code=SYNTHETIC", expires_in: 900, interval: 5,
      });
      if (url === TOKEN_URL) return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 });
      if (url === USERINFO_URL) return identityFetch(url, init);
      throw new Error("unrouted synthetic login HTTP request");
    };
  }

  for (const [field, value, kind] of [
    ["device_code", undefined, "authRequired"], ["user_code", "", "authRequired"],
    ["verification_uri", undefined, "authRequired"], ["verification_uri_complete", undefined, "authRequired"],
    ["expires_in", undefined, "authRequired"], ["expires_in", 0, "authRequired"],
    ["expires_in", -1, "authRequired"], ["expires_in", "900", "authRequired"],
    ["interval", undefined, "authRequired"], ["interval", 0, "authRequired"], ["interval", -1, "authRequired"],
    ["verification_uri", "http://auth.x.ai/device", "malformedPayload"],
    ["verification_uri", "https://auth.x.ai.evil.invalid/device", "malformedPayload"],
    ["verification_uri_complete", "https://grok.com/device", "malformedPayload"],
  ] as const) {
    test(`retains strict device validation for ${field}=${String(value)}`, async () => {
      const fetcher = mockFetcher({
        [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: TOKEN_URL } },
        [`POST ${DEVICE_AUTHORIZATION_URL}`]: { status: 200, body: {
          device_code: "synthetic-device", user_code: "SYNTHETIC",
          verification_uri: "https://auth.x.ai/device", verification_uri_complete: "https://auth.x.ai/device?user_code=SYNTHETIC",
          expires_in: 900, interval: 5, [field]: value,
        } },
      });
      await expectKind(() => loginXaiOauth("device", {}, { onEvent: () => {} }, new AbortController().signal, {
        fetcher, now: () => NOW_MS,
      }), kind);
      expect(fetcher.calls.map(call => call.url)).toEqual([DISCOVERY_URL, DEVICE_AUTHORIZATION_URL]);
    });
  }

  for (const endpoint of ["http://auth.x.ai/token", "https://auth.x.ai.evil.invalid/token", "https://grok.com/token"]) {
    test(`does not send refresh credentials to unpinned discovery endpoint ${endpoint}`, async () => {
      const fetcher = mockFetcher({ [`GET ${DISCOVERY_URL}`]: { status: 200, body: { token_endpoint: endpoint } } });
      await expectKind(() => xaiOauthConnector.fetchUsage({
        request: usageRequest({ credential: oauthCredential({ expiresAtMs: null }) }), fetcher, nowMs: NOW_MS,
      }), "malformedPayload");
      expect(fetcher.calls.map(call => call.url)).toEqual([DISCOVERY_URL]);
    });
  }

  test("bounds optional identity independently and retains minted login tokens on identity timeout", async () => {
    const parent = new AbortController();
    const deadline = new AbortController();
    const requested: number[] = [];
    let observedAbort = false;
    const deps = {
      now: () => NOW_MS,
      identityTimeoutSignal: (ms: number) => { requested.push(ms); return deadline.signal; },
      fetcher: loginFetcher(async (_url, init) => {
        init.signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
        deadline.abort(new DOMException("synthetic identity deadline", "TimeoutError"));
        init.signal?.throwIfAborted();
        return Response.json({ email: "should-not-arrive@example.invalid" });
      }),
    };
    const result = await loginXaiOauth("device", {}, { onEvent: () => {} }, parent.signal, deps);
    expect(requested).toEqual([15_000]);
    expect(observedAbort).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    expect(result.accountLabel).toBeUndefined();
    expect(result.credential).toMatchObject({ oauth: { access: ACCESS, refresh: REFRESH, expiresAtMs: NOW_MS + 3_600_000 - SKEW_MS } });
  });

  for (const phase of ["headers", "body"] as const) {
    test(`does not swallow parent cancellation during optional identity ${phase}`, async () => {
      const parent = new AbortController();
      let observedAbort = false;
      const fetcher = loginFetcher(async (_url, init) => {
        init.signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
        if (phase === "body") return new Response(new ReadableStream({
          pull(controller) {
            parent.abort();
            controller.error(new DOMException("cancelled during body", "AbortError"));
          },
        }));
        parent.abort();
        init.signal?.throwIfAborted();
        return Response.json({});
      });
      await expectKind(() => loginXaiOauth("device", {}, { onEvent: () => {} }, parent.signal, { fetcher, now: () => NOW_MS }), "timeout");
      expect(observedAbort).toBe(true);
    });
  }
});

describe("xAI native transport and cancellation controls", () => {
  for (const endpoint of [USERINFO_URL, TOKEN_URL, CREDITS_URL]) {
    test(`native fetch rejects credential-bearing redirects from ${endpoint}`, async () => {
      let targetHits = 0;
      let sourceHits = 0;
      const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/source") {
            sourceHits += 1;
            return new Response(null, { status: 307, headers: { location: "/target" } });
          }
          targetHits += 1;
          return Response.json({});
        },
      });
      try {
        const fetcher: Fetcher = async (url, init) => {
          if (url === endpoint) return fetch(new URL("source", server.url), init);
          if (url === DISCOVERY_URL) return Response.json({ token_endpoint: TOKEN_URL });
          if (url === TOKEN_URL) return Response.json({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 });
          if (url === USERINFO_URL) return Response.json({});
          if (url === CREDITS_URL) return Response.json(WEEKLY_PAYLOAD);
          if (url === MONTHLY_URL) return Response.json(MONTHLY_PAYLOAD);
          throw new Error("unrouted native-fetch test request");
        };
        const action = () => xaiOauthConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ expiresAtMs: null }) }), fetcher, nowMs: NOW_MS,
        });
        if (endpoint === TOKEN_URL) await expectKind(action, "transport");
        else {
          const response = await action();
          expect(response.report.windows).toEqual(endpoint === CREDITS_URL ? MONTHLY_WINDOWS : WEEKLY_WINDOWS);
        }
        expect(sourceHits).toBe(1);
        expect(targetHits).toBe(0);
      } finally {
        await server.stop(true);
      }
    });
  }

  for (const scenario of ["identity-timeout", "identity-cancel", "billing-cancel"] as const) {
    test(`preserves rotation and parent deadline semantics on ${scenario}`, async () => {
      const parent = new AbortController();
      const identityDeadline = new AbortController();
      const durations: number[] = [];
      const connector = createXaiOauthConnector(ms => {
        durations.push(ms);
        return durations.length === 1 ? parent.signal : identityDeadline.signal;
      });
      const calls: string[] = [];
      let observedAbort = false;
      const fetcher: Fetcher = async (url, init) => {
        calls.push(url);
        if (url === DISCOVERY_URL) return Response.json({ token_endpoint: TOKEN_URL });
        if (url === TOKEN_URL) return Response.json({ access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 });
        if (url === USERINFO_URL || url === CREDITS_URL) {
          const trigger = scenario === "billing-cancel" ? url === CREDITS_URL : url === USERINFO_URL;
          if (trigger) {
            init.signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
            (scenario === "identity-timeout" ? identityDeadline : parent).abort(new DOMException("synthetic deadline", "TimeoutError"));
            init.signal?.throwIfAborted();
          }
          return Response.json(url === CREDITS_URL ? WEEKLY_PAYLOAD : {});
        }
        throw new Error("fallback after parent cancellation");
      };
      const request = usageRequest({ credential: oauthCredential({ expiresAtMs: null }) });
      const action = () => connector.fetchUsage({ request, fetcher, nowMs: NOW_MS });
      if (scenario === "identity-timeout") {
        const response = await action();
        expect(response.report.windows).toEqual(WEEKLY_WINDOWS);
        expect(response.refreshedCredential).toMatchObject({ oauth: { access: ACCESS_2, refresh: REFRESH_2 } });
        expect(parent.signal.aborted).toBe(false);
      } else {
        const error = await expectKind(action, "timeout");
        expect(error.refreshedCredential).toMatchObject({ oauth: { access: ACCESS_2, refresh: REFRESH_2 } });
        expect(calls).not.toContain(MONTHLY_URL);
        if (scenario === "identity-cancel") expect(calls).not.toContain(CREDITS_URL);
      }
      expect(observedAbort).toBe(true);
      expect(durations).toEqual([request.deadlineAtMs - NOW_MS, 15_000]);
    });
  }
});
