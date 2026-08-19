import { describe, expect, test } from "bun:test";
import { lookupAuth, lookupConnector, registerAuth, registerConnector } from "../src/dispatch";
import type { AuthModule, ConnectorModule, LoginRequest } from "../src/dispatch";
import {
  BridgeError,
  CREDENTIAL_KINDS,
  PROTOCOL_FAMILY,
  PROTOCOL_VERSION,
  credentialSecrets,
  encodeBridgeResponse,
  parseBridgeRequest,
  parseLoginRequest,
  parsePromptResponse,
  redactSecrets,
} from "../src/protocol";
import type {
  BridgeCredential,
  BridgeErrorResponse,
  BridgeRequest,
  BridgeResponse,
  BridgeSuccessResponse,
} from "../src/protocol";
import { buildLoginRequest, buildUsageRequest, mockFetcher } from "./helpers";

const OAUTH_CREDENTIAL: BridgeCredential = {
  kind: "oauth",
  secret: "oauth-access-1",
  oauth: {
    access: "oauth-access-1",
    refresh: "oauth-refresh-1",
    expiresAtMs: 1787014800000,
    refreshEndpoint: "https://auth.unit.test/token",
    clientId: "client-1",
    identity: { login: "octocat", accountId: "acct-9" },
  },
};

const SUCCESS_RESPONSE: BridgeSuccessResponse = {
  schemaVersion: PROTOCOL_VERSION,
  requestId: "00000000-0000-4000-8000-000000000001",
  providerId: "fixture",
  connectorId: "fixture",
  accountRef: "00000000-0000-4000-8000-000000000002",
  status: "ok",
  completedAtMs: 1787011200500,
  report: {
    productKind: "quota",
    sourceKind: "localObserved",
    fetchedAtMs: 1787011200000,
    connectorVersion: "fixture-1",
    windows: [],
  },
};

function bridgeErrorFrom(action: () => unknown): BridgeError {
  try {
    action();
  } catch (error) {
    if (error instanceof BridgeError) {
      return error;
    }
    throw new Error(`expected BridgeError, got ${String(error)}`);
  }
  throw new Error("expected BridgeError but the action succeeded");
}

function rawOf(value: unknown): string {
  return JSON.stringify(value);
}

function rawUsageRequest(mutate: (request: BridgeRequest) => unknown): string {
  return rawOf(mutate(buildUsageRequest()));
}

function rawLoginRequest(mutate: (request: LoginRequest) => unknown): string {
  return rawOf(mutate(buildLoginRequest()));
}

describe("protocol constants", () => {
  test("pins the versioned family when the bridge protocol is identified", () => {
    expect(PROTOCOL_VERSION).toBe("1.2.0");
    expect(PROTOCOL_FAMILY).toBe("TokenMeter");
    expect(`${PROTOCOL_FAMILY}/${PROTOCOL_VERSION}`).toBe("TokenMeter/1.2.0");
    expect(CREDENTIAL_KINDS).toEqual(["none", "bearer", "apiKey", "oauth"]);
  });
});

