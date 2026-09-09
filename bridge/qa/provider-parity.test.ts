import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureRuntime } from "./runtime";
import { providerFor, scenarios, upstreamRoutes } from "./fixtures";
import type { Scenario } from "./fixtures";
import { PROTOCOL_VERSION } from "../src/protocol";
import type { BridgeRequest, UsageWindow } from "../src/protocol";

function assertWindows(scenario: Scenario, windows: readonly UsageWindow[]) {
  if (scenario === "xai-overage") {
    expect(windows.map(w => [w.used, w.limit, w.resolvedFraction, w.severity])).toEqual([
      [120, 100, 1.2, "exhausted"], [120, 100, 1.2, "exhausted"],
    ]);
  } else if (scenario.startsWith("xai-")) {
    const percent = Number(scenario.slice(4));
    expect(windows).toHaveLength(4);
    expect(windows.map(w => [w.resolvedFraction, w.severity])).toEqual(
      Array(4).fill([percent / 100, percent >= 95 ? "critical" : "warning"]));
  } else if (scenario === "ag-remaining") {
    expect(windows.map(w => [w.remaining, w.used, w.limit, w.resolvedFraction, w.unit, w.severity])).toEqual([
      [42.5, undefined, undefined, undefined, "unknown", "unknown"],
      [0, undefined, undefined, undefined, "unknown", "unknown"],
    ]);
  } else if (scenario === "ag-weekly") {
    expect(windows).toHaveLength(2);
    expect(windows.find(w => w.id.endsWith(":daily"))?.resolvedFraction).toBeCloseTo(0.1);
    expect(windows.find(w => w.id.endsWith(":weekly"))?.resolvedFraction).toBe(0.99);
    expect(windows.find(w => w.id.endsWith(":weekly"))?.resetsAtMs).toBeUndefined();
    expect(windows.map(w => w.severity)).toEqual(["critical", "ok"]);
  } else if (scenario === "zai-mixed") {
    expect(windows.map(w => [w.unit, w.resolvedFraction, w.severity])).toEqual([
      ["credits", 0.8, "warning"], ["tokens", 0.7999, "ok"],
      ["requests", 0.9499, "warning"], ["credits", 0.9999, "critical"],
    ]);
  } else if (scenario === "cursor-used") {
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ used: 42.5, unit: "requests", severity: "unknown" });
    expect(windows[0]?.resolvedFraction).toBeUndefined();
    expect(windows[0]?.limit).toBeUndefined();
  } else if (scenario === "opencode-12") {
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ used: 12, resolvedFraction: 0.12, severity: "ok", label: "5 Hour limit (rate-limited)" });
  } else if (scenario === "nekos") {
    expect(windows.map(w => w.resolvedFraction)).toEqual([0, 0, 18.39 / 100, 0, 33.55 / 100]);
  }
  expect(new Set(windows.map(w => w.id)).size).toBe(windows.length);
}

async function exercise(scenario: Scenario, routes?: Record<string, unknown>, assertion = assertWindows) {
  const profile = mkdtempSync(join(tmpdir(), "token-meter-parity-test-"));
  try {
    const runtime = fixtureRuntime(scenario, profile, routes);
    const providerId = providerFor(scenario)!;
    const auth = runtime.auth(providerId);
    const method = providerId === "google-antigravity" ? "browser" : providerId === "xai-oauth" ? "device" : "apiKey";
    const login = await auth.login(method, { apiKey: crypto.randomUUID() }, { onEvent: () => {} }, AbortSignal.timeout(5000));
    const now = Date.now();
    const request: BridgeRequest = { schemaVersion: PROTOCOL_VERSION, providerId, connectorId: providerId,
      requestId: crypto.randomUUID(), accountRef: crypto.randomUUID(), operation: "fetchUsage" as const,
      requestedAtMs: now, deadlineAtMs: now + 5000, credential: login.credential };
    const result = await runtime.usage(request);
    assertion(scenario, result.report.windows);
    if (scenario === "opencode-12") {
      await runtime.usage(request);
      expect(new Set(runtime.calls.map(c => c.installation)).size).toBe(1);
      expect(runtime.calls[0]?.installation).toBe(readFileSync(join(profile, "opencode-install-id"), "utf8").trim());
    }
    return runtime.calls;
  } finally { rmSync(profile, { recursive: true }); }
}

for (const scenario of scenarios.filter(s => providerFor(s))) {
  test(`actual auth and registered adapter: ${scenario}`, async () => {
    const calls = await exercise(scenario);
    expect(calls.length).toBeGreaterThan(0);
  });
}

test("unknown fixture routes fail even when optional provider probes tolerate errors", async () => {
  const routes = upstreamRoutes("xai-80", Date.now());
  delete routes["GET https://auth.x.ai/oauth2/userinfo"];
  await expect(exercise("xai-80", routes)).rejects.toThrow("Unexpected QA fixture route");
});

test("mutation proof: upstream amounts and availability mutations are detected by identical assertions", async () => {
  for (const scenario of ["ag-remaining", "cursor-used", "opencode-12", "zai-mixed", "xai-80", "ag-weekly", "nekos"] as const) {
    const routes = structuredClone(upstreamRoutes(scenario, Date.now()));
    // Mutate valid raw upstream fields, not imports or normalized reports.
    const encoded = JSON.stringify(routes);
    const replacements: Record<string, [string, string]> = {
      "ag-remaining": ['"42.5"', '"41.5"'], "cursor-used": ['42.5', '41.5'],
      "opencode-12": ['"rate-limited"', '"ok"'], "zai-mixed": ['7999', '8000'],
      "xai-80": ['"creditUsagePercent":80', '"creditUsagePercent":79'],
      "ag-weekly": ['"remainingFraction":0.01', '"remainingFraction":0.1'],
      "nekos": ['18.39', '19.39'],
    };
    const [before, after] = replacements[scenario]!;
    expect(encoded).toContain(before);
    await exercise(scenario, JSON.parse(encoded.replace(before, after)) as Record<string, unknown>, (name, windows) => {
      // Transport/auth must succeed. Only the existing value assertion may RED.
      expect(() => assertWindows(name, windows)).toThrow();
    });
  }
});

test("management-only progress remains pending until exact abort event", async () => {
  const runtime = fixtureRuntime("management", "/unused");
  const controller = new AbortController();
  const code = Promise.withResolvers<void>();
  const login = runtime.auth("kimi-code").login("device", {}, { onEvent(event) {
    if (event.type === "code") code.resolve();
  } }, controller.signal);
  await code.promise;
  controller.abort();
  await expect(login).rejects.toThrow("QA pending UI cancelled");
});
