import { describe, expect, test } from "bun:test";
import { githubCopilotAuth, githubCopilotConnector, loginGitHubCopilot } from "../src/providers/github-copilot";
import { BridgeError } from "../src/protocol";
import type { BridgeErrorKind, OAuthCredential } from "../src/protocol";
import type { AuthEvent } from "../src/dispatch";
import type { Fetcher } from "../src/connectors/provider-http";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";
import type { MockRouteRule } from "./helpers";

const TOKEN = "ghp_unit-test-token-do-not-use";
const NOW_MS = 1787011200500;
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const BILLING_URL = "https://api.github.com/users/octocat/settings/billing/premium_request/usage";
const QUOTA_URL = "https://api.github.com/copilot_internal/user";
const CLIENT_ID = "Ov23li8tweQw6odWQebz";
/** OMP FAR_FUTURE_MS: 10 years from login (virtual) now. */
const FAR_FUTURE_MS = 10 * 365.25 * 24 * 60 * 60 * 1000;

const BILLING_BODY = {
  timePeriod: { year: 2026, month: 8 },
  user: "octocat",
  usageItems: [
    {
      product: "Copilot",
      sku: "Copilot Premium Request",
      model: "GPT-5",
      unitType: "requests",
      netQuantity: 25,
    },
    {
      product: "Copilot",
      sku: "Copilot Premium Request",
      model: "Claude Sonnet 4.5",
      unitType: "requests",
      netQuantity: 20,
    },
  ],
};

const DEVICE_CODE_BODY = {
  device_code: "dc_test",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval: 5,
  expires_in: 300,
};

/** OMP-shaped /copilot_internal/user payload: limited premium, unlimited chat, limited completions. */
const QUOTA_BODY = {
  copilot_plan: "business",
  quota_reset_date: "2026-09-01T00:00:00Z",
  quota_snapshots: {
    premium_interactions: {
      entitlement: 300,
      overage_count: 2,
      overage_permitted: true,
      percent_remaining: 40,
      quota_id: "premium_requests",
      quota_remaining: 120,
      remaining: 120,
      unlimited: false,
    },
    chat: {
      entitlement: 0,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 100,
      quota_id: "chat_requests",
      quota_remaining: 0,
      remaining: 0,
      unlimited: true,
    },
    completions: {
      entitlement: 2000,
      overage_count: 0,
      overage_permitted: false,
      percent_remaining: 75,
      quota_id: "completions",
      quota_remaining: 1500,
      remaining: 1500,
      unlimited: false,
    },
  },
};

function usageRequest(overrides: Parameters<typeof buildUsageRequest>[0] = {}) {
  return buildUsageRequest({
    providerId: "github-copilot",
    connectorId: "github-copilot",
    credential: { kind: "bearer", secret: TOKEN },
    ...overrides,
  });
}

function oauthCredential(oauth: Partial<OAuthCredential["oauth"]> = {}): OAuthCredential {
  return {
    kind: "oauth",
    secret: oauth.refresh ?? "gho_oauth_refresh_unit",
    oauth: {
      access: oauth.access ?? "gho_oauth_access_unit",
      refresh: oauth.refresh ?? "gho_oauth_refresh_unit",
      ...oauth,
    },
  };
}

function billingFetcher() {
  return mockFetcher({
    [`GET ${USER_URL}`]: { status: 200, body: { login: "octocat" } },
    [`GET ${BILLING_URL}`]: { status: 200, body: BILLING_BODY },
  });
}

/** Virtual OMP clock: sleep records the wait and advances the clock. */
function virtualClock(startMs = NOW_MS): {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly sleeps: number[];
} {
  const state = { nowMs: startMs, sleeps: [] as number[] };
  return {
    now: () => state.nowMs,
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      state.nowMs += ms;
    },
    sleeps: state.sleeps,
  };
}

