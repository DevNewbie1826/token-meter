import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { generatePKCE, pkceChallengeFromVerifier } from "../src/auth/pkce";
import type { CallbackResult } from "../src/auth/loopback";
import {
  CallbackCancelledError,
  CallbackFailedError,
  generateCallbackState,
  startLoopbackCallback,
} from "../src/auth/loopback";
import {
  DeviceFlowCancelledError,
  DeviceFlowFailedError,
  pollOAuthDeviceCodeFlow,
  runDeviceAuthorizationFlow,
} from "../src/auth/device";
import type { FetchLike, OAuthDeviceCodePollResult } from "../src/auth/device";
import type { AuthEvent } from "../src/auth/types";
import { openInBrowser } from "../src/auth/open-browser";
import { failureEnvelope, runLoginSession } from "../src/cli";
import { registerAuth } from "../src/dispatch";
import { BridgeError, PROTOCOL_VERSION } from "../src/protocol";
import { buildLoginRequest, buildUsageRequest } from "./helpers";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Captures a rejection with handlers attached synchronously, so the promise
 * is never briefly unhandled (bun attributes those to the test) and no
 * bun `.rejects` matcher quirks apply.
 */
async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    value => {
      throw new Error(`expected a rejection, resolved with ${JSON.stringify(value)}`);
    },
    error => error as Error,
  );
}

/** A signal-driven line source for duplex CLI tests; no polling or sleeps. */
class ControlledLines {
  private readonly buffered: string[] = [];
  private readonly waiters: Array<(line: string | undefined) => void> = [];
  private ended = false;

  push(line: string): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(line);
    } else {
      this.buffered.push(line);
    }
  }

  readLine(): Promise<string | undefined> {
    const line = this.buffered.shift();
    if (line !== undefined) {
      return Promise.resolve(line);
    }
    if (this.ended) {
      return Promise.resolve(undefined);
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }
  }
}

function liveLoginRequest(providerId: string): Omit<ReturnType<typeof buildLoginRequest>, "inputs"> {
  const nowMs = Date.now();
  const { inputs: _inputs, ...request } = buildLoginRequest({
    providerId,
    requestedAtMs: nowMs,
    deadlineAtMs: nowMs + 10_000,
  });
  return request;
}

