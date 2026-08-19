import { afterEach, describe, expect, test } from "bun:test";
import { alibabaTokenPlanAuth, alibabaTokenPlanConnector } from "../src/providers/alibaba-token-plan";
import { BridgeError } from "../src/protocol";
import type { BridgeRequest } from "../src/protocol";
import type { AuthEvent, AuthEvents, AuthPrompt, LoginRequest } from "../src/dispatch";
import type { LoginInputs } from "../src/dispatch";
import { buildLoginRequest, buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";
import type { MockFetcher, RecordedCall } from "./helpers";

const NOW_MS = 1787011200500;
const PROVIDER = "alibaba-token-plan";
const CONNECTOR_VERSION = "alibaba-token-plan-1";
const USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const CN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const INTL_BASE_URL = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

const INTL_SESSION_URL = "https://home.qwencloud.com/tool/user/info.json";
const INTL_USAGE_URL =
  "https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage";
const CHINA_SESSION_URL = "https://bailian.console.aliyun.com/cn-beijing?tab=plan";
const CHINA_USAGE_URL =
  "https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage";

const API_TOKEN = "sk-sp-unit-token-1";
const INTL_COOKIE = "login_aliyunid_csrf=csrf-unit-42; locale=en-US; t=intl-session";
const CHINA_COOKIE = "t=cn-session; csrf=cn-csrf-7";
const INTL_SEC_TOKEN = "sec-token-intl-7";

const INTL_SESSION_BODY = {
  code: "0",
  data: { secToken: INTL_SEC_TOKEN, userId: "123456", loginId: "demo@example.com" },
};

/** Realistic gateway shape: data.Data is a JSON string wrapping DataV2.data. */
const INTL_USAGE_PAYLOAD = {
  successResponse: true,
  data: {
    Data: JSON.stringify({
      DataV2: {
        data: {
          per5HourPercentage: "42.5",
          per5HourResetTime: 1787013000,
          per1WeekPercentage: 86,
          per1WeekResetTime: 1787529600000,
        },
      },
    }),
  },
};

const INTL_CORNERSTONE = {
  domain: "home.qwencloud.com",
  consoleSite: "QWENCLOUD",
  console: "ONE_CONSOLE",
  xsp_lang: "en-US",
  protocol: "V2",
  productCode: "p_efm",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function usageRequest(secret: string): BridgeRequest {
  return buildUsageRequest({
    providerId: PROVIDER,
    connectorId: PROVIDER,
    credential: { kind: "apiKey", secret },
  });
}

const INTL_REQUEST = usageRequest(JSON.stringify({ token: API_TOKEN, cookie: INTL_COOKIE }));
const CHINA_REQUEST = usageRequest(JSON.stringify({ token: API_TOKEN, cookie: CHINA_COOKIE, baseUrl: CN_BASE_URL }));

function runUsage(fetcher: Fetcher, request: BridgeRequest = INTL_REQUEST) {
  return alibabaTokenPlanConnector.fetchUsage({ request, fetcher, nowMs: NOW_MS });
}

function intlFetcher(usageStatus: number, usageBody?: unknown, usageHeaders?: Record<string, string>): MockFetcher {
  return mockFetcher([
    { when: `GET ${INTL_SESSION_URL}`, respond: { status: 200, body: INTL_SESSION_BODY } },
    {
      when: `POST ${INTL_USAGE_URL}`,
      respond: {
        status: usageStatus,
        ...(usageBody === undefined ? {} : { body: usageBody }),
        ...(usageHeaders === undefined ? {} : { headers: usageHeaders }),
      },
    },
  ]);
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

describe("alibaba-token-plan connector — international happy path", () => {
  test("hits the QwenCloud session and gateway endpoints with the OMP request shape", async () => {
    const fetcher = intlFetcher(200, INTL_USAGE_PAYLOAD);
    const response = await runUsage(fetcher);

    const calls = fetcher.calls;
    if (calls.length !== 2) {
      throw new Error(`expected two upstream calls, got ${calls.length}`);
    }
    const [sessionCall, usageCall] = calls as [RecordedCall, RecordedCall];

    // Exact upstream URLs.
    expect(sessionCall.method).toBe("GET");
    expect(sessionCall.url).toBe(INTL_SESSION_URL);
    expect(usageCall.method).toBe("POST");
    expect(usageCall.url).toBe(INTL_USAGE_URL);
    expect(usageCall.url).toContain(`api=${encodeURIComponent(USAGE_API)}`);

    // Session headers.
    const sessionHeaders = new Headers(sessionCall.init.headers);
    expect(sessionHeaders.get("accept")).toBe("application/json, text/plain, */*");
    expect(sessionHeaders.get("cookie")).toBe(INTL_COOKIE);
    expect(sessionHeaders.get("referer")).toBe("https://home.qwencloud.com/");
    expect(sessionHeaders.get("user-agent")).toBe(BROWSER_USER_AGENT);
    expect(sessionCall.init.signal).toBeInstanceOf(AbortSignal);

    // Gateway headers: browser-session auth via Cookie + CSRF, never Authorization.
    const usageHeaders = new Headers(usageCall.init.headers);
    expect(usageHeaders.get("authorization")).toBeNull();
    expect(usageHeaders.get("cookie")).toBe(INTL_COOKIE);
    expect(usageHeaders.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(usageHeaders.get("origin")).toBe("https://home.qwencloud.com");
    expect(usageHeaders.get("referer")).toBe("https://home.qwencloud.com/billing/subscription/token-plan-individual");
    expect(usageHeaders.get("x-xsrf-token")).toBe("csrf-unit-42");
    expect(usageHeaders.get("x-csrf-token")).toBe("csrf-unit-42");
    expect(usageHeaders.get("x-requested-with")).toBe("XMLHttpRequest");
    expect(usageHeaders.get("user-agent")).toBe(BROWSER_USER_AGENT);

    // Gateway body: form params in OMP order with the wrapped gateway params JSON.
    const body = new URLSearchParams(String(usageCall.init.body));
    expect([...body.keys()]).toEqual(["product", "action", "region", "sec_token", "params"]);
    expect(body.get("product")).toBe("sfm_bailian");
    expect(body.get("action")).toBe("IntlBroadScopeAspnGateway");
    expect(body.get("region")).toBe("ap-southeast-1");
    expect(body.get("sec_token")).toBe(INTL_SEC_TOKEN);
    expect(JSON.parse(body.get("params") ?? "{}")).toEqual({
      Api: USAGE_API,
      Data: { cornerstoneParam: INTL_CORNERSTONE },
      V: "1.0",
    });

    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(INTL_REQUEST.requestId);
    expect(response.connectorId).toBe(PROVIDER);
    expect(response.completedAtMs).toBe(NOW_MS);
    expect(response.refreshedCredential).toBeUndefined();
    expectNoModelFields(response);
  });

  test("maps the gateway percentages to the OMP 5h/7d percent windows", async () => {
    const response = await runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD));

    expect(response.report.productKind).toBe("quota");
    expect(response.report.sourceKind).toBe("browserSession");
    expect(response.report.connectorVersion).toBe(CONNECTOR_VERSION);
    expect(response.report.fetchedAtMs).toBe(NOW_MS);
    expect(response.report.windows.map((window) => window.id)).toEqual(["credits:5h", "credits:7d"]);

    const fiveHour = response.report.windows[0]!;
    expect(fiveHour.label).toBe("5 Hour Credits");
    expect(fiveHour.unit).toBe("percent");
    expect(fiveHour.resolvedFraction).toBeCloseTo(0.425, 12);
    expect(fiveHour.used).toBeCloseTo(42.5, 10);
    expect(fiveHour.severity).toBe("ok");
    expect(fiveHour.resetsAtMs).toBe(1787013000000);
    expect(fiveHour.limit).toBeUndefined();

    const sevenDay = response.report.windows[1]!;
    expect(sevenDay.label).toBe("7 Day Credits");
    expect(sevenDay.unit).toBe("percent");
    expect(sevenDay.resolvedFraction).toBeCloseTo(0.86, 12);
    expect(sevenDay.used).toBeCloseTo(86, 10);
    expect(sevenDay.severity).toBe("warning");
    expect(sevenDay.resetsAtMs).toBe(1787529600000);
    expect(sevenDay.limit).toBeUndefined();
  });

  test("keeps the credential secret out of the serialized response", async () => {
    const response = await runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD));
    const encoded = JSON.stringify(response);
    expect(encoded).not.toContain(API_TOKEN);
    expect(encoded).not.toContain(INTL_COOKIE);
  });
});

