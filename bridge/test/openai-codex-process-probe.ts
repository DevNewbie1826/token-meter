/** Test-only compiled surface: actual Codex entry points, synthetic HTTP replies via stdin. */
import { scheduler } from "node:timers/promises";
import { runLoginSession } from "../src/cli";
import { lookupAuth } from "../src/dispatch";
import { fetchOpenAICodexUsage, loginOpenAICodex, openaiCodexAuth, refreshOpenAICodexCredential } from "../src/providers/openai-codex";
import { BridgeError, PROTOCOL_VERSION, isRecord, parseBridgeRequest } from "../src/protocol";
import type { AuthEvents } from "../src/dispatch";

const input: unknown = JSON.parse(await Bun.stdin.text());
if (!isRecord(input)) throw new Error("invalid probe input");
const request = parseBridgeRequest(JSON.stringify(input["request"]));
const action = input["action"];
const controller = new AbortController();
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
let state = "";
let usageCalls = 0;
const events: AuthEvents = {
  onEvent(event) {
    if (event.type === "openUrl") {
      state = new URL(event.url).searchParams.get("state") ?? "";
      if (input["cancel"] === true) controller.abort();
    }
  },
  requestInput: async () => `synthetic-code#${state}`,
};
const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
  const headers = new Headers(init.headers);
  // Trace only non-secret routing; credential bytes stay in wire stdout.
  console.error(JSON.stringify({ url, method: init.method, accountId: headers.get("ChatGPT-Account-Id") }));
  if (url === "https://auth.openai.com/oauth/token") return Response.json(input["tokens"]);
  if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
    return Response.json({ device_auth_id: "synthetic-device", user_code: "SYNTHETIC", interval: 5 });
  }
  if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
    return Response.json({ authorization_code: "synthetic-code", code_verifier: "synthetic-verifier" });
  }
  if (url === "https://chatgpt.com/backend-api/wham/usage") {
    usageCalls += 1;
    if (input["retry401"] === true && usageCalls === 1) return Response.json({}, { status: 401 });
    if (input["transportError"] === true) throw new Error(`network rejected ${headers.get("Authorization")}`);
    return Response.json(input["usage"], { status: typeof input["usageStatus"] === "number" ? input["usageStatus"] : 200 });
  }
  if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
    return Response.json({ available_count: 1 });
  }
  throw new Error("unexpected probe endpoint");
};
try {
  if (action === "session") {
    // Keep the production registration and login function intact. Only HTTP
    // and the device clock are replaced, inside this isolated test process.
    if (lookupAuth("openai-codex") !== openaiCodexAuth) throw new Error("unexpected Codex registration");
    const platformFetch = globalThis.fetch;
    const platformWait = scheduler.wait;
    globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (typeof url !== "string") throw new Error("unexpected fixture URL type");
      return await fetcher(url, init ?? {});
    }, { preconnect: platformFetch.preconnect });
    scheduler.wait = async () => undefined;
    let firstLine = true;
    let pendingRead = Promise.withResolvers<string | undefined>();
    let inputClosed = false;
    try {
      process.exitCode = await runLoginSession({
        readLine: async () => {
          if (firstLine) {
            firstLine = false;
            return JSON.stringify({ schemaVersion: PROTOCOL_VERSION, providerId: "openai-codex",
              method: input["method"], requestedAtMs: request.requestedAtMs, deadlineAtMs: request.deadlineAtMs });
          }
          return await pendingRead.promise;
        },
        writeOutput: line => console.log(line),
        writeEvent: line => {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event)) throw new Error("invalid session event");
          // Never log URLs, codes or prompt values; only event discriminators.
          console.error(JSON.stringify({ eventType: event["type"] }));
          if (event["type"] === "openUrl" && typeof event["url"] === "string") {
            state = new URL(event["url"]).searchParams.get("state") ?? "";
          }
          if (event["type"] === "prompt") {
            const reader = pendingRead;
            pendingRead = Promise.withResolvers<string | undefined>();
            reader.resolve(JSON.stringify({ type: "promptResponse", requestId: event["requestId"],
              value: `synthetic-code#${state}` }));
          }
        },
        closeInput: () => { inputClosed = true; pendingRead.resolve(undefined); },
      });
    } finally {
      globalThis.fetch = platformFetch;
      scheduler.wait = platformWait;
      console.error(JSON.stringify({ inputClosed }));
    }
  } else if (action === "usage") {
    console.log(JSON.stringify(await fetchOpenAICodexUsage({ request, fetcher, nowMs: request.requestedAtMs })));
  } else {
    let result;
    if (action === "refresh") {
      if (request.credential === undefined) throw new Error("missing probe credential");
      result = { credential: await refreshOpenAICodexCredential(request.credential, fetcher, signal) };
    } else if (action === "browser" || action === "device") {
      result = await loginOpenAICodex(action, {}, events, signal, { fetcher, sleep: async () => undefined });
    } else {
      throw new Error("invalid probe action");
    }
    console.log(JSON.stringify({ schemaVersion: PROTOCOL_VERSION, providerId: "openai-codex", status: "ok",
      completedAtMs: request.requestedAtMs, ...result }));
  }
} catch (error) {
  if (!(error instanceof BridgeError)) throw error;
  console.log(JSON.stringify({ schemaVersion: PROTOCOL_VERSION, providerId: "openai-codex", status: "error",
    completedAtMs: request.requestedAtMs,
    ...(action === "usage" ? { requestId: request.requestId, connectorId: request.connectorId, accountRef: request.accountRef } : {}),
    error: { kind: error.kind, message: error.message,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) },
    ...(error.refreshedCredential !== undefined ? { refreshedCredential: error.refreshedCredential } : {}),
  }));
}
if (action === "browser" || (action === "session" && input["method"] === "browser")) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch: () => new Response("cleanup") });
  server.stop(true);
  console.error(JSON.stringify({ cleanup: "port-1455-rebound" }));
}
