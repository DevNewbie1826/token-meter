import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiCodeAuth, kimiCodeConnector, loginKimiCode } from "../src/providers/kimi-code";
import { BridgeError } from "../src/protocol";
import type { BridgeCredential, BridgeErrorKind, UsageWindow } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import type { Fetcher } from "../src/connectors/provider-http";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";
import type { MockResponse, RecordedCall } from "./helpers";

// Keep the install device-id file (X-Msh-Device-Id) inside a temp dir so the
// suite never touches the real ~/.omp/agent and stays deterministic.
const agentDir = mkdtempSync(join(tmpdir(), "kimi-code-test-agent-"));
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
process.env["PI_CODING_AGENT_DIR"] = agentDir;
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
  else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const NOW_MS = 1787011200500;
const ACCESS = "kimi-first-access";
const REFRESH = "kimi-first-refresh";
const ACCESS_2 = "kimi-second-access";
const REFRESH_2 = "kimi-second-refresh";
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_AUTHORIZATION_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;
const RESET_ISO = "2026-08-16T00:00:00Z";

/** Realistic OMP-shaped Kimi usages payload: aggregate + three limit spans. */
const USAGE_PAYLOAD = {
  usage: { name: "Weekly Quota", used: 40, limit: 100, reset_time: RESET_ISO },
  limits: [
    {
      name: "Kimi Code 5h quota",
      detail: { used: 9, limit: 10, remaining: 1, reset_at: NOW_MS + 3_600_000 },
      window: { duration: 300, timeUnit: "time_unit_minute", ttl: 5400 },
    },
    { detail: { limit: 5 }, window: { duration: 1, timeUnit: "time_unit_day" } },
    { used: 2, limit: 2, reset_in: 1800 },
  ],
};

const EXPECTED_WINDOWS: readonly UsageWindow[] = [
  {
    id: "kimi:7d",
    label: "Weekly Quota",
    unit: "unknown",
    resolvedFraction: 0.4,
    severity: "ok",
    used: 40,
    limit: 100,
    resetsAtMs: Date.parse(RESET_ISO),
  },
  {
    // 300 time_unit_minute canonicalizes to the 5h burst span; the span
    // window's ttl reset wins over the detail row's reset_at (OMP rule).
    id: "kimi:5h",
    label: "Kimi Code 5h quota",
    unit: "unknown",
    resolvedFraction: 0.9,
    severity: "warning",
    used: 9,
    limit: 10,
    resetsAtMs: NOW_MS + 5_400_000,
  },
  {
    id: "kimi:1d",
    label: "1d limit",
    unit: "unknown",
    severity: "unknown",
    limit: 5,
  },
  {
    // No span window: row-level reset_in applies and the id falls to default.
    id: "kimi:default",
    label: "Limit #3",
    unit: "unknown",
    resolvedFraction: 1,
    severity: "exhausted",
    used: 2,
    limit: 2,
    resetsAtMs: NOW_MS + 1_800_000,
  },
];

function jsonResponse(body: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, ...(headers !== undefined ? { headers } : {}) });
}