describe("alibaba-token-plan connector — China region", () => {
  test("parses SEC_TOKEN from the console HTML page and posts to the bailian gateway", async () => {
    const chinaHtml =
      '<!doctype html><html><script>window.__INITIAL_STATE__ = { SEC_TOKEN : "sec-token-cn-9", userId: 654321 };</script></html>';
    const calls: RecordedCall[] = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ method: init.method ?? "GET", url, init });
      if (url === CHINA_SESSION_URL) {
        return new Response(chinaHtml, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      if (url === CHINA_USAGE_URL) {
        return new Response(
          JSON.stringify({
            successResponse: true,
            data: { DataV2: { data: { per5HourPercentage: 100, per1WeekPercentage: "73.5" } } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url: ${url}`);
    };

    const response = await runUsage(fetcher, CHINA_REQUEST);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${CHINA_SESSION_URL}`,
      `POST ${CHINA_USAGE_URL}`,
    ]);
    const sessionHeaders = new Headers(calls[0]!.init.headers);
    expect(sessionHeaders.get("accept")).toBe("text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8");
    expect(sessionHeaders.get("referer")).toBe("https://bailian.console.aliyun.com/");

    const usageHeaders = new Headers(calls[1]!.init.headers);
    expect(usageHeaders.get("origin")).toBe("https://bailian.console.aliyun.com");
    expect(usageHeaders.get("referer")).toBe("https://bailian.console.aliyun.com/cn-beijing?tab=plan");
    // China cookie has no login_aliyunid_csrf; the plain csrf cookie is used.
    expect(usageHeaders.get("x-xsrf-token")).toBe("cn-csrf-7");

    const body = new URLSearchParams(String(calls[1]!.init.body));
    expect(body.get("action")).toBe("BroadScopeAspnGateway");
    expect(body.get("region")).toBe("cn-beijing");
    expect(body.get("sec_token")).toBe("sec-token-cn-9");
    const params = JSON.parse(body.get("params") ?? "{}") as {
      Api: string;
      Data: { cornerstoneParam: Record<string, unknown> };
      V: string;
    };
    expect(params.Api).toBe(USAGE_API);
    expect(params.V).toBe("1.0");
    expect(String(params.Data.cornerstoneParam["feTraceId"])).toMatch(UUID_PATTERN);
    expect(params.Data.cornerstoneParam).toEqual({
      feTraceId: params.Data.cornerstoneParam["feTraceId"],
      feURL: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
      protocol: "V2",
      console: "ONE_CONSOLE",
      productCode: "p_efm",
      switchAgent: 12608464,
      switchUserType: 3,
      domain: "bailian.console.aliyun.com",
      consoleSite: "BAILIAN_ALIYUN",
      userNickName: "",
      userPrincipalName: "",
      xsp_lang: "zh-CN",
    });

    expect(response.report.windows.map((window) => [window.id, window.severity])).toEqual([
      ["credits:5h", "exhausted"],
      ["credits:7d", "ok"],
    ]);
    expect(response.report.windows[0]!.resolvedFraction).toBe(1);
    expect(response.report.windows[1]!.resolvedFraction).toBeCloseTo(0.735, 12);
  });
});

describe("alibaba-token-plan connector — error branches", () => {
  test("maps a gateway 401 to authRequired", async () => {
    const error = await bridgeErrorFrom(() => runUsage(intlFetcher(401, { message: "not signed in" })));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(INTL_COOKIE);
  });

  test("maps a session 401 to authRequired", async () => {
    const fetcher = mockFetcher([
      { when: `GET ${INTL_SESSION_URL}`, respond: { status: 401, body: { code: "401" } } },
    ]);
    expect((await bridgeErrorFrom(() => runUsage(fetcher))).kind).toBe("authRequired");
  });

  test("maps a 429 with Retry-After to rateLimited with retryAfterMs", async () => {
    const error = await bridgeErrorFrom(() => runUsage(intlFetcher(429, { message: "slow" }, { "retry-after": "30" })));
    expect(error.kind).toBe("rateLimited");
    expect(error.retryAfterMs).toBe(30000);
  });

  test("maps a non-JSON gateway body to malformedPayload", async () => {
    const fetcher: Fetcher = async (url) => {
      if (url === INTL_SESSION_URL) {
        return new Response(JSON.stringify(INTL_SESSION_BODY), { status: 200 });
      }
      return new Response("<html>sign in</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    };
    expect((await bridgeErrorFrom(() => runUsage(fetcher))).kind).toBe("malformedPayload");
  });

  test("maps a payload without utilization windows to noData", async () => {
    const fetcher = intlFetcher(200, { successResponse: true, data: { DataV2: { data: {} } } });
    expect((await bridgeErrorFrom(() => runUsage(fetcher))).kind).toBe("noData");
  });

  test("maps successResponse:false to noData", async () => {
    const fetcher = intlFetcher(200, { successResponse: false, data: {} });
    expect((await bridgeErrorFrom(() => runUsage(fetcher))).kind).toBe("noData");
  });

  test("keeps a single usable window instead of failing the whole report", async () => {
    const fetcher = intlFetcher(200, {
      successResponse: true,
      data: { data: { per1WeekPercentage: "12.5", per1WeekResetTime: 1787529600 } },
    });
    const response = await runUsage(fetcher);
    expect(response.report.windows.map((window) => window.id)).toEqual(["credits:7d"]);
    expect(response.report.windows[0]!.resolvedFraction).toBeCloseTo(0.125, 12);
    expect(response.report.windows[0]!.resetsAtMs).toBe(1787529600000);
  });

  test("maps a session payload without secToken to noData", async () => {
    const fetcher = mockFetcher([
      { when: `GET ${INTL_SESSION_URL}`, respond: { status: 200, body: { code: "0", data: {} } } },
    ]);
    expect((await bridgeErrorFrom(() => runUsage(fetcher))).kind).toBe("noData");
  });

  test("maps a China session page without SEC_TOKEN to noData", async () => {
    const fetcher: Fetcher = async (url) => {
      if (url === CHINA_SESSION_URL) {
        return new Response("<html>login page</html>", { status: 200 });
      }
      throw new Error(`unexpected url: ${url}`);
    };
    expect((await bridgeErrorFrom(() => runUsage(fetcher, CHINA_REQUEST))).kind).toBe("noData");
  });

  test("maps a fetch failure to transport", async () => {
    const fetcher = mockFetcher([]);
    expect((await bridgeErrorFrom(() => runUsage(fetcher))).kind).toBe("transport");
  });

  test("rejects a credential without the browser cookie with invalidPolicy", async () => {
    const request = usageRequest(JSON.stringify({ token: API_TOKEN }));
    const error = await bridgeErrorFrom(() => runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD), request));
    expect(error.kind).toBe("invalidPolicy");
    expect(error.message).toBe("alibaba-token-plan usage requires the browser cookie credential");
  });

  test("rejects a bare-token credential with invalidPolicy", async () => {
    const error = await bridgeErrorFrom(() => runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD), usageRequest(API_TOKEN)));
    expect(error.kind).toBe("invalidPolicy");
    expect(error.message).toBe("alibaba-token-plan usage requires the browser cookie credential");
  });

  test("rejects an unparsable or non-apiKey credential with invalidPolicy", async () => {
    const unparsable = await bridgeErrorFrom(() =>
      runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD), usageRequest("not-a-token{")),
    );
    expect(unparsable.kind).toBe("invalidPolicy");
    const bearer = await bridgeErrorFrom(() =>
      runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD), {
        ...INTL_REQUEST,
        credential: { kind: "bearer", secret: API_TOKEN },
      }),
    );
    expect(bearer.kind).toBe("invalidPolicy");
  });

  test("rejects an absent credential with missingCredential", async () => {
    const request: BridgeRequest = {
      schemaVersion: "1.2.0",
      requestId: "00000000-0000-4000-8000-000000000009",
      operation: "fetchUsage",
      providerId: PROVIDER,
      connectorId: PROVIDER,
      accountRef: "00000000-0000-4000-8000-000000000010",
      requestedAtMs: 1787011200000,
      deadlineAtMs: 1787011210000,
    };
    expect((await bridgeErrorFrom(() => runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD), request))).kind).toBe(
      "missingCredential",
    );
  });

  test("rejects a foreign providerId with invalidProvider", async () => {
    const request = buildUsageRequest({
      providerId: "anthropic",
      connectorId: PROVIDER,
      credential: { kind: "apiKey", secret: JSON.stringify({ token: API_TOKEN, cookie: INTL_COOKIE }) },
    });
    expect((await bridgeErrorFrom(() => runUsage(intlFetcher(200, INTL_USAGE_PAYLOAD), request))).kind).toBe(
      "invalidProvider",
    );
  });
});

