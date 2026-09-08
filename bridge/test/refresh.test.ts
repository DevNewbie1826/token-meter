import { describe, expect, test } from "bun:test";
import { BridgeError } from "../src/protocol-core";
import type { BridgeCredential } from "../src/protocol-core";
import {
  parseManualCallbackInput,
  rethrowWithRefreshedCredential,
  rotateOAuthToken,
  waitForCallbackOrManualPaste,
} from "../src/auth/refresh";
import { mockFetcher } from "./helpers";
import { CallbackCancelledError } from "../src/auth/loopback";
import { getEventListeners } from "node:events";

const credential = {
  kind: "oauth" as const,
  secret: "old-access",
  oauth: {
    access: "old-access",
    refresh: "old-refresh",
    refreshEndpoint: "https://oauth.example/token",
    clientId: "client-id",
    identity: { account: "acct" },
  },
};
const signal = new AbortController().signal;

describe("rotateOAuthToken", () => {
  test("posts a form and returns a rotated credential preserving metadata", async () => {
    const fetcher = mockFetcher({
      "POST https://oauth.example/token": { status: 200, body: { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 } },
    });
    const result = await rotateOAuthToken({ credential, fetcher, signal });
    const params = new URLSearchParams(String(fetcher.calls[0]?.init.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("refresh_token")).toBe("old-refresh");
    expect(result.secret).toBe("new-access");
    expect(result.oauth.access).toBe("new-access");
    expect(result.oauth.refresh).toBe("new-refresh");
    expect(result.oauth.refreshEndpoint).toBe(credential.oauth.refreshEndpoint);
    expect(result.oauth.clientId).toBe(credential.oauth.clientId);
    expect(result.oauth.identity).toEqual(credential.oauth.identity);
    expect(result).not.toBe(credential);
  });

  test("supports custom mapping and extra form fields", async () => {
    const fetcher = mockFetcher({ "POST https://oauth.example/token": { status: 200, body: { token: "mapped" } } });
    const result = await rotateOAuthToken({
      credential,
      fetcher,
      signal,
      extraBody: { client_secret: "secret", scope: "read write" },
      mapResponse: (json) => ({ access: String((json as { token: string }).token), expiresInMs: 1000 }),
    });
    const params = new URLSearchParams(String(fetcher.calls[0]?.init.body));
    expect(params.get("client_secret")).toBe("secret");
    expect(params.get("scope")).toBe("read write");
    expect(result.oauth.access).toBe("mapped");
  });

  test("missing access token is authRequired", async () => {
    const fetcher = mockFetcher({ "POST https://oauth.example/token": { status: 200, body: {} } });
    try {
      await rotateOAuthToken({ credential, fetcher, signal });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      expect((error as BridgeError).kind).toBe("authRequired");
      expect((error as Error).message).toBe("token refresh returned no access token");
    }
  });

  test("401 maps to authRequired", async () => {
    const fetcher = mockFetcher({ "POST https://oauth.example/token": { status: 401, body: {} } });
    expect(rotateOAuthToken({ credential, fetcher, signal })).rejects.toMatchObject({ kind: "authRequired" });
  });
});

describe("parseManualCallbackInput (OMP parseCallbackInput)", () => {
  test("extracts code and state from a pasted redirect URL", () => {
    expect(parseManualCallbackInput("http://127.0.0.1:54545/callback?code=abc&state=st-1")).toEqual({
      code: "abc",
      state: "st-1",
    });
  });

  test("a URL paste without a state yields the code only", () => {
    expect(parseManualCallbackInput("http://127.0.0.1:54545/callback?code=abc")).toEqual({ code: "abc" });
  });

  test("extracts from a bare query-string paste with or without the leading ?/#", () => {
    expect(parseManualCallbackInput("?code=abc&state=st-1")).toEqual({ code: "abc", state: "st-1" });
    expect(parseManualCallbackInput("code=abc&state=st-1")).toEqual({ code: "abc", state: "st-1" });
  });

  test("treats a non-URL paste as a raw code, splitting any #state suffix", () => {
    expect(parseManualCallbackInput("raw-code#st-2")).toEqual({ code: "raw-code", state: "st-2" });
    expect(parseManualCallbackInput(" raw-code ")).toEqual({ code: "raw-code" });
  });

  test("empty and whitespace pastes carry no code", () => {
    expect(parseManualCallbackInput("")).toEqual({});
    expect(parseManualCallbackInput("   ")).toEqual({});
  });
});

describe("waitForCallbackOrManualPaste", () => {
  const state = "state-unit";
  const prompt = { prompt: "paste the redirect URL", inputKind: "redirectUrl" as const, sensitive: true };

  test("manual-only custom scheme re-prompts forged and missing state before accepting", async () => {
    const controller = new AbortController();
    const pastes = ["code-without-state", "?code=forged&state=wrong", `zcode://zai-auth/callback?code=valid&state=${state}`];
    let prompts = 0;
    const result = await waitForCallbackOrManualPaste({
      expectedState: state, prompt, signal: controller.signal,
      requestInput: async () => {
        const paste = pastes[prompts++];
        if (paste === undefined) throw new Error("unexpected prompt");
        return paste;
      },
    });
    expect(result).toEqual({ code: "valid", state });
    expect(prompts).toBe(3);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  test("manual-only cancellation bounds even a non-cooperative input and removes listener", async () => {
    const controller = new AbortController();
    const ready = Promise.withResolvers<void>();
    const paste = Promise.withResolvers<string>();
    const result = waitForCallbackOrManualPaste({
      expectedState: state, prompt, signal: controller.signal,
      requestInput: () => { ready.resolve(); return paste.promise; },
    });
    const observed = Promise.allSettled([result]);
    try {
      await ready.promise;
      controller.abort();
      const [outcome] = await observed;
      expect(outcome?.status).toBe("rejected");
      if (outcome?.status === "rejected") expect(outcome.reason).toBeInstanceOf(CallbackCancelledError);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort();
      paste.resolve("late-invalid");
      await observed;
    }
  }, 1000);

  test("manual-only broken input fails rather than waiting for a nonexistent callback", async () => {
    const error = new BridgeError("transport", "input closed");
    await expect(waitForCallbackOrManualPaste({
      expectedState: state, prompt, signal,
      requestInput: async () => { throw error; },
    })).rejects.toBe(error);
  });

  test("manual-only absent input is invalidRequest", async () => {
    await expect(waitForCallbackOrManualPaste({ expectedState: state, prompt, signal }))
      .rejects.toMatchObject({ kind: "invalidRequest" });
  });

  test("manual-only pre-abort never requests input", async () => {
    let calls = 0;
    await expect(waitForCallbackOrManualPaste({
      expectedState: state, prompt, signal: AbortSignal.abort(),
      requestInput: async () => { calls++; return `code#${state}`; },
    })).rejects.toBeInstanceOf(CallbackCancelledError);
    expect(calls).toBe(0);
  });

  test("a valid pasted redirect URL resolves the race without the callback", async () => {
    const wait = Promise.withResolvers<{ code: string; state: string }>();
    void wait.promise.catch(() => undefined);
    const result = await waitForCallbackOrManualPaste({
      wait: wait.promise,
      expectedState: state,
      prompt,
      signal,
      requestInput: async () => `http://127.0.0.1:1/callback?code=pasted&state=${state}`,
    });
    expect(result).toEqual({ code: "pasted", state });
  });

  test("re-prompts for pastes without a code or with a mismatched state", async () => {
    const wait = Promise.withResolvers<{ code: string; state: string }>();
    void wait.promise.catch(() => undefined);
    const pastes = [
      "http://127.0.0.1:1/callback",
      "?code=abc&state=wrong",
      "",
      `final-code#${state}`,
    ];
    let calls = 0;
    const result = await waitForCallbackOrManualPaste({
      wait: wait.promise,
      expectedState: state,
      prompt,
      signal,
      requestInput: async () => {
        const paste = pastes[calls];
        calls += 1;
        if (paste === undefined) {
          throw new Error("no further pastes");
        }
        return paste;
      },
    });
    expect(calls).toBe(4);
    expect(result).toEqual({ code: "final-code", state });
  });

  test("a stateless raw-code paste is rejected and re-prompted", async () => {
    const wait = Promise.withResolvers<{ code: string; state: string }>();
    void wait.promise.catch(() => undefined);
    let calls = 0;
    const result = await waitForCallbackOrManualPaste({
      wait: wait.promise,
      expectedState: state,
      prompt,
      signal,
      requestInput: async () => {
        calls += 1;
        return calls === 1 ? "stateless-code" : `stateful-code#${state}`;
      },
    });
    expect(calls).toBe(2);
    expect(result).toEqual({ code: "stateful-code", state });
  });

  test("the callback wins while a paste is still pending", async () => {
    const callback = { code: "loopback-code", state };
    const wait = Promise.resolve(callback);
    const result = await waitForCallbackOrManualPaste({
      wait,
      expectedState: state,
      prompt,
      signal,
      requestInput: () => new Promise<string>(() => {}),
    });
    expect(result).toEqual(callback);
  });

  test("stops re-prompting once the loopback callback has won the race", async () => {
    const callback = { code: "loopback-code", state };
    const wait = Promise.resolve(callback);
    let promptCalls = 0;
    const result = await waitForCallbackOrManualPaste({
      wait,
      expectedState: state,
      prompt,
      signal,
      requestInput: async () => {
        promptCalls += 1;
        // Invalid paste landing after the callback settled.
        return "http://127.0.0.1:1/callback";
      },
    });
    expect(result).toEqual(callback);
    expect(promptCalls).toBe(1);
  });

  test("a failed input channel settles on the callback outcome", async () => {
    const callback = { code: "loopback-code", state };
    const wait = Promise.resolve(callback);
    const result = await waitForCallbackOrManualPaste({
      wait,
      expectedState: state,
      prompt,
      signal,
      requestInput: async () => {
        throw new BridgeError("transport", "login input ended");
      },
    });
    expect(result).toEqual(callback);
  });

  test("without requestInput the race is the plain callback wait", async () => {
    const callback = { code: "loopback-code", state };
    const result = await waitForCallbackOrManualPaste({
      wait: Promise.resolve(callback),
      expectedState: state,
      prompt,
      signal,
    });
    expect(result).toEqual(callback);
  });
});

describe("rethrowWithRefreshedCredential", () => {
  const rotated: BridgeCredential = { kind: "oauth", secret: "new-access", oauth: { access: "new-access" } };

  test("rethrows a BridgeError carrying the rotated credential", () => {
    const original = new BridgeError("rateLimited", "usage endpoint returned HTTP 429", { retryAfterMs: 17_000 });
    try {
      rethrowWithRefreshedCredential(original, rotated);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError);
      const bridgeError = error as BridgeError;
      expect(bridgeError.kind).toBe("rateLimited");
      expect(bridgeError.message).toBe("usage endpoint returned HTTP 429");
      expect(bridgeError.retryAfterMs).toBe(17_000);
      expect(bridgeError.refreshedCredential).toEqual(rotated);
    }
  });

  test("leaves the error untouched when nothing rotated", () => {
    const original = new BridgeError("noData", "nothing usable");
    try {
      rethrowWithRefreshedCredential(original, undefined);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  test("rethrows non-bridge errors as-is", () => {
    const original = new Error("unexpected");
    try {
      rethrowWithRefreshedCredential(original, rotated);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBe(original);
    }
  });
});