describe("duplex login session", () => {
  test("error writeback is preserved while every refreshed secret is redacted", () => {
    const refreshedCredential = {
      kind: "oauth" as const,
      secret: "rotated-access-unit",
      oauth: {
        access: "rotated-access-unit",
        refresh: "rotated-refresh-unit",
      },
    };
    const envelope = failureEnvelope(
      buildUsageRequest({ credential: { kind: "none" } }),
      new BridgeError(
        "authRequired",
        "failed with rotated-access-unit and rotated-refresh-unit",
        { refreshedCredential },
      ),
    );

    expect(envelope.refreshedCredential).toEqual(refreshedCredential);
    expect(envelope.error.message).toBe("failed with [redacted] and [redacted]");
  });

  test("normalizes credential-free local Ollama login to the none union arm", async () => {
    const lines = new ControlledLines();
    const output: string[] = [];
    lines.push(JSON.stringify(liveLoginRequest("ollama")));

    const exitCode = await runLoginSession({
      readLine: () => lines.readLine(),
      writeOutput: line => output.push(line),
      writeEvent: () => {},
      closeInput: () => lines.close(),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      schemaVersion: PROTOCOL_VERSION,
      providerId: "ollama",
      status: "ok",
      credential: { kind: "none" },
      accountLabel: "Local (no key)",
    });
  });

  test("routes a prompt response by request id and returns the final credential", async () => {
    const providerId = "duplex-roundtrip-test";
    registerAuth({
      providerId,
      methods: ["apiKey"],
      login: async (_method, _inputs, events, signal) => {
        const value = await events.requestInput!(
          {
            prompt: "Paste the unit-test code",
            inputKind: "code",
            sensitive: true,
          },
          signal,
        );
        return { credential: { kind: "apiKey", secret: value }, accountLabel: "Duplex" };
      },
    });

    const lines = new ControlledLines();
    const output: string[] = [];
    const eventLines: string[] = [];
    lines.push(JSON.stringify(liveLoginRequest(providerId)));

    const exitCode = await runLoginSession({
      readLine: () => lines.readLine(),
      writeOutput: line => output.push(line),
      writeEvent: line => {
        eventLines.push(line);
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event["type"] === "prompt") {
          expect(event).toMatchObject({
            prompt: "Paste the unit-test code",
            inputKind: "code",
            sensitive: true,
          });
          lines.push(JSON.stringify({
            type: "promptResponse",
            requestId: event["requestId"],
            value: "duplex-unit-value",
          }));
        }
      },
      closeInput: () => lines.close(),
    });

    expect(exitCode).toBe(0);
    expect(eventLines).toHaveLength(1);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "{}")).toEqual({
      schemaVersion: PROTOCOL_VERSION,
      providerId,
      status: "ok",
      completedAtMs: expect.any(Number),
      credential: { kind: "apiKey", secret: "duplex-unit-value" },
      accountLabel: "Duplex",
    });
  });

  test("redacts a sensitive prompt response from the final error envelope", async () => {
    const providerId = "duplex-redaction-test";
    const sensitiveValue = "prompt-response-unit-secret";
    registerAuth({
      providerId,
      methods: ["apiKey"],
      login: async (_method, _inputs, events, signal) => {
        const value = await events.requestInput!(
          { prompt: "Sensitive value", inputKind: "text", sensitive: true },
          signal,
        );
        throw new BridgeError("invalidRequest", `provider rejected ${value}`);
      },
    });

    const lines = new ControlledLines();
    const output: string[] = [];
    const eventLines: string[] = [];
    lines.push(JSON.stringify(liveLoginRequest(providerId)));

    const exitCode = await runLoginSession({
      readLine: () => lines.readLine(),
      writeOutput: line => output.push(line),
      writeEvent: line => {
        eventLines.push(line);
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event["type"] === "prompt") {
          lines.push(JSON.stringify({
            type: "promptResponse",
            requestId: event["requestId"],
            value: sensitiveValue,
          }));
        }
      },
      closeInput: () => lines.close(),
    });

    expect(exitCode).toBe(1);
    expect(output.join("\n")).not.toContain(sensitiveValue);
    expect(eventLines.join("\n")).not.toContain(sensitiveValue);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      schemaVersion: PROTOCOL_VERSION,
      providerId,
      status: "error",
      error: { kind: "invalidRequest", message: "provider rejected [redacted]" },
    });
  });

  test("session deadline settles even when an auth module ignores its signal", async () => {
    const providerId = "deadline-watchdog-test";
    registerAuth({
      providerId,
      methods: ["device"],
      login: async () => await new Promise<never>(() => {}),
    });

    const lines = new ControlledLines();
    const output: string[] = [];
    lines.push(JSON.stringify({
      ...liveLoginRequest(providerId),
      method: "device",
      deadlineAtMs: Date.now() + 20,
    }));
    const session = runLoginSession({
      readLine: () => lines.readLine(),
      writeOutput: line => output.push(line),
      writeEvent: () => {},
      closeInput: () => lines.close(),
    });
    const outcome = await Promise.race([
      session,
      Bun.sleep(250).then(() => "test-timeout" as const),
    ]);

    expect(outcome).not.toBe("test-timeout");
    expect(outcome).toBe(1);
    expect(JSON.parse(output[0] ?? "{}")).toMatchObject({
      schemaVersion: PROTOCOL_VERSION,
      providerId,
      status: "error",
      error: { kind: "timeout" },
    });
  });
});