// --- Login ---

type FetchCall = { readonly url: string; readonly init: RequestInit };

const originalFetch = globalThis.fetch;
const fetchCalls: FetchCall[] = [];

function stubFetch(respond: (url: string) => Response | undefined): void {
  fetchCalls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, init: init ?? {} });
    const response = respond(url);
    if (response === undefined) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function okModels(): Response {
  return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
}

async function runLogin(request: LoginRequest): Promise<{ result: Awaited<ReturnType<typeof alibabaTokenPlanAuth.login>>; events: AuthEvent[] }> {
  const events: AuthEvent[] = [];
  const controller = new AbortController();
  const result = await alibabaTokenPlanAuth.login(
    request.method,
    request.inputs ?? {},
    { onEvent: (event) => events.push(event) },
    controller.signal,
  );
  return { result, events };
}

function loginRequest(inputs: LoginInputs): LoginRequest {
  return buildLoginRequest({ providerId: PROVIDER, inputs });
}

describe("alibaba-token-plan auth — apiKey login", () => {
  test("serializes the international credential exactly like OMP and validates against /models", async () => {
    stubFetch((url) => (url === `${INTL_BASE_URL}/models` ? okModels() : undefined));

    const { result, events } = await runLogin(
      loginRequest({ apiKey: ` ${API_TOKEN} `, cookieHeader: `Cookie: ${INTL_COOKIE}` }),
    );

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.init.method).toBeUndefined();
    expect(new Headers(fetchCalls[0]!.init.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);

    expect(result.credential).toEqual({
      kind: "apiKey",
      secret: JSON.stringify({ token: API_TOKEN, cookie: INTL_COOKIE }),
    });
    expect(result.accountLabel).toBeUndefined();

    expect(events[0]).toEqual({
      type: "openUrl",
      url: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
    });
    expect(events[1]).toEqual({ type: "waiting", detail: "Validating API key..." });
    expect(events[2]?.type).toBe("pasteHint");
    expect(events[2]?.type === "pasteHint" ? events[2].detail : "").toContain("cs-data.qwencloud.com");
  });

  test("pins the China region: auth URL, CN /models validation and persisted baseUrl", async () => {
    stubFetch((url) => (url === `${CN_BASE_URL}/models` ? okModels() : undefined));

    const { result, events } = await runLogin(
      loginRequest({ apiKey: API_TOKEN, apiBaseUrl: CN_BASE_URL, cookieHeader: CHINA_COOKIE }),
    );

    expect(fetchCalls[0]?.url).toBe(`${CN_BASE_URL}/models`);
    expect(result.credential).toEqual({
      kind: "apiKey",
      secret: JSON.stringify({ token: API_TOKEN, cookie: CHINA_COOKIE, baseUrl: CN_BASE_URL }),
    });
    expect(events[0]).toEqual({ type: "openUrl", url: "https://www.aliyun.com/benefit/scene/tokenplan" });
    expect(events[2]?.type === "pasteHint" ? events[2].detail : "").toContain("bailian-cs.console.aliyun.com");
  });

  test("persists a trimmed custom region and defaults its auth URL to international", async () => {
    const customBase = "https://token-plan.cn-north-2.maas.aliyuncs.com/compatible-mode/v1";
    stubFetch((url) => (url === `${customBase}/models` ? okModels() : undefined));

    const { result, events } = await runLogin(
      loginRequest({ apiKey: API_TOKEN, apiBaseUrl: `${customBase}/`, cookieHeader: INTL_COOKIE }),
    );

    expect(fetchCalls[0]?.url).toBe(`${customBase}/models`);
    expect(result.credential).toEqual({
      kind: "apiKey",
      secret: JSON.stringify({ token: API_TOKEN, cookie: INTL_COOKIE, baseUrl: customBase }),
    });
    expect(events[0]).toEqual({
      type: "openUrl",
      url: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
    });
  });

  test("rejects an unencrypted custom base URL before sending the API key", async () => {
    stubFetch(() => okModels());
    const error = await bridgeErrorFrom(() =>
      runLogin(loginRequest({
        apiKey: API_TOKEN,
        apiBaseUrl: "http://token-plan.example.test/v1",
        cookieHeader: INTL_COOKIE,
      })),
    );

    expect(error.kind).toBe("invalidRequest");
    expect(error.message).toContain("HTTPS");
    expect(fetchCalls).toHaveLength(0);
  });

  test("stores the bare token when no cookie is supplied and the region is default", async () => {
    stubFetch(() => okModels());
    const { result } = await runLogin(loginRequest({ apiKey: API_TOKEN }));
    expect(result.credential).toEqual({ kind: "apiKey", secret: API_TOKEN });
  });

  test("rejects a cookie that is not a complete name=value header", async () => {
    stubFetch(() => okModels());
    const error = await bridgeErrorFrom(() =>
      runLogin(loginRequest({ apiKey: API_TOKEN, cookieHeader: "csrf-unit-42-only-value" })),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(error.message).toContain("cs-data.qwencloud.com");
    expect(error.message).not.toContain("csrf-unit-42-only-value");
  });

  test("rejects a missing API key before any network call", async () => {
    stubFetch(() => okModels());
    const error = await bridgeErrorFrom(() => runLogin(loginRequest({ cookieHeader: INTL_COOKIE })));
    expect(error.kind).toBe("invalidRequest");
    expect(fetchCalls).toHaveLength(0);
  });

  test("rejects login methods other than apiKey", async () => {
    stubFetch(() => okModels());
    const error = await bridgeErrorFrom(() =>
      runLogin(buildLoginRequest({ providerId: PROVIDER, method: "browser", inputs: {} })),
    );
    expect(error.kind).toBe("invalidRequest");
  });

  test("maps a failed key validation to authRequired without leaking the key", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 }));
    const error = await bridgeErrorFrom(() => runLogin(loginRequest({ apiKey: API_TOKEN })));
    expect(error.kind).toBe("authRequired");
    expect(error.message).not.toContain(API_TOKEN);
  });

  test("maps an aborted login to a timeout with a cancelled message", async () => {
    stubFetch(() => okModels());
    const events: AuthEvent[] = [];
    const controller = new AbortController();
    controller.abort();
    const error = await bridgeErrorFrom(() =>
      alibabaTokenPlanAuth.login("apiKey", { apiKey: API_TOKEN }, { onEvent: (event) => events.push(event) }, controller.signal),
    );
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("cancelled");
    expect(fetchCalls).toHaveLength(0);
  });
});