/** A token-endpoint response sequence: matched in order, the last one repeats. */
function tokenResponses(
  responses: ReadonlyArray<{ body: Record<string, unknown> }>,
): { readonly rules: readonly MockRouteRule[] } {
  // A single ticker rule counts polls; exactly one predicate may mutate the
  // counter or first-match ordering breaks with double increments.
  let call = 0;
  const isTokenPoll = (method: string, url: string) => method === "POST" && url === ACCESS_TOKEN_URL;
  return {
    rules: [
      { when: (method, url) => (isTokenPoll(method, url) ? ((call += 1), false) : false), respond: { status: 599, body: {} } },
      ...responses.slice(0, -1).map((response, index) => ({
        when: (method: string, url: string) => isTokenPoll(method, url) && call === index + 1,
        respond: { status: 200, body: response.body },
      })),
      {
        when: (method: string, url: string) => isTokenPoll(method, url) && call >= responses.length,
        respond: { status: 200, body: responses[responses.length - 1]?.body ?? {} },
      },
    ],
  };
}

async function expectKind(actions: () => Promise<unknown>, kind: BridgeErrorKind): Promise<BridgeError> {
  try {
    await actions();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).kind).toBe(kind);
    return error as BridgeError;
  }
  throw new Error(`expected BridgeError ${kind}`);
}

