import "../src/providers/index";
import { join } from "node:path";
import { lookupAuth, lookupConnector } from "../src/dispatch";
import type { AuthModule, AuthEvents, Fetcher } from "../src/dispatch";
import { BridgeError } from "../src/protocol";
import type { BridgeRequest } from "../src/protocol";
import { loginXaiOauth } from "../src/providers/xai-oauth";
import { loginAntigravity } from "../src/providers/google-antigravity";
import { loginCursor } from "../src/providers/cursor";
import { loginZai } from "../src/providers/zai";
import { loginNekos } from "../src/providers/nekos";
import { opencodeGoConnector } from "../src/providers/opencode-go";
import { providerFor, upstreamRoutes } from "./fixtures";
import type { Scenario } from "./fixtures";

// Capture actual registered modules once; no synthetic account/credential/report.
const authFor = (id: string): AuthModule => {
  const module = lookupAuth(id);
  if (!module) throw new BridgeError("invalidProvider", "QA provider not registered");
  return module;
};

export function fixtureRuntime(scenario: Scenario, profile: string,
  routes = upstreamRoutes(scenario, Date.now())) {
  const calls: { route: string; installation?: string }[] = [];
  let unexpected = false;
  let approval: Promise<void> | undefined;
  const fetcher: Fetcher = async (url, init) => {
    const route = `${init.method ?? "GET"} ${url}`;
    const installation = new Headers(init.headers).get("x-opencode-session");
    calls.push({ route, ...(installation ? { installation } : {}) });
    if (!Object.hasOwn(routes, route)) {
      unexpected = true;
      throw new BridgeError("invalidRequest", "Unexpected QA fixture route (external network prohibited)");
    }
    if (scenario === "xai-overage" && url.endsWith("?format=credits")) return Response.json({}, { status: 500 });
    // Allow the actual callback response to drain before the fast offline token
    // exchange finishes and the auth module closes its loopback listener.
    if (url === "https://oauth2.googleapis.com/token") await approval;
    return Response.json(routes[route]);
  };
  const assertRoutes = () => {
    // Some real adapters intentionally tolerate optional endpoint failures.
    // The harness still fails unknown routes, even when an adapter tolerates it.
    if (unexpected) throw new BridgeError("invalidRequest", "Unexpected QA fixture route");
  };
  function auth(id: string): AuthModule {
    const real = authFor(id);
    return { providerId: id, methods: real.methods, async login(method, inputs, events, signal) {
      if (scenario === "management") {
        // UI progress/cancel exercise ONLY, explicitly not provider auth proof.
        if (id === "alibaba-token-plan") {
          if (!events.requestInput) throw new BridgeError("transport", "QA prompt channel missing");
          await events.requestInput({ prompt: "QA region", inputKind: "text", sensitive: false }, signal);
          await events.requestInput({ prompt: "QA key", inputKind: "text", sensitive: true }, signal);
        }
        events.onEvent({ type: "openUrl", url: "https://example.invalid/qa-pending" });
        if (method === "device") events.onEvent({ type: "code", code: "QA-ONLY", verificationUrl: "https://example.invalid/qa-pending" });
        return await new Promise<never>((_, reject) => {
          const abort = () => reject(new BridgeError("timeout", "QA pending UI cancelled"));
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (providerFor(scenario) !== id) throw new BridgeError("invalidProvider", "Provider does not match QA scenario");
      let result;
      if (id === "google-antigravity") {
        // Actual auth creates a real loopback listener and random state. An
        // injected approval event sends only that exact localhost callback.
        const controlled: AuthEvents = { ...events, onEvent(event) {
          events.onEvent(event);
          if (event.type === "openUrl") {
            const authorization = new URL(event.url);
            const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
            if (callback.hostname !== "127.0.0.1" || callback.protocol !== "http:") throw new Error("Non-loopback QA callback");
            callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
            callback.searchParams.set("code", "qa-approved-code");
            approval = fetch(callback, { redirect: "error", signal }).then(async response => {
              await response.text();
              if (!response.ok) throw new Error("QA callback rejected");
            });
          }
        } };
        try { result = await loginAntigravity(method, inputs, controlled, signal, { fetcher }); }
        finally { await approval; }
      } else if (id === "xai-oauth") result = await loginXaiOauth(method, inputs, events, signal, { fetcher });
      else if (id === "cursor") result = await loginCursor(method, inputs, events, signal, { fetcher });
      else if (id === "zai") result = await loginZai(method, inputs, events, signal, { fetcher });
      else if (id === "nekos") result = await loginNekos(method, inputs, events, signal, { fetcher });
      else if (id === "opencode-go") result = await real.login(method, inputs, events, signal);
      else throw new BridgeError("invalidProvider", "No QA auth transport");
      assertRoutes();
      return result;
    } };
  }
  return { auth, fetcher, calls, async usage(request: BridgeRequest) {
    if (request.providerId !== providerFor(scenario) || request.connectorId !== request.providerId) {
      throw new BridgeError("invalidProvider", "QA request scenario/connector mismatch");
    }
    const connector = lookupConnector(request.providerId);
    if (!connector) throw new BridgeError("invalidProvider", "QA connector not registered");
    const input = { request, fetcher, nowMs: Date.now() };
    const response = request.providerId === "opencode-go"
      ? await opencodeGoConnector.fetchUsage({ ...input, installationIdPath: join(profile, "opencode-install-id") })
      : await connector.fetchUsage(input);
    assertRoutes();
    return response;
  } };
}