type OAuthOverrides = {
  readonly access?: string;
  readonly refresh?: string | null;
  readonly expiresAtMs?: number | null;
  readonly identity?: Record<string, string>;
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
    providerId: "kimi-code",
    connectorId: "kimi-code",
    credential: oauthCredential({ expiresAtMs: NOW_MS + 3_600_000 }),
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

function makeAccessToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.unit-signature`;
}

describe("kimiCodeConnector", () => {
  test("fetches usages with Bearer access and maps the OMP normalization", async () => {
    expect(kimiCodeConnector.providerId).toBe("kimi-code");
    expect(kimiCodeConnector.connectorVersion).toBe("kimi-code-1");

    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD } });
    const response = await kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${USAGE_URL}`]);
    const headers = new Headers(fetcher.calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headers.get("user-agent")).toBe("KimiCLI/17.3.7");
    expect(headers.get("x-msh-platform")).toBe("kimi_cli");
    expect(headers.get("x-msh-version")).toBe("17.3.7");
    expect(headers.get("x-msh-device-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(headers.get("x-msh-device-model")).not.toBe("");
    expect(headers.get("x-msh-device-name")).not.toBe("");
    expect(headers.get("x-msh-os-version")).not.toBe("");

    expect(response.status).toBe("ok");
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();
    expect(response.report).toEqual({
      productKind: "quota",
      sourceKind: "firstPartyApi",
      fetchedAtMs: NOW_MS,
      connectorVersion: "kimi-code-1",
      windows: EXPECTED_WINDOWS,
    });
    expect(JSON.stringify(response)).not.toContain(ACCESS);
    expectNoModelFields(response);
  });

  test("uses protocol warning severity for an 81 percent Kimi window", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 200,
        body: {
          usage: {
            name: "Weekly Quota",
            used: 81,
            limit: 100,
            reset_time: RESET_ISO,
          },
          limits: [],
        },
      },
    });

    const response = await kimiCodeConnector.fetchUsage({
      request: usageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(response.report.windows[0]?.resolvedFraction).toBe(0.81);
    expect(response.report.windows[0]?.severity).toBe("warning");
  });

  test("rejects the wrong provider and missing credential, while accepting an API key", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD } });
    await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest({ providerId: "other" }), fetcher, nowMs: NOW_MS }),
      "invalidProvider",
    );
    const { credential: _credential, ...missing } = usageRequest();
    await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: missing, fetcher, nowMs: NOW_MS }),
      "missingCredential",
    );
    const response = await kimiCodeConnector.fetchUsage({
      request: usageRequest({ credential: { kind: "apiKey", secret: "km-secret" } }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(response.status).toBe("ok");
    expect(new Headers(fetcher.calls.at(-1)?.init.headers).get("authorization")).toBe("Bearer km-secret");
  });

  test("maps 401 to authRequired when no refresh material exists", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 401, body: { error: "unauthorized" } } });
    const error = await expectKind(
      () =>
        kimiCodeConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ refresh: null, expiresAtMs: NOW_MS + 3_600_000 }) }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "authRequired",
    );
    expect(error.message).not.toContain(ACCESS);
  });

  test("maps 429 with Retry-After to rateLimited", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { error: "slow_down" } },
    });
    const error = await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("projects authenticated Kimi code 1308 as an exhausted 5h quota window", async () => {
    const resetText = "2026-08-19 18:48:46";
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 429,
        body: {
          code: "1308",
          message: `Usage limit reached for 5 hour. Your limit will reset at ${resetText}`,
        },
      },
    });

    const response = await kimiCodeConnector.fetchUsage({
      request: usageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(response.status).toBe("ok");
    expect(response.report.windows).toEqual([
      {
        id: "kimi:5h",
        label: "5h limit",
        unit: "unknown",
        resolvedFraction: 1,
        severity: "exhausted",
        resetsAtMs: new Date(2026, 7, 19, 18, 48, 46).getTime(),
      },
    ]);
    expect(JSON.stringify(response)).not.toContain(ACCESS);
    expect(JSON.stringify(response)).not.toContain("Usage limit reached");
  });

  test.each([
    ["array code", { code: ["1308"], message: "Usage limit reached for 5 hour. Your limit will reset at 2026-08-19 18:48:46" }],
    ["object code", { code: { value: "1308" }, message: "Usage limit reached for 5 hour. Your limit will reset at 2026-08-19 18:48:46" }],
    ["null code", { code: null, message: "Usage limit reached for 5 hour. Your limit will reset at 2026-08-19 18:48:46" }],
    ["wrong message", { code: "1308", message: "Quota exhausted" }],
    ["invalid date", { code: "1308", message: "Usage limit reached for 5 hour. Your limit will reset at 2026-02-31 18:48:46" }],
  ] as const)("keeps malformed Kimi 1308 %s on the generic rate-limit path", async (_label, body) => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: {
        status: 429,
        headers: { "retry-after": "12" },
        body,
      },
    });

    const error = await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(12_000);
  });

  test("keeps a non-JSON Kimi 429 on the generic rate-limit path", async () => {
    const fetcher: Fetcher = async () =>
      new Response("not-json", {
        status: 429,
        headers: { "retry-after": "12" },
      });

    const error = await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(12_000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher: Fetcher = async () => new Response("not-json", { status: 200 });
    await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "malformedPayload",
    );
  });

  test("maps a non-object JSON body to malformedPayload", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: [1, 2, 3] } });
    await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "malformedPayload",
    );
  });

  test("maps a payload with no usable rows to noData", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { usage: {}, limits: [] } } });
    await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "noData",
    );
  });

  test("pre-rotates when expiresAtMs is missing and returns refreshedCredential", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200 } },
      [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD },
    });
    const response = await kimiCodeConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: null, identity: { accountId: "user-1" } }) }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${USAGE_URL}`,
    ]);
    const refreshHeaders = new Headers(fetcher.calls[0]?.init.headers);
    expect(refreshHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(refreshHeaders.get("x-msh-platform")).toBe("kimi_cli");
    expect(String(fetcher.calls[0]?.init.body)).toBe(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: REFRESH,
        client_id: CLIENT_ID,
      }).toString(),
    );
    expect(new Headers(fetcher.calls[1]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_2}`);

    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH_2,
        // OMP minting rule: now + expires_in - 5-minute skew; opaque new token
        // keeps the previous identity's account id.
        expiresAtMs: NOW_MS + 7_200_000 - OAUTH_EXPIRY_SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
        identity: { accountId: "user-1" },
      },
    });
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expect(JSON.stringify(response)).not.toContain(REFRESH);
    expectNoModelFields(response);
  });

  test("pre-rotates when the token expires within 60s", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 3600 } },
      [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD },
    });
    const response = await kimiCodeConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 30_000 }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${TOKEN_URL}`,
      `GET ${USAGE_URL}`,
    ]);
    expect(response.refreshedCredential).toMatchObject({ kind: "oauth", oauth: { access: ACCESS_2 } });
  });

  test("does not rotate a fresh token", async () => {
    const fetcher = mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD } });
    const response = await kimiCodeConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential({ expiresAtMs: NOW_MS + 600_000 }) }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${USAGE_URL}`]);
    expect(response.refreshedCredential).toBeUndefined();
  });

  test("rotates once and retries once on a mid-flow 401", async () => {
    const calls: RecordedCall[] = [];
    let usageCalls = 0;
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ method: init.method ?? "GET", url, init });
      if (url === TOKEN_URL) {
        return jsonResponse({ access_token: ACCESS_2, expires_in: 3600 }, 200);
      }
      usageCalls += 1;
      return usageCalls === 1 ? jsonResponse({ error: "unauthorized" }, 401) : jsonResponse(USAGE_PAYLOAD, 200);
    };

    const response = await kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${USAGE_URL}`,
      `POST ${TOKEN_URL}`,
      `GET ${USAGE_URL}`,
    ]);
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(new Headers(calls[2]?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_2}`);
    // No refresh_token in the rotation response: OMP keeps the previous one.
    expect(response.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH,
        expiresAtMs: NOW_MS + 3_600_000 - OAUTH_EXPIRY_SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
    expect(response.report.windows).toEqual(EXPECTED_WINDOWS);
    expectNoModelFields(response);
  });

  test("still fails authRequired when the retried usage call 401s again", async () => {
    const calls: RecordedCall[] = [];
    let usageCalls = 0;
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ method: init.method ?? "GET", url, init });
      if (url === TOKEN_URL) {
        return jsonResponse({ access_token: ACCESS_2, expires_in: 3600 }, 200);
      }
      usageCalls += 1;
      return jsonResponse({ error: "unauthorized" }, 401);
    };
    const error = await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "authRequired",
    );
    expect(error.message).not.toContain(ACCESS_2);
    expect(calls).toHaveLength(3);
    // The rotated bundle rides the error envelope so the caller persists it
    // before surfacing the failure — Kimi rotation burns the old refresh token.
    expect(error.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH,
        expiresAtMs: NOW_MS + 3_600_000 - OAUTH_EXPIRY_SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
  });

  test("keeps the pre-rotated credential on the error envelope when the usage call fails afterwards", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { access_token: ACCESS_2, refresh_token: REFRESH_2, expires_in: 7200 } },
      [`GET ${USAGE_URL}`]: { status: 429, headers: { "retry-after": "13" }, body: { error: "slow down" } },
    });
    const error = await expectKind(
      () =>
        kimiCodeConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ expiresAtMs: null }) }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(13_000);
    expect(error.refreshedCredential).toEqual({
      kind: "oauth",
      secret: ACCESS_2,
      oauth: {
        access: ACCESS_2,
        refresh: REFRESH_2,
        expiresAtMs: NOW_MS + 7_200_000 - OAUTH_EXPIRY_SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
    expect(error.message).not.toContain(ACCESS_2);
    expect(error.message).not.toContain(REFRESH_2);
  });

  test("propagates a failing rotation as authRequired without secret material", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 401, body: { error: "unauthorized" } },
      [`POST ${TOKEN_URL}`]: { status: 401, body: { error: "invalid_grant" } },
    });
    const error = await expectKind(
      () => kimiCodeConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "authRequired",
    );
    expect(error.message).toContain("Kimi token refresh");
    expect(error.message).not.toContain(REFRESH);
  });

  test("rejects a rotation response without an access token", async () => {
    const fetcher = mockFetcher({
      [`POST ${TOKEN_URL}`]: { status: 200, body: { refresh_token: REFRESH_2, expires_in: 3600 } },
      [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD },
    });
    await expectKind(
      () =>
        kimiCodeConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential({ expiresAtMs: null }) }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "authRequired",
    );
  });
});

