/** Test-only compiled Copilot surface. No release import, external HTTP or auth store. */
import { runLoginSession, failureEnvelope } from "../src/cli";
import { registerAuth } from "../src/dispatch";
import { githubCopilotAuth, githubCopilotConnector, loginGitHubCopilot } from "../src/providers/github-copilot";
import { parseBridgeRequest } from "../src/protocol";
import type { Fetcher } from "../src/connectors/provider-http";

const mode = process.argv.at(-1) ?? "usage";
const raw = await Bun.stdin.text();
const fetcher: Fetcher = async (url, init) => {
  // Construct a real Fetch Request so form encoding/headers use the actual surface.
  const outgoing = new Request(url, init);
  const path = new URL(outgoing.url).pathname;
  if (path === "/login/device/code") {
    if (mode === "cancel-device") return await new Promise<Response>(() => {});
    return Response.json({ device_code: "synthetic-device +/&=", user_code: "TEST-1234",
      verification_uri: "https://github.com/login/device", interval: mode === "cancel-wait" ? 60 : 1, expires_in: 300 });
  }
  if (path === "/login/oauth/access_token") {
    if (mode === "cancel-poll") return await new Promise<Response>(() => {});
    return Response.json({ access_token: "synthetic-copilot-new-token", token_type: "bearer" });
  }
  if (path === "/user") return Response.json({ login: "octocat" });
  if (path.endsWith("/settings/billing/premium_request/usage")) {
    return mode === "fallback" ? Response.json({}, { status: 500 }) : Response.json({
      usageItems: [{ unitType: "requests", netQuantity: 45 }],
    });
  }
  if (path === "/copilot_internal/user") {
    const fraction = mode === "critical" ? 0.95 : 0.8;
    return Response.json({ quota_reset_date: "2026-10-01T00:00:00Z", quota_snapshots: {
      premium_interactions: { entitlement: 1000, remaining: Math.round(1000 * (1 - fraction)),
        percent_remaining: 100 * (1 - fraction), unlimited: mode === "unlimited" },
    } });
  }
  throw new Error("unexpected Copilot fixture route");
};

if (mode.startsWith("login") || mode.startsWith("cancel")) {
  registerAuth({ ...githubCopilotAuth, login: (method, inputs, events, signal) =>
    loginGitHubCopilot(method, inputs, events, signal, {
      fetcher,
      ...(mode === "cancel-wait" ? {} : { sleep: async () => {} }),
    }),
  });
  let first = true;
  process.exitCode = await runLoginSession({
    readLine: async () => { if (!first) return undefined; first = false; return raw.trim(); },
    writeOutput: line => process.stdout.write(`${line}\n`),
    writeEvent: line => process.stderr.write(`${line}\n`),
    closeInput: () => {},
  });
} else {
  const request = parseBridgeRequest(raw);
  try {
    const response = await githubCopilotConnector.fetchUsage({ request, fetcher, nowMs: Date.now() });
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(failureEnvelope(request, error))}\n`);
    process.exitCode = 1;
  }
}