describe("githubCopilotConnector", () => {
  test("delegates the documented billing route to premium-requests-monthly", async () => {
    expect(githubCopilotConnector.providerId).toBe("github-copilot");
    expect(githubCopilotConnector.connectorVersion).toBe("github-copilot-1");

    const fetcher = billingFetcher();
    const request = usageRequest();
    const response = await githubCopilotConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${USER_URL}`,
      `GET ${BILLING_URL}`,
    ]);
    const identityHeaders = new Headers(fetcher.calls[0]?.init.headers);
    const billingHeaders = new Headers(fetcher.calls[1]?.init.headers);
    expect(identityHeaders.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(billingHeaders.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(billingHeaders.get("accept")).toBe("application/vnd.github+json");

    expect(response.status).toBe("ok");
    expect(response.providerId).toBe("github-copilot");
    expect(response.report.productKind).toBe("billingUsage");
    expect(response.report.sourceKind).toBe("documentedApi");
    expect(response.report.connectorVersion).toBe("github-billing-1");
    expect(response.report.windows).toEqual([
      {
        id: "premium-requests-monthly",
        label: "Premium requests (monthly)",
        unit: "requests",
        used: 45,
        severity: "unknown",
      },
    ]);
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect(JSON.stringify(response)).not.toContain("GPT-5");
    expectNoModelFields(response);
  });

  test("routes an apiKey-kind credential to the documented billing connector", async () => {
    const fetcher = billingFetcher();
    const response = await githubCopilotConnector.fetchUsage({
      request: usageRequest({ credential: { kind: "apiKey", secret: TOKEN } }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls.map((call) => call.url)).toEqual([USER_URL, BILLING_URL]);
    expect(response.report.productKind).toBe("billingUsage");
    expect(response.report.sourceKind).toBe("documentedApi");
    expect(response.report.windows[0]?.id).toBe("premium-requests-monthly");
    expectNoModelFields(response);
  });

  test("falls back from billing failure to the Copilot quota endpoint for a real token", async () => {
    const fetcher = mockFetcher({
      [`GET ${USER_URL}`]: { status: 200, body: { login: "octocat" } },
      [`GET ${BILLING_URL}`]: { status: 500, body: { message: "billing unavailable" } },
      [`GET ${QUOTA_URL}`]: { status: 200, body: QUOTA_BODY },
    });

    const response = await githubCopilotConnector.fetchUsage({
      request: usageRequest(),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => call.url)).toEqual([
      USER_URL,
      BILLING_URL,
      QUOTA_URL,
    ]);
    expect(response.status).toBe("ok");
    expect(response.report.productKind).toBe("quota");
    expect(response.report.sourceKind).toBe("privateApi");
    expect(response.report.windows.map((window) => window.id)).toContain("copilot:premium");
    expect(JSON.stringify(response)).not.toContain(TOKEN);
  });

  test("rejects the wrong provider and a missing credential", async () => {
    const fetcher = billingFetcher();
    await expectKind(
      () => githubCopilotConnector.fetchUsage({ request: usageRequest({ providerId: "other" }), fetcher, nowMs: NOW_MS }),
      "invalidProvider",
    );
    const { credential: _credential, ...missing } = usageRequest();
    await expectKind(
      () => githubCopilotConnector.fetchUsage({ request: missing, fetcher, nowMs: NOW_MS }),
      "missingCredential",
    );
  });

  test("rejects an oauth credential without any token with missingCredential", async () => {
    const fetcher = billingFetcher();
    await expectKind(
      () =>
        githubCopilotConnector.fetchUsage({
          request: usageRequest({
            credential: { kind: "oauth", secret: "", oauth: { access: "" } },
          }),
          fetcher,
          nowMs: NOW_MS,
        }),
      "missingCredential",
    );
    expect(fetcher.calls).toHaveLength(0);
  });

  test("maps 401 to authRequired", async () => {
    const fetcher = mockFetcher({
      [`GET ${USER_URL}`]: { status: 401, body: { message: "Bad credentials" } },
    });
    const error = await expectKind(
      () => githubCopilotConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "authRequired",
    );
    expect(error.message).not.toContain(TOKEN);
  });

  test("maps 429 with Retry-After to rateLimited", async () => {
    const fetcher = mockFetcher({
      [`GET ${USER_URL}`]: { status: 429, headers: { "retry-after": "30" }, body: { message: "slow down" } },
    });
    const error = await expectKind(
      () => githubCopilotConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "rateLimited",
    );
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("maps a non-JSON body to malformedPayload", async () => {
    const fetcher: Fetcher = async () => new Response("not-json", { status: 200 });
    await expectKind(
      () => githubCopilotConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "malformedPayload",
    );
  });

  test("maps a billing report with no request rows to noData", async () => {
    const fetcher = mockFetcher({
      [`GET ${USER_URL}`]: { status: 200, body: { login: "octocat" } },
      [`GET ${BILLING_URL}`]: { status: 200, body: { usageItems: [] } },
    });
    await expectKind(
      () => githubCopilotConnector.fetchUsage({ request: usageRequest(), fetcher, nowMs: NOW_MS }),
      "noData",
    );
  });
});

describe("githubCopilotConnector — oauth quota route (OMP /copilot_internal/user)", () => {
  test("normalizes quota snapshots over the exact upstream call and headers", async () => {
    const fetcher = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: QUOTA_BODY } });
    const response = await githubCopilotConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential() }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${QUOTA_URL}`]);
    const headers = new Headers(fetcher.calls[0]?.init.headers);
    // OMP fetchInternalUsage: the GitHub token (refresh ?? access) rides Bearer
    // with the OpenCode UA and JSON accepts.
    expect(headers.get("authorization")).toBe("Bearer gho_oauth_refresh_unit");
    expect(headers.get("user-agent")).toBe("opencode/1.3.15");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(fetcher.calls[0]?.init.body).toBeUndefined();
    expect(fetcher.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);

    expect(response.status).toBe("ok");
    expect(response.report.productKind).toBe("quota");
    expect(response.report.sourceKind).toBe("privateApi");
    expect(response.report.connectorVersion).toBe("github-copilot-1");
    expect(response.report.fetchedAtMs).toBe(NOW_MS);
    // Chat is unlimited -> dropped (OMP rule); premium and completions carry
    // used/limit/fraction from entitlement and remaining.
    expect(response.report.windows).toEqual([
      {
        id: "copilot:premium",
        label: "Premium Requests",
        unit: "requests",
        resolvedFraction: 180 / 300,
        severity: "ok",
        used: 180,
        limit: 300,
        resetsAtMs: Date.parse("2026-09-01T00:00:00Z"),
      },
      {
        id: "copilot:completions",
        label: "Completions",
        unit: "requests",
        resolvedFraction: 500 / 2000,
        severity: "ok",
        used: 500,
        limit: 2000,
        resetsAtMs: Date.parse("2026-09-01T00:00:00Z"),
      },
    ]);
    expect(response.refreshedCredential).toBeUndefined();
    expectNoModelFields(response);
    expect(JSON.stringify(response)).not.toContain("gho_oauth_refresh_unit");
    expect(JSON.stringify(response)).not.toContain("gho_oauth_access_unit");
  });

  test("keeps fractions nil for unlimited snapshots and exhausted/warning bands", async () => {
    const fetcher = mockFetcher({
      [`GET ${QUOTA_URL}`]: {
        status: 200,
        body: {
          copilot_plan: "pro",
          quota_reset_date: "2026-09-01T00:00:00Z",
          quota_snapshots: {
            premium_interactions: {
              entitlement: 100,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 100,
              quota_id: "premium_requests",
              quota_remaining: 100,
              remaining: 100,
              unlimited: true,
            },
            completions: {
              entitlement: 100,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 3,
              quota_id: "completions",
              quota_remaining: 3,
              remaining: 3,
              unlimited: false,
            },
            chat: {
              entitlement: 100,
              overage_count: 0,
              overage_permitted: false,
              percent_remaining: 0,
              quota_id: "chat",
              quota_remaining: 0,
              remaining: 0,
              unlimited: false,
            },
          },
        },
      },
    });
    const response = await githubCopilotConnector.fetchUsage({
      request: usageRequest({ credential: oauthCredential() }),
      fetcher,
      nowMs: NOW_MS,
    });
    // Unlimited stays nil on every amount and severity stays ok (OMP deriveStatus).
    const premium = response.report.windows.find((window) => window.id === "copilot:premium");
    expect(premium).toEqual({
      id: "copilot:premium",
      label: "Premium Requests",
      unit: "requests",
      severity: "ok",
      resetsAtMs: Date.parse("2026-09-01T00:00:00Z"),
    });
    // 97% used -> remainingFraction 0.03 -> warning; 100% used -> exhausted.
    const completions = response.report.windows.find((window) => window.id === "copilot:completions");
    expect(completions?.severity).toBe("warning");
    const chat = response.report.windows.find((window) => window.id === "copilot:chat");
    expect(chat?.severity).toBe("exhausted");
    expect(chat?.resolvedFraction).toBe(1);
  });

  test("derives the enterprise API base URL from the credential identity", async () => {
    const enterprise = "https://api.ghe.corp.example/copilot_internal/user";
    const fetcher = mockFetcher({ [`GET ${enterprise}`]: { status: 200, body: QUOTA_BODY } });
    await githubCopilotConnector.fetchUsage({
      request: usageRequest({
        credential: oauthCredential({ identity: { enterpriseUrl: "ghe.corp.example" } }),
      }),
      fetcher,
      nowMs: NOW_MS,
    });
    expect(fetcher.calls[0]?.url).toBe(enterprise);
  });

  test("maps quota route failures to the typed status map", async () => {
    const unauthorized = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 401, body: { message: "no" } } });
    await expectKind(
      () =>
        githubCopilotConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential() }),
          fetcher: unauthorized,
          nowMs: NOW_MS,
        }),
      "authRequired",
    );

    const nonObject = mockFetcher({ [`GET ${QUOTA_URL}`]: { status: 200, body: "text" } });
    await expectKind(
      () =>
        githubCopilotConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential() }),
          fetcher: nonObject,
          nowMs: NOW_MS,
        }),
      "malformedPayload",
    );

    const empty = mockFetcher({
      [`GET ${QUOTA_URL}`]: { status: 200, body: { copilot_plan: "pro", quota_snapshots: {} } },
    });
    await expectKind(
      () =>
        githubCopilotConnector.fetchUsage({
          request: usageRequest({ credential: oauthCredential() }),
          fetcher: empty,
          nowMs: NOW_MS,
        }),
      "noData",
    );
  });
});