describe("pkce", () => {
  test("known RFC 7636 S256 vector reproduces exactly", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    await expect(pkceChallengeFromVerifier(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("same verifier always yields the same challenge, matching node crypto", async () => {
    for (const verifier of ["a", "plain-verifier", verifier96Bytes()]) {
      const first = await pkceChallengeFromVerifier(verifier);
      const second = await pkceChallengeFromVerifier(verifier);
      expect(first).toBe(second);
      expect(first).toBe(sha256Base64Url(verifier));
    }
  });

  test("generatePKCE emits base64url verifier (96 bytes) and 43-char challenge", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();

    expect(a.verifier).toMatch(BASE64URL);
    expect(a.verifier).toHaveLength(128);
    expect(a.challenge).toMatch(BASE64URL);
    expect(a.challenge).toHaveLength(43);
    expect(a.challenge).toBe(await pkceChallengeFromVerifier(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

function verifier96Bytes(): string {
  return "A".repeat(96);
}

describe("loopback callback server", () => {
  test("captures code+state from a real 127.0.0.1 round-trip", async () => {
    const state = generateCallbackState();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(generateCallbackState()).not.toBe(state);

    const handle = await startLoopbackCallback(state, { timeoutMs: 5000 });
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.redirectUri).toBe(`http://127.0.0.1:${handle.port}/callback`);

      // Unknown paths 404 without touching the wait.
      const other = await fetch(`http://127.0.0.1:${handle.port}/elsewhere`);
      expect(other.status).toBe(404);

      const response = await fetch(`${handle.redirectUri}?code=auth-code-1&state=${state}`);
      expect(response.status).toBe(200);

      const result: CallbackResult = await handle.wait;
      expect(result).toEqual({ code: "auth-code-1", state });
    } finally {
      handle.stop();
    }
  });

  test("rejects a mismatched state without resolving the wait", async () => {
    const state = generateCallbackState();
    const handle = await startLoopbackCallback(state, { timeoutMs: 5000 });
    try {
      let resolved = false;
      void handle.wait.then(
        () => {
          resolved = true;
        },
        () => {
          resolved = true;
        },
      );

      const mismatch = await fetch(`${handle.redirectUri}?code=evil&state=forger`);
      expect(mismatch.status).toBe(500);
      expect(await mismatch.text()).toContain("State mismatch");
      expect(resolved).toBe(false);

      // A forged error (wrong state) must also be ignored.
      const forgedError = await fetch(`${handle.redirectUri}?error=access_denied&state=forger`);
      expect(forgedError.status).toBe(500);
      expect(resolved).toBe(false);

      const good = await fetch(`${handle.redirectUri}?code=real-code&state=${state}`);
      expect(good.status).toBe(200);
      await expect(handle.wait).resolves.toEqual({ code: "real-code", state });
    } finally {
      handle.stop();
    }
  });

  test("missing code is rejected with 500", async () => {
    const state = generateCallbackState();
    const handle = await startLoopbackCallback(state, { timeoutMs: 5000 });
    try {
      const response = await fetch(`${handle.redirectUri}?state=${state}`);
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("Missing authorization code");
    } finally {
      handle.stop();
    }
  });

  test("error callback carrying our state rejects the wait", async () => {
    const state = generateCallbackState();
    const handle = await startLoopbackCallback(state, { timeoutMs: 5000 });
    try {
      // Handlers first: the rejection fires in a microtask during the fetch,
      // and bun flags rejections that are briefly unhandled.
      const waitError = captureRejection(handle.wait);
      const response = await fetch(
        `${handle.redirectUri}?error=access_denied&error_description=User+said+no&state=${state}`,
      );
      expect(response.status).toBe(500);
      const error = await waitError;
      expect(error).toBeInstanceOf(CallbackFailedError);
      expect(error.message).toBe("Authorization failed: User said no");
    } finally {
      handle.stop();
    }
  });

  test("deadline aborts the wait with a cancelled error", async () => {
    const state = generateCallbackState();
    const handle = await startLoopbackCallback(state, { timeoutMs: 120 });
    try {
      const error = await captureRejection(handle.wait);
      expect(error).toBeInstanceOf(CallbackCancelledError);
      expect(error.message).toContain("OAuth callback cancelled");
    } finally {
      handle.stop();
    }
  });

  test("caller signal aborts the wait", async () => {
    const controller = new AbortController();
    const state = generateCallbackState();
    const handle = await startLoopbackCallback(state, { signal: controller.signal, timeoutMs: 5000 });
    try {
      controller.abort();
      const error = await captureRejection(handle.wait);
      expect(error).toBeInstanceOf(CallbackCancelledError);
      expect(error.message).toContain("OAuth callback cancelled");
    } finally {
      handle.stop();
    }
  });

  test("busy preferred port falls back to a random port", async () => {
    const first = await startLoopbackCallback("state-a", { timeoutMs: 5000 });
    const progress: string[] = [];
    try {
      const second = await startLoopbackCallback("state-b", {
        preferredPort: first.port,
        timeoutMs: 5000,
        onProgress: message => progress.push(message),
      });
      try {
        expect(second.port).toBeGreaterThan(0);
        expect(second.port).not.toBe(first.port);
        expect(second.redirectUri).toBe(`http://127.0.0.1:${second.port}/callback`);
        expect(progress).toEqual([`Preferred port ${first.port} unavailable, using port ${second.port}`]);
      } finally {
        second.stop();
      }
    } finally {
      first.stop();
    }
  });
});

interface ScriptedDeviceFlow {
  readonly fetchImpl: FetchLike;
  readonly events: AuthEvent[];
  readonly tokenBodies: URLSearchParams[];
  readonly deviceAuthBodies: URLSearchParams[];
  nowMs: number;
  readonly sleepCalls: number[];
  readonly now: () => number;
}

const DEVICE_AUTH_URL = "https://provider.example/device/code";
const TOKEN_URL = "https://provider.example/token";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** RFC 8628 pending result: HTTP 400 + authorization_pending error body. */
function pendingResponse(): Response {
  return jsonResponse({ error: "authorization_pending" }, 400);
}

/** RFC 8628 slow_down result: HTTP 400 + slow_down error body. */
function slowDownResponse(): Response {
  return jsonResponse({ error: "slow_down" }, 400);
}

function scriptedDeviceFlow(
  deviceAuthorization: unknown,
  tokenResponses: Array<Response | (() => Response)>,
): ScriptedDeviceFlow {
  const script = {
    nowMs: 1_700_000_000_000,
    sleepCalls: [] as number[],
    events: [] as AuthEvent[],
    tokenBodies: [] as URLSearchParams[],
    deviceAuthBodies: [] as URLSearchParams[],
    fetchImpl: undefined as unknown as FetchLike,
    now: () => script.nowMs,
  };

  script.fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method !== "POST") throw new Error(`unexpected method for ${url}`);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.get("accept")).toBe("application/json");

    const body = new URLSearchParams(String(init.body));
    if (url === DEVICE_AUTH_URL) {
      script.deviceAuthBodies.push(body);
      return jsonResponse(deviceAuthorization);
    }
    if (url === TOKEN_URL) {
      script.tokenBodies.push(body);
      const next = tokenResponses.shift();
      if (next === undefined) throw new Error("token endpoint polled too many times");
      // A function entry is an endless generator: re-queue it after serving.
      if (typeof next === "function") tokenResponses.push(next);
      return typeof next === "function" ? next() : next;
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  return script;
}

function flowSleep(script: ScriptedFlowClock): (ms: number) => Promise<void> {
  return ms => {
    script.sleepCalls.push(ms);
    script.nowMs += ms;
    return Promise.resolve();
  };
}

interface ScriptedFlowClock {
  nowMs: number;
  sleepCalls: number[];
}

const DEVICE_AUTHORIZATION = {
  device_code: "dev-1",
  user_code: "ABCD-1234",
  verification_uri: "https://provider.example/activate",
  verification_uri_complete: "https://provider.example/activate?user_code=ABCD-1234",
  expires_in: 600,
  interval: 1,
};

const ENDPOINTS = {
  deviceAuthorizationUrl: DEVICE_AUTH_URL,
  tokenUrl: TOKEN_URL,
  clientId: "client-1",
  scope: "usage:read",
};

describe("device flow", () => {
  test("pending, then slow_down, then success - intervals and events", async () => {
    const script = scriptedDeviceFlow(DEVICE_AUTHORIZATION, [
      pendingResponse(),
      slowDownResponse(),
      jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }),
    ]);

    const tokens = await runDeviceAuthorizationFlow(ENDPOINTS, {
      fetchImpl: script.fetchImpl,
      events: { onEvent: event => script.events.push(event) },
      now: script.now,
      sleep: flowSleep(script),
    });

    expect(tokens.access).toBe("at-1");
    expect(tokens.refresh).toBe("rt-1");
    // Virtual clock advanced 1000 (advertised interval) + 6000 (after slow_down).
    // Expiry = 1_700_000_007_000 + 3_600_000 - 300_000 (5-minute client skew).
    expect(tokens.expiresAtMs).toBe(1_700_003_307_000);

    expect(script.sleepCalls).toEqual([1000, 6000]);
    expect(script.tokenBodies).toHaveLength(3);
    expect(script.deviceAuthBodies).toHaveLength(1);
    expect(script.deviceAuthBodies[0]!.get("client_id")).toBe("client-1");
    expect(script.deviceAuthBodies[0]!.get("scope")).toBe("usage:read");
    for (const body of script.tokenBodies) {
      expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
      expect(body.get("device_code")).toBe("dev-1");
      expect(body.get("client_id")).toBe("client-1");
    }
    expect(script.events).toEqual([
      {
        type: "openUrl",
        url: "https://provider.example/activate?user_code=ABCD-1234",
      },
      { type: "code", code: "ABCD-1234", verificationUrl: "https://provider.example/activate" },
      { type: "waiting", detail: "Waiting for device authorization..." },
    ]);
  });

  test("verification_uri_complete appends the user code when omitted", async () => {
    const script = scriptedDeviceFlow(
      { device_code: "dev-2", user_code: "W-XYZ", verification_uri: "https://provider.example/device" },
      [jsonResponse({ access_token: "opaque", expires_in: 60 })],
    );
    const tokens = await runDeviceAuthorizationFlow(ENDPOINTS, {
      fetchImpl: script.fetchImpl,
      events: { onEvent: event => script.events.push(event) },
      now: script.now,
      sleep: flowSleep(script),
    });
    expect(tokens.access).toBe("opaque");
    expect(tokens.refresh).toBeUndefined();
    // No pending poll, so the clock never advanced: expiry = now + 60s - 5min skew.
    expect(tokens.expiresAtMs).toBe(1_700_000_000_000 + 60_000 - 300_000);
    expect(script.events[0]).toEqual({
      type: "openUrl",
      url: "https://provider.example/device?user_code=W-XYZ",
    });
  });

  test("terminal error rejects the flow", async () => {
    const script = scriptedDeviceFlow(DEVICE_AUTHORIZATION, [
      pendingResponse(),
      jsonResponse(
        { error: "access_denied", error_description: "The user denied the request" },
        400,
      ),
    ]);
    const error = await captureRejection(
      runDeviceAuthorizationFlow(ENDPOINTS, {
        fetchImpl: script.fetchImpl,
        now: script.now,
        sleep: flowSleep(script),
      }),
    );
    expect(error).toBeInstanceOf(DeviceFlowFailedError);
    expect(error.message).toBe("Device flow token polling failed: The user denied the request");
  });

  test("expiry deadline stops polling with the timeout error", async () => {
    const script = scriptedDeviceFlow(
      { ...DEVICE_AUTHORIZATION, expires_in: 2 },
      [() => pendingResponse()],
    );
    const error = await captureRejection(
      runDeviceAuthorizationFlow(ENDPOINTS, {
        fetchImpl: script.fetchImpl,
        now: script.now,
        sleep: flowSleep(script),
      }),
    );
    expect(error.message).toBe("Device flow timed out");
  });

  test("slow_down before the deadline yields the clock-drift timeout message", async () => {
    const script = scriptedDeviceFlow(
      { ...DEVICE_AUTHORIZATION, expires_in: 1 },
      [slowDownResponse()],
    );
    const error = await captureRejection(
      runDeviceAuthorizationFlow(ENDPOINTS, {
        fetchImpl: script.fetchImpl,
        now: script.now,
        sleep: flowSleep(script),
      }),
    );
    expect(error.message).toContain("clock drift");
  });

  test("aborting the signal cancels with Login cancelled", async () => {
    const script = scriptedDeviceFlow(DEVICE_AUTHORIZATION, [
      pendingResponse(),
      pendingResponse(),
    ]);
    const controller = new AbortController();
    const abortingSleep = (ms: number): Promise<void> => {
      script.sleepCalls.push(ms);
      controller.abort();
      return Promise.resolve();
    };
    const error = await captureRejection(
      runDeviceAuthorizationFlow(ENDPOINTS, {
        fetchImpl: script.fetchImpl,
        signal: controller.signal,
        now: script.now,
        sleep: abortingSleep,
      }),
    );
    expect(error).toBeInstanceOf(DeviceFlowCancelledError);
    expect(error.message).toBe("Login cancelled");
  });

  test("device authorization endpoint failure surfaces status and body", async () => {
    const failingFetch: FetchLike = async () =>
      new Response("boom", { status: 500, headers: { "Content-Type": "text/plain" } });
    const error = await captureRejection(runDeviceAuthorizationFlow(ENDPOINTS, { fetchImpl: failingFetch }));
    expect(error.message).toBe("Device authorization request failed: 500 boom");
  });

  test("engine enforces the 1s minimum interval floor", async () => {
    const clock: ScriptedFlowClock = { nowMs: 0, sleepCalls: [] };
    const polls: Array<OAuthDeviceCodePollResult<string>> = [
      { status: "pending" },
      { status: "complete", value: "done" },
    ];
    await expect(
      pollOAuthDeviceCodeFlow({
        poll: () => polls.shift() ?? { status: "failed", message: "exhausted" },
        intervalSeconds: 0.2,
        now: () => clock.nowMs,
        sleep: ms => {
          clock.sleepCalls.push(ms);
          clock.nowMs += ms;
          return Promise.resolve();
        },
      }),
    ).resolves.toBe("done");
    expect(clock.sleepCalls).toEqual([1000]);
  });
});

describe("open-browser", () => {
  test("routes through the injected opener instead of spawning", () => {
    const seen: string[] = [];
    openInBrowser("https://provider.example/activate?user_code=ABCD-1234", url => {
      seen.push(url);
    });
    expect(seen).toEqual(["https://provider.example/activate?user_code=ABCD-1234"]);
  });

  test("never throws when the opener fails", () => {
    expect(() =>
      openInBrowser("https://provider.example/activate", () => {
        throw new Error("no opener here");
      }),
    ).not.toThrow();
  });
});