describe("parseBridgeRequest", () => {
  test("accepts the canonical v1 usage request when every locked field is present", () => {
    const request = parseBridgeRequest(rawOf(buildUsageRequest()));
    expect(request).toEqual(buildUsageRequest());
  });

  test("accepts an apiKey credential when the static union arm is used", () => {
    const request = buildUsageRequest({ credential: { kind: "apiKey", secret: "sk-unit" } });
    expect(parseBridgeRequest(rawOf(request))).toEqual(request);
  });

  test("accepts the exact credential-free union arm", () => {
    const request = buildUsageRequest({ credential: { kind: "none" } });
    expect(parseBridgeRequest(rawOf(request))).toEqual(request);
  });

  test("keeps the usage credential optional", () => {
    const { credential: _credential, ...request } = buildUsageRequest();
    expect(parseBridgeRequest(rawOf(request))).toEqual(request);
  });

  test("rejects secret material on the credential-free union arm", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "none", secret: "must-not-exist" },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("accepts a full oauth credential when every bundle field is present", () => {
    const request = buildUsageRequest({ credential: OAUTH_CREDENTIAL });
    const parsed = parseBridgeRequest(rawOf(request));
    expect(parsed).toEqual(request);
    expect(parsed.credential?.kind).toBe("oauth");
  });

  test("accepts a minimal oauth credential when only access is carried", () => {
    const request = buildUsageRequest({
      credential: { kind: "oauth", secret: "oauth-access-1", oauth: { access: "oauth-access-1" } },
    });
    expect(parseBridgeRequest(rawOf(request))).toEqual(request);
  });

  test("rejects unknown top-level fields when strict v1 parsing is applied", () => {
    const raw = `${rawOf(buildUsageRequest()).slice(0, -1)},"extra":1}`;
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects unknown nested fields when the credential object carries extras", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "bearer", secret: "demo", expiresIn: 3600 },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects an oauth field on a static credential when the union arm is closed per kind", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "bearer", secret: "demo", oauth: { access: "demo" } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects an unknown credential kind when the credential union is closed", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "cookie", secret: "demo" },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects an oauth credential missing the oauth bundle", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "oauth-access-1" },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects an oauth credential missing access when the bundle is empty", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "oauth-access-1", oauth: { refresh: "oauth-refresh-1" } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects an empty oauth access when access must be non-empty", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "oauth-access-1", oauth: { access: "" } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects unknown fields inside the oauth bundle when the bundle is closed", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "s", oauth: { access: "s", scope: "read" } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects a wrong-typed oauth refresh when the bundle fields are typed", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "s", oauth: { access: "s", refresh: 42 } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects a bad oauth expiresAtMs when the timestamp must be epoch millis", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "s", oauth: { access: "s", expiresAtMs: -5 } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects non-string identity values when identity is a string record", () => {
    const raw = rawUsageRequest((request) => ({
      ...request,
      credential: { kind: "oauth", secret: "s", oauth: { access: "s", identity: { login: 7 } } },
    }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects a foreign schemaVersion when the payload is not protocol 1.2.0", () => {
    const raw = rawUsageRequest((request) => ({ ...request, schemaVersion: "1.0.0" }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects oversized requests when the 64 KiB framing limit is exceeded", () => {
    const raw = rawUsageRequest((request) => ({ ...request, requestId: "r".repeat(70 * 1024) }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects unparseable bodies when the request is not strict UTF-8 JSON", () => {
    expect(bridgeErrorFrom(() => parseBridgeRequest("not json at all")).kind).toBe("invalidRequest");
  });

  test("rejects an empty requestId when correlation identity is required", () => {
    const raw = rawUsageRequest((request) => ({ ...request, requestId: "" }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects an unknown operation when the request names an unsupported verb", () => {
    const raw = rawUsageRequest((request) => ({ ...request, operation: "listModels" }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects a deadline before the request time when scheduling policy is violated", () => {
    const raw = rawUsageRequest((request) => ({ ...request, deadlineAtMs: request.requestedAtMs - 1 }));
    expect(bridgeErrorFrom(() => parseBridgeRequest(raw)).kind).toBe("invalidPolicy");
  });
});

describe("parseLoginRequest", () => {
  test("accepts the canonical login request when every locked field is present", () => {
    expect(parseLoginRequest(rawOf(buildLoginRequest()))).toEqual(buildLoginRequest());
  });

  test("accepts a browser login with cookie inputs when cookies are the session basis", () => {
    const login = buildLoginRequest({
      providerId: "anthropic",
      method: "browser",
      inputs: { cookieHeader: "Cookie: session=1" },
    });
    expect(parseLoginRequest(rawOf(login))).toEqual(login);
  });

  test("accepts a device login without inputs when the payload is minimal", () => {
    const { inputs: _inputs, ...minimal } = buildLoginRequest({ method: "device" });
    const request = parseLoginRequest(rawOf(minimal));
    expect(request.method).toBe("device");
    expect(request.inputs).toBeUndefined();
    expect("inputs" in request).toBe(false);
  });

  test("rejects an unknown method when the method set is closed", () => {
    const raw = rawLoginRequest((login) => ({ ...login, method: "clipboard" }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects a foreign schemaVersion when the login payload is not protocol 1.2.0", () => {
    const raw = rawLoginRequest((login) => ({ ...login, schemaVersion: "1.0.0" }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidProtocol");
  });

  test("rejects unknown top-level fields when strict login parsing is applied", () => {
    const raw = `${rawOf(buildLoginRequest()).slice(0, -1)},"extra":1}`;
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects unknown inputs fields when the inputs object is closed", () => {
    const raw = rawLoginRequest((login) => ({ ...login, inputs: { ...login.inputs, totem: "x" } }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects wrong-typed inputs values when inputs must be strings", () => {
    const raw = rawLoginRequest((login) => ({ ...login, inputs: { apiKey: 42 } }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects empty inputs values when input strings must be non-empty", () => {
    const raw = rawLoginRequest((login) => ({ ...login, inputs: { apiKey: "" } }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidRequest");
  });

  test("rejects a non-object body when the login request is not a JSON object", () => {
    expect(bridgeErrorFrom(() => parseLoginRequest("[1,2,3]")).kind).toBe("invalidRequest");
  });

  test("rejects a deadline before the request time when scheduling policy is violated", () => {
    const raw = rawLoginRequest((login) => ({ ...login, deadlineAtMs: login.requestedAtMs }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidPolicy");
  });

  test("rejects oversized login requests when the 64 KiB framing limit is exceeded", () => {
    const raw = rawLoginRequest((login) => ({ ...login, providerId: "p".repeat(70 * 1024) }));
    expect(bridgeErrorFrom(() => parseLoginRequest(raw)).kind).toBe("invalidProtocol");
  });
});

describe("parsePromptResponse", () => {
  test("accepts an empty response value while preserving request correlation", () => {
    expect(parsePromptResponse('{"type":"promptResponse","requestId":"prompt-1","value":""}')).toEqual({
      type: "promptResponse",
      requestId: "prompt-1",
      value: "",
    });
  });

  test("strictly rejects unknown fields and foreign message types", () => {
    expect(
      bridgeErrorFrom(() =>
        parsePromptResponse('{"type":"promptResponse","requestId":"prompt-1","value":"secret","extra":true}'),
      ).kind,
    ).toBe("invalidRequest");
    expect(
      bridgeErrorFrom(() => parsePromptResponse('{"type":"cancel","requestId":"prompt-1","value":""}')).kind,
    ).toBe("invalidRequest");
  });
});

describe("encodeBridgeResponse", () => {
  test("BridgeError carries a refreshed credential without embedding it in the message", () => {
    const error = new BridgeError("authRequired", "usage failed after rotation", {
      refreshedCredential: OAUTH_CREDENTIAL,
    });
    expect(error.refreshedCredential).toEqual(OAUTH_CREDENTIAL);
    expect(error.message).not.toContain("oauth-access-1");
    expect(error.message).not.toContain("oauth-refresh-1");
  });

  test("encodes the exact success envelope when correlation fields are echoed", () => {
    const encoded = encodeBridgeResponse(SUCCESS_RESPONSE);
    expect(JSON.parse(encoded)).toEqual(SUCCESS_RESPONSE);
  });

  test("round-trips refreshedCredential when a connector rotated an OAuth token", () => {
    const rotated: BridgeResponse = {
      ...SUCCESS_RESPONSE,
      refreshedCredential: {
        kind: "oauth",
        secret: "rotated-access",
        oauth: { access: "rotated-access", refresh: "rotated-refresh", expiresAtMs: 1787014800000 },
      },
    };
    const encoded = encodeBridgeResponse(rotated);
    expect(JSON.parse(encoded)).toEqual(rotated);
    expect(encoded).toContain("refreshedCredential");
  });

  test("round-trips a refreshed credential on an error envelope", () => {
    const response: BridgeErrorResponse = {
      schemaVersion: PROTOCOL_VERSION,
      requestId: SUCCESS_RESPONSE.requestId,
      providerId: SUCCESS_RESPONSE.providerId,
      connectorId: SUCCESS_RESPONSE.connectorId,
      accountRef: SUCCESS_RESPONSE.accountRef,
      status: "error",
      completedAtMs: SUCCESS_RESPONSE.completedAtMs,
      error: { kind: "authRequired", message: "the rotated credential was rejected" },
      refreshedCredential: OAUTH_CREDENTIAL,
    };
    expect(JSON.parse(encodeBridgeResponse(response))).toEqual(response);
  });

  test("emits no credential material when the response carries none", () => {
    const encoded = encodeBridgeResponse(SUCCESS_RESPONSE);
    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("credential");
    expect(encoded).not.toContain("demo");
  });

  test("rejects oversized reports when the 2 MiB response framing limit is exceeded", () => {
    const oversized: BridgeResponse = {
      ...SUCCESS_RESPONSE,
      report: {
        ...SUCCESS_RESPONSE.report,
        windows: [
          {
            id: "oversize",
            label: "x".repeat(3 * 1024 * 1024),
            unit: "tokens",
            severity: "unknown",
          },
        ],
      },
    };
    expect(bridgeErrorFrom(() => encodeBridgeResponse(oversized)).kind).toBe("invalidProtocol");
  });
});

describe("redactSecrets", () => {
  test("replaces every occurrence when a known secret appears in text", () => {
    expect(redactSecrets("Authorization: Bearer ghp_secret123", ["ghp_secret123"])).toBe(
      "Authorization: Bearer [redacted]",
    );
  });

  test("replaces multiple distinct secrets when several leak into one message", () => {
    expect(redactSecrets("a ghp_one b ghp_two c", ["ghp_one", "ghp_two"])).toBe(
      "a [redacted] b [redacted] c",
    );
  });

  test("covers oauth access and refresh values when a credential leaks into a message", () => {
    const text = "rotate oauth-access-1 via oauth-refresh-1 for client-1";
    expect(redactSecrets(text, credentialSecrets(OAUTH_CREDENTIAL))).toBe(
      "rotate [redacted] via [redacted] for client-1",
    );
  });
});

describe("credentialSecrets", () => {
  test("returns no secret for the credential-free arm", () => {
    expect(credentialSecrets({ kind: "none" })).toEqual([]);
  });

  test("returns the single secret when a static credential is inspected", () => {
    expect(credentialSecrets({ kind: "bearer", secret: "tok" })).toEqual(["tok"]);
  });

  test("returns secret, access and refresh when an oauth credential is inspected", () => {
    expect(credentialSecrets(OAUTH_CREDENTIAL)).toEqual(["oauth-access-1", "oauth-refresh-1"]);
  });

  test("deduplicates when oauth access mirrors the credential secret", () => {
    expect(credentialSecrets({ kind: "oauth", secret: "a", oauth: { access: "a" } })).toEqual(["a"]);
  });

  test("returns nothing when no credential was carried", () => {
    expect(credentialSecrets(undefined)).toEqual([]);
  });
});

describe("dispatch layer", () => {
  test("round-trips connector and auth modules when they are registered by providerId", () => {
    const connector: ConnectorModule = {
      providerId: "protocol-test-connector",
      connectorVersion: "unit-1",
      fetchUsage: async () => SUCCESS_RESPONSE,
    };
    registerConnector(connector);
    expect(lookupConnector("protocol-test-connector")).toBe(connector);

    const auth: AuthModule = {
      providerId: "protocol-test-auth",
      methods: ["apiKey", "device"],
      login: async () => ({ credential: { kind: "apiKey", secret: "k" } }),
    };
    registerAuth(auth);
    expect(lookupAuth("protocol-test-auth")).toBe(auth);

    expect(lookupConnector("protocol-test-auth")).toBeUndefined();
    expect(lookupAuth("protocol-test-connector")).toBeUndefined();
    expect(lookupConnector("never-registered")).toBeUndefined();
    expect(lookupAuth("never-registered")).toBeUndefined();
  });

  test("runs a registered connector through ConnectorModule.fetchUsage when mockFetcher routes it", async () => {
    const fetcher = mockFetcher({ "GET https://unit.test/usage": { status: 200, body: { ok: true } } });
    const connector: ConnectorModule = {
      providerId: "mock-connector",
      connectorVersion: "unit-2",
      fetchUsage: async ({ request, fetcher, nowMs }) => {
        const upstream = await fetcher("https://unit.test/usage", { method: "GET" });
        const body = (await upstream.json()) as { ok: boolean };
        if (!body.ok) {
          throw new BridgeError("upstreamError", "unit route failed");
        }
        return {
          schemaVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          providerId: request.providerId,
          connectorId: request.connectorId,
          accountRef: request.accountRef,
          status: "ok",
          completedAtMs: nowMs,
          report: {
            productKind: "quota",
            sourceKind: "firstPartyApi",
            fetchedAtMs: nowMs,
            connectorVersion: "unit-2",
            windows: [],
          },
        };
      },
    };
    registerConnector(connector);
    const resolved = lookupConnector("mock-connector");
    if (resolved === undefined) {
      throw new Error("mock-connector was not registered");
    }
    const request = buildUsageRequest({ providerId: "mock-connector", connectorId: "mock-connector" });
    const response = await resolved.fetchUsage({ request, fetcher, nowMs: 1787011200500 });
    expect(response.status).toBe("ok");
    expect(response.report.connectorVersion).toBe("unit-2");
    expect(fetcher.calls.length).toBe(1);
    expect(fetcher.calls[0]?.method).toBe("GET");
  });

  test("matches predicate routes when a rule needs more than a literal key", async () => {
    const fetcher = mockFetcher([
      {
        when: (method, url) => method === "POST" && url.endsWith("/token"),
        respond: { status: 201, body: { token: "rotated" } },
      },
    ]);
    const response = await fetcher("https://unit.test/token", { method: "POST" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ token: "rotated" });
    expect(fetcher.calls[0]?.url).toBe("https://unit.test/token");
  });
});