describe("githubCopilotAuth", () => {
  test("stores a trimmed PAT as a bearer credential", async () => {
    expect(githubCopilotAuth.providerId).toBe("github-copilot");
    expect(githubCopilotAuth.methods).toEqual(["apiKey", "device"]);

    const events: AuthEvent[] = [];
    const request = buildLoginRequest({
      providerId: "github-copilot",
      method: "apiKey",
      inputs: { apiKey: "  ghp_pasted  " },
    });
    const result = await githubCopilotAuth.login(
      request.method,
      request.inputs ?? {},
      { onEvent: (event) => events.push(event) },
      new AbortController().signal,
    );
    expect(result).toEqual({ credential: { kind: "bearer", secret: "ghp_pasted" } });
    expect(events).toEqual([
      { type: "pasteHint", detail: "Paste a GitHub personal access token with Copilot access." },
    ]);
  });

  test("rejects an empty PAT and maps abort to timeout", async () => {
    await expectKind(
      () => githubCopilotAuth.login("apiKey", { apiKey: "  " }, { onEvent: () => {} }, new AbortController().signal),
      "invalidRequest",
    );
    const controller = new AbortController();
    controller.abort();
    const error = await expectKind(
      () => githubCopilotAuth.login("apiKey", { apiKey: "ghp_x" }, { onEvent: () => {} }, controller.signal),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
    expect(error.message).not.toContain("ghp_x");
  });

  test("device login waits first at the OMP cadence and returns an oauth-origin credential", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${DEVICE_CODE_URL}`, respond: { status: 200, body: DEVICE_CODE_BODY } },
      ...tokenResponses([
        { body: { error: "authorization_pending" } },
        { body: { access_token: "ghu_test", token_type: "bearer", scope: "read:user" } },
      ]).rules,
    ]);
    const clock = virtualClock();
    const events: AuthEvent[] = [];
    const request = buildLoginRequest({ method: "device", inputs: {} });
    const result = await loginGitHubCopilot(
      request.method,
      request.inputs ?? {},
      { onEvent: (event) => events.push(event) },
      new AbortController().signal,
      { fetcher, now: clock.now, sleep: clock.sleep },
    );

    // OMP cadence: wait ceil(interval 5000 * 1.2) = 6000 before each of the
    // two polls (pending, then success). The credential mints at the virtual
    // now (advanced 12s by the two waits) plus the 10-year OMP horizon.
    expect(clock.sleeps).toEqual([6000, 6000]);
    expect(result).toEqual({
      credential: {
        kind: "oauth",
        secret: "ghu_test",
        oauth: {
          access: "ghu_test",
          refresh: "ghu_test",
          expiresAtMs: NOW_MS + 12_000 + FAR_FUTURE_MS,
          clientId: CLIENT_ID,
        },
      },
    });
    expect(events).toEqual([
      { type: "openUrl", url: "https://github.com/login/device?user_code=ABCD-1234" },
      { type: "code", code: "ABCD-1234", verificationUrl: "https://github.com/login/device" },
      { type: "waiting", detail: "Enter code: ABCD-1234" },
    ]);

    expect(fetcher.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${DEVICE_CODE_URL}`,
      `POST ${ACCESS_TOKEN_URL}`,
      `POST ${ACCESS_TOKEN_URL}`,
    ]);
    const deviceHeaders = new Headers(fetcher.calls[0]?.init.headers);
    expect(deviceHeaders.get("accept")).toBe("application/json");
    expect(deviceHeaders.get("content-type")).toBe("application/json");
    expect(deviceHeaders.get("user-agent")).toBe("opencode/1.3.15");
    expect(JSON.parse(String(fetcher.calls[0]?.init.body))).toEqual({
      client_id: CLIENT_ID,
      scope: "read:user",
    });
    expect(JSON.parse(String(fetcher.calls[1]?.init.body))).toEqual({
      client_id: CLIENT_ID,
      device_code: "dc_test",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    // Every request is deadline-abortable: each carries an AbortSignal.
    for (const call of fetcher.calls) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("device login applies the OMP slow_down interval and 1.4 multiplier", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${DEVICE_CODE_URL}`, respond: { status: 200, body: DEVICE_CODE_BODY } },
      ...tokenResponses([
        { body: { error: "authorization_pending" } },
        { body: { error: "slow_down", interval: 9 } },
        { body: { access_token: "ghu_test" } },
      ]).rules,
    ]);
    const clock = virtualClock();
    const result = await loginGitHubCopilot(
      "device",
      {},
      { onEvent: () => {} },
      new AbortController().signal,
      { fetcher, now: clock.now, sleep: clock.sleep },
    );

    // 6000 (5s * 1.2), 6000 (pending), then slow_down resets the interval to
    // the server's 9s and the multiplier to 1.4: ceil(9000 * 1.4) = 12600.
    expect(clock.sleeps).toEqual([6000, 6000, 12_600]);
    expect(result.credential.kind).toBe("oauth");
  });

  test("device login without a server interval adds 5s on slow_down", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${DEVICE_CODE_URL}`, respond: { status: 200, body: DEVICE_CODE_BODY } },
      ...tokenResponses([
        { body: { error: "authorization_pending" } },
        { body: { error: "slow_down" } },
        { body: { access_token: "ghu_test" } },
      ]).rules,
    ]);
    const clock = virtualClock();
    await loginGitHubCopilot("device", {}, { onEvent: () => {} }, new AbortController().signal, {
      fetcher,
      now: clock.now,
      sleep: clock.sleep,
    });
    // slow_down without an interval field: 5000 + 5000 = 10000, * 1.4 = 14000.
    expect(clock.sleeps).toEqual([6000, 6000, 14_000]);
  });

  test("device login stores the enterprise host in the credential identity", async () => {
    const fetcher = mockFetcher([
      {
        when: (method, url) => method === "POST" && url === "https://ghe.corp.example/login/device/code",
        respond: { status: 200, body: DEVICE_CODE_BODY },
      },
      {
        when: (method, url) => method === "POST" && url === "https://ghe.corp.example/login/oauth/access_token",
        respond: { status: 200, body: { access_token: "ghu_enterprise" } },
      },
    ]);
    const result = await loginGitHubCopilot(
      "device",
      { enterpriseHost: "https://ghe.corp.example" },
      { onEvent: () => {} },
      new AbortController().signal,
      { fetcher, ...virtualClock() },
    );
    if (result.credential.kind !== "oauth") {
      throw new Error("expected an oauth credential");
    }
    expect(result.credential.oauth.identity).toEqual({ enterpriseUrl: "ghe.corp.example" });
  });

  test("device login cancellation mid-poll aborts with a cancelled timeout", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${DEVICE_CODE_URL}`, respond: { status: 200, body: DEVICE_CODE_BODY } },
      { when: `POST ${ACCESS_TOKEN_URL}`, respond: { status: 200, body: { error: "authorization_pending" } } },
    ]);
    const controller = new AbortController();
    const clock = virtualClock();
    const abortingSleep = async (ms: number): Promise<void> => {
      clock.sleeps.push(ms);
      controller.abort(new Error("user closed the terminal"));
    };
    const error = await expectKind(
      () =>
        loginGitHubCopilot("device", {}, { onEvent: () => {} }, controller.signal, {
          fetcher,
          now: clock.now,
          sleep: abortingSleep,
        }),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
    expect(fetcher.calls).toHaveLength(2);
  });

  test("device login never hangs: a stalled poll request aborts with the login signal", async () => {
    const controller = new AbortController();
    const stalls: string[] = [];
    const fetcher: Fetcher = async (url, init) => {
      if (url === DEVICE_CODE_URL) {
        return new Response(JSON.stringify(DEVICE_CODE_BODY), { status: 200 });
      }
      stalls.push(url);
      const pending = new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
      // The login deadline fires while the token poll is in flight.
      controller.abort();
      return await pending;
    };
    const clock = virtualClock();
    const error = await expectKind(
      () =>
        loginGitHubCopilot("device", {}, { onEvent: () => {} }, controller.signal, {
          fetcher,
          now: clock.now,
          sleep: clock.sleep,
        }),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
    expect(stalls).toEqual([ACCESS_TOKEN_URL]);
  });

  test("device login settles when a poll fetcher ignores abort", async () => {
    const fetcher: Fetcher = async url => {
      if (url === DEVICE_CODE_URL) {
        return new Response(JSON.stringify(DEVICE_CODE_BODY), { status: 200 });
      }
      return await new Promise<Response>(() => {});
    };
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 10);
    const login = loginGitHubCopilot("device", {}, { onEvent: () => {} }, controller.signal, {
      fetcher,
      sleep: async () => {},
    });
    const outcome = await Promise.race([
      login.then(
        () => "resolved",
        error => error,
      ),
      Bun.sleep(250).then(() => "test-timeout"),
    ]);
    clearTimeout(abortTimer);

    expect(outcome).not.toBe("test-timeout");
    expect(outcome).toBeInstanceOf(BridgeError);
    if (!(outcome instanceof BridgeError)) {
      throw new Error("expected a BridgeError");
    }
    expect(outcome.kind).toBe("timeout");
    expect(outcome.message).toContain("cancelled");
  });

  test("device login never hangs: a stalled device-code request aborts with the login signal", async () => {
    const controller = new AbortController();
    const fetcher: Fetcher = async (url, init) => {
      expect(url).toBe(DEVICE_CODE_URL);
      const pending = new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
      // The deadline fires while the device-code request is in flight.
      controller.abort();
      return await pending;
    };
    const error = await expectKind(
      () =>
        loginGitHubCopilot("device", {}, { onEvent: () => {} }, controller.signal, {
          fetcher,
          ...virtualClock(),
        }),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
  });

  test("device login timeout after the expires_in deadline", async () => {
    const fetcher = mockFetcher([
      {
        when: `POST ${DEVICE_CODE_URL}`,
        respond: { status: 200, body: { ...DEVICE_CODE_BODY, expires_in: 1 } },
      },
      { when: `POST ${ACCESS_TOKEN_URL}`, respond: { status: 200, body: { error: "authorization_pending" } } },
    ]);
    const clock = virtualClock();
    const error = await expectKind(
      () =>
        loginGitHubCopilot("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: clock.now,
          sleep: clock.sleep,
        }),
      "timeout",
    );
    expect(error.message).toBe("Device flow timed out");
    // The wait is capped at the remaining deadline time.
    expect(clock.sleeps).toEqual([1000]);
  });

  test("device login timeout after slow_down carries the clock-drift hint", async () => {
    const fetcher = mockFetcher([
      {
        when: `POST ${DEVICE_CODE_URL}`,
        respond: { status: 200, body: { ...DEVICE_CODE_BODY, expires_in: 8 } },
      },
      ...tokenResponses([
        { body: { error: "authorization_pending" } },
        { body: { error: "slow_down" } },
      ]).rules,
    ]);
    const clock = virtualClock();
    const error = await expectKind(
      () =>
        loginGitHubCopilot("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          now: clock.now,
          sleep: clock.sleep,
        }),
      "timeout",
    );
    expect(error.message).toContain("clock drift");
    // 6000 (initial), then the capped 2000ms remainder; the deadline expires
    // before a third poll.
    expect(clock.sleeps).toEqual([6000, 2000]);
  });

  test("device login maps a terminal polling error to authRequired", async () => {
    const fetcher = mockFetcher([
      { when: `POST ${DEVICE_CODE_URL}`, respond: { status: 200, body: DEVICE_CODE_BODY } },
      {
        when: `POST ${ACCESS_TOKEN_URL}`,
        respond: {
          status: 200,
          body: { error: "access_denied", error_description: "The user denied the request" },
        },
      },
    ]);
    const error = await expectKind(
      () =>
        loginGitHubCopilot("device", {}, { onEvent: () => {} }, new AbortController().signal, {
          fetcher,
          ...virtualClock(),
        }),
      "authRequired",
    );
    expect(error.message).toBe("Device flow failed: access_denied: The user denied the request");
  });

  test("device login maps a pre-aborted signal to timeout", async () => {
    const fetcher = mockFetcher({
      [`POST ${DEVICE_CODE_URL}`]: { status: 200, body: DEVICE_CODE_BODY },
    });
    const controller = new AbortController();
    controller.abort();
    const error = await expectKind(
      () => loginGitHubCopilot("device", {}, { onEvent: () => {} }, controller.signal, { fetcher }),
      "timeout",
    );
    expect(error.message).toContain("cancelled");
    expect(fetcher.calls).toHaveLength(0);
  });

  test("rejects an unknown login method with invalidRequest", async () => {
    await expectKind(
      () => githubCopilotAuth.login("browser", {}, { onEvent: () => {} }, new AbortController().signal),
      "invalidRequest",
    );
  });
});