// --- Duplex prompts (OMP onPrompt flow mapped onto events.requestInput) ---

const REGION_PROMPT =
  "Select QwenCloud Token Plan region: 1=International (default), 2=China (Beijing), 3=Custom — enter 1, 2, or 3";
const CUSTOM_URL_PROMPT = "Enter custom Token Plan base URL";
const API_KEY_PROMPT = "Paste your QwenCloud Token Plan API key";
const INTL_COOKIE_PROMPT =
  "Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the cs-data.qwencloud.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.";
const CHINA_COOKIE_PROMPT =
  "Optional quota reporting: open browser DevTools → Network, reload the Token Plan page, filter for api.json, and select the bailian-cs.console.aliyun.com/data/api.json request whose api query ends in /tokenplan/personal/api/v2/usage. Copy Request Headers → Cookie, then paste the complete name=value; ... value here, or press Enter to skip.";

describe("alibaba-token-plan auth — duplex prompts", () => {
  test("requests region, key and cookie over the duplex channel when inputs are missing", async () => {
    stubFetch((url) => (url === `${INTL_BASE_URL}/models` ? okModels() : undefined));
    const events: AuthEvent[] = [];
    const prompts: AuthPrompt[] = [];
    const answers = ["", `  ${API_TOKEN}  `, INTL_COOKIE];
    let index = 0;
    const result = await alibabaTokenPlanAuth.login(
      "apiKey",
      {},
      {
        onEvent: (event) => events.push(event),
        requestInput: async (prompt) => {
          prompts.push(prompt);
          const answer = answers[index++];
          if (answer === undefined) throw new Error("scripted duplex answers ran out");
          return answer;
        },
      },
      new AbortController().signal,
    );

    expect(prompts).toEqual([
      { prompt: REGION_PROMPT, inputKind: "apiBaseUrl", sensitive: false },
      { prompt: API_KEY_PROMPT, inputKind: "text", sensitive: true },
      { prompt: INTL_COOKIE_PROMPT, inputKind: "cookieHeader", sensitive: true },
    ]);
    expect(events).toEqual([
      { type: "openUrl", url: "https://home.qwencloud.com/billing/subscription/token-plan-individual" },
      { type: "waiting", detail: "Validating API key..." },
      { type: "pasteHint", detail: INTL_COOKIE_PROMPT },
    ]);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(`${INTL_BASE_URL}/models`);
    expect(new Headers(fetchCalls[0]?.init.headers).get("authorization")).toBe(`Bearer ${API_TOKEN}`);
    expect(result.credential).toEqual({
      kind: "apiKey",
      secret: JSON.stringify({ token: API_TOKEN, cookie: INTL_COOKIE }),
    });
  });

  test("menu choice 2 pins China: CN auth URL, CN /models validation, CN cookie prompt", async () => {
    stubFetch((url) => (url === `${CN_BASE_URL}/models` ? okModels() : undefined));
    const events: AuthEvent[] = [];
    const prompts: AuthPrompt[] = [];
    const answers = ["2", API_TOKEN, CHINA_COOKIE];
    let index = 0;
    const result = await alibabaTokenPlanAuth.login(
      "apiKey",
      {},
      {
        onEvent: (event) => events.push(event),
        requestInput: async (prompt) => {
          prompts.push(prompt);
          const answer = answers[index++];
          if (answer === undefined) throw new Error("scripted duplex answers ran out");
          return answer;
        },
      },
      new AbortController().signal,
    );

    expect(prompts.map((prompt) => prompt.prompt)).toEqual([REGION_PROMPT, API_KEY_PROMPT, CHINA_COOKIE_PROMPT]);
    expect(prompts[2]).toEqual({ prompt: CHINA_COOKIE_PROMPT, inputKind: "cookieHeader", sensitive: true });
    expect(events[0]).toEqual({ type: "openUrl", url: "https://www.aliyun.com/benefit/scene/tokenplan" });
    expect(fetchCalls[0]?.url).toBe(`${CN_BASE_URL}/models`);
    expect(result.credential).toEqual({
      kind: "apiKey",
      secret: JSON.stringify({ token: API_TOKEN, cookie: CHINA_COOKIE, baseUrl: CN_BASE_URL }),
    });
  });

  test("menu choice 3 follows up with the custom-URL prompt and persists the trimmed region", async () => {
    const customBase = "https://token-plan.eu-central-1.maas.aliyuncs.com/compatible-mode/v1";
    stubFetch((url) => (url === `${customBase}/models` ? okModels() : undefined));
    const prompts: AuthPrompt[] = [];
    const answers = ["3", `${customBase}/`, API_TOKEN, ""];
    let index = 0;
    const result = await alibabaTokenPlanAuth.login(
      "apiKey",
      {},
      {
        onEvent: () => {},
        requestInput: async (prompt) => {
          prompts.push(prompt);
          const answer = answers[index++];
          if (answer === undefined) throw new Error("scripted duplex answers ran out");
          return answer;
        },
      },
      new AbortController().signal,
    );

    expect(prompts.map((prompt) => prompt.prompt)).toEqual([
      REGION_PROMPT,
      CUSTOM_URL_PROMPT,
      API_KEY_PROMPT,
      INTL_COOKIE_PROMPT,
    ]);
    expect(prompts[1]).toEqual({ prompt: CUSTOM_URL_PROMPT, inputKind: "apiBaseUrl", sensitive: false });
    expect(fetchCalls[0]?.url).toBe(`${customBase}/models`);
    expect(result.credential).toEqual({
      kind: "apiKey",
      secret: JSON.stringify({ token: API_TOKEN, baseUrl: customBase }),
    });
  });

  test("rejects an empty custom URL for option 3 before any network call", async () => {
    stubFetch(() => okModels());
    const answers = ["3", "   "];
    let index = 0;
    const error = await bridgeErrorFrom(() =>
      alibabaTokenPlanAuth.login(
        "apiKey",
        {},
        {
          onEvent: () => {},
          requestInput: async () => {
            const answer = answers[index++];
            if (answer === undefined) throw new Error("scripted duplex answers ran out");
            return answer;
          },
        },
        new AbortController().signal,
      ),
    );
    expect(error.kind).toBe("invalidRequest");
    expect(error.message).toContain("Custom URL is required for option 3");
    expect(fetchCalls).toHaveLength(0);
  });

  test("a non-menu region answer falls back to International exactly like OMP's else branch", async () => {
    stubFetch((url) => (url === `${INTL_BASE_URL}/models` ? okModels() : undefined));
    const answers = ["9", API_TOKEN, ""];
    let index = 0;
    const result = await alibabaTokenPlanAuth.login(
      "apiKey",
      {},
      {
        onEvent: () => {},
        requestInput: async () => {
          const answer = answers[index++];
          if (answer === undefined) throw new Error("scripted duplex answers ran out");
          return answer;
        },
      },
      new AbortController().signal,
    );
    expect(fetchCalls[0]?.url).toBe(`${INTL_BASE_URL}/models`);
    expect(result.credential).toEqual({ kind: "apiKey", secret: API_TOKEN });
  });
});