describe("kimiCodeAuth", () => {
  test("offers device and API-key methods", () => {
    expect(kimiCodeAuth.providerId).toBe("kimi-code");
    expect(kimiCodeAuth.methods).toEqual(["device", "apiKey"]);
  });

  test("API-key login validates against the real usage route", async () => {
    const fetcher = mockFetcher({
      [`GET ${USAGE_URL}`]: { status: 200, body: USAGE_PAYLOAD },
    });
    const result = await loginKimiCode(
      "apiKey",
      { apiKey: "kimi-api-key" },
      { onEvent: () => {} },
      new AbortController().signal,
      { fetcher },
    );
    expect(result).toEqual({
      credential: { kind: "apiKey", secret: "kimi-api-key" },
      accountLabel: "Kimi Code API key",
    });
    expect(new Headers(fetcher.calls[0]?.init.headers).get("authorization")).toBe("Bearer kimi-api-key");
  });

  test("device login stores access/refresh/expiry and the JWT account id", async () => {
    const accessToken = makeAccessToken({ user_id: "user-789" });
    const fetcher = mockFetcher({
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_kimi_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?user_code=WDJB-MJHT",
          expires_in: 900,
          interval: 5,
        },
      },
      [`POST ${TOKEN_URL}`]: {
        status: 200,
        body: { access_token: accessToken, refresh_token: "kimi-refresh-login-1", expires_in: 86400, token_type: "bearer" },
      },
    });

    const events: AuthEvent[] = [];
    const request = buildLoginRequest({ providerId: "kimi-code", method: "device", inputs: {} });
    const result = await loginKimiCode(
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
          refresh: "kimi-refresh-login-1",
          expiresAtMs: NOW_MS + 86_400_000 - OAUTH_EXPIRY_SKEW_MS,
          refreshEndpoint: TOKEN_URL,
          clientId: CLIENT_ID,
          identity: { accountId: "user-789" },
        },
      },
      accountLabel: "user-789",
    });

    expect(events).toEqual([
      { type: "openUrl", url: "https://auth.kimi.com/device?user_code=WDJB-MJHT" },
      { type: "code", code: "WDJB-MJHT", verificationUrl: "https://auth.kimi.com/device" },
      { type: "waiting", detail: "Waiting for device authorization..." },
    ]);

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${DEVICE_AUTHORIZATION_URL}`,
      `POST ${TOKEN_URL}`,
    ]);
    const deviceHeaders = new Headers(fetcher.calls[0]?.init.headers);
    expect(deviceHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(deviceHeaders.get("user-agent")).toBe("KimiCLI/17.3.7");
    expect(deviceHeaders.get("x-msh-platform")).toBe("kimi_cli");
    expect(deviceHeaders.get("x-msh-device-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(String(fetcher.calls[0]?.init.body)).toBe(new URLSearchParams({ client_id: CLIENT_ID }).toString());
    expect(String(fetcher.calls[1]?.init.body)).toBe(
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: CLIENT_ID,
        device_code: "dc_kimi_unit",
      }).toString(),
    );
  });

  test("device login polls at the advertised interval after authorization_pending", async () => {
    const accessToken = "kimi-opaque-access-unit";
    const sleepCalls: number[] = [];
    let tokenPolls = 0;
    const fetcher: Fetcher = async (url, init) => {
      if (url === DEVICE_AUTHORIZATION_URL) {
        return jsonResponse(
          {
            device_code: "dc_kimi_unit",
            user_code: "WDJB-MJHT",
            verification_uri: "https://auth.kimi.com/device",
            interval: 5,
            expires_in: 900,
          },
          200,
          { "content-type": "application/x-www-form-urlencoded" },
        );
      }
      expect(init.method).toBe("POST");
      tokenPolls += 1;
      // RFC 8628 §3.5: pending/slow_down are 400-class responses carrying an
      // error code; success arrives as 200 with access_token.
      return tokenPolls === 1
        ? jsonResponse({ error: "authorization_pending" }, 400)
        : jsonResponse({ access_token: accessToken, refresh_token: "kimi-refresh-login-2", expires_in: 3600 }, 200);
    };

    const result = await loginKimiCode(
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
        refresh: "kimi-refresh-login-2",
        expiresAtMs: NOW_MS + 3_600_000 - OAUTH_EXPIRY_SKEW_MS,
        refreshEndpoint: TOKEN_URL,
        clientId: CLIENT_ID,
      },
    });
    expect(result.accountLabel).toBeUndefined();
  });

  test("maps a denied authorization to authRequired", async () => {
    const fetcher = mockFetcher({
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: {
        status: 200,
        body: {
          device_code: "dc_kimi_unit",
          user_code: "WDJB-MJHT",
          verification_uri: "https://auth.kimi.com/device",
          interval: 5,
          expires_in: 900,
        },
      },
      [`POST ${TOKEN_URL}`]: { status: 200, body: { error: "access_denied" } },
    });
    await expectKind(
      () => loginKimiCode("device", {}, { onEvent: () => {} }, new AbortController().signal, { fetcher }),
      "authRequired",
    );
  });

  test("maps a malformed device authorization response to authRequired", async () => {
    const fetcher = mockFetcher({
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: { status: 200, body: { device_code: "dc_kimi_unit", user_code: "WDJB-MJHT" } },
    });
    await expectKind(
      () => loginKimiCode("device", {}, { onEvent: () => {} }, new AbortController().signal, { fetcher }),
      "authRequired",
    );
  });

  test("maps a pre-aborted signal to a cancelled timeout without upstream calls", async () => {
    const fetcher = mockFetcher({
      [`POST ${DEVICE_AUTHORIZATION_URL}`]: { status: 500, body: { error: "boom" } },
    });
    const controller = new AbortController();
    controller.abort();
    const error = await expectKind(
      () => loginKimiCode("device", {}, { onEvent: () => {} }, controller.signal, { fetcher }),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("rejects unsupported login methods", async () => {
    await expectKind(
      () => kimiCodeAuth.login("browser", {}, { onEvent: () => {} }, new AbortController().signal),
      "invalidRequest",
    );
  });
});

describe("Kimi amount wire conformance", () => {
  test("retains a remaining-only row in its independent unknown-unit window", async () => {
    const response = await kimiCodeConnector.fetchUsage({ request: usageRequest(), nowMs: NOW_MS, fetcher: mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { usage: { remaining: 17 } } } }) });
    expect(response.report.windows).toEqual([{ id: "kimi:7d", label: "Total quota", unit: "unknown", remaining: 17, severity: "unknown" }]);
  });
  test("retains over-cap amounts with their exact ratio", async () => {
    const response = await kimiCodeConnector.fetchUsage({ request: usageRequest(), nowMs: NOW_MS, fetcher: mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { usage: { used: 120, limit: 100 } } } }) });
    expect(response.report.windows[0]).toMatchObject({ used: 120, limit: 100, resolvedFraction: 1.2, severity: "exhausted" });
  });
  test.each([{ used: -1, limit: 100 }, { used: 0, limit: 0 }, { remaining: 101, limit: 100 }])("rejects invalid amounts %j", async usage => {
    await expect(kimiCodeConnector.fetchUsage({ request: usageRequest(), nowMs: NOW_MS, fetcher: mockFetcher({ [`GET ${USAGE_URL}`]: { status: 200, body: { usage } } }) })).rejects.toMatchObject({ kind: "malformedPayload" });
  });
});
