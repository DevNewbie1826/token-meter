// Test-only upstream responses. Never imported by src/cli.ts or providers/index.
import nekos from "../fixtures/nekos-usage.json";
import zai from "../fixtures/zai/mixed.json";
import remaining from "../fixtures/antigravity-remaining.json";
import antigravity from "../fixtures/antigravity-boundaries.json";

export const scenarios = ["management", "empty", "xai-80", "xai-87.5", "xai-89.9", "xai-95", "xai-99.9",
  "xai-overage", "zai-mixed", "ag-remaining", "ag-weekly", "cursor-used", "opencode-12", "nekos"] as const;
export type Scenario = typeof scenarios[number];
export function parseScenario(value: string | undefined): Scenario {
  if (!scenarios.includes(value as Scenario)) throw new Error("Unknown QA scenario");
  return value as Scenario;
}
export function providerFor(scenario: Scenario): string | undefined {
  if (scenario.startsWith("xai-")) return "xai-oauth";
  if (scenario.startsWith("ag-")) return "google-antigravity";
  return ({ "zai-mixed": "zai", "cursor-used": "cursor", "opencode-12": "opencode-go", nekos: "nekos" } as Record<string, string>)[scenario];
}

export function upstreamRoutes(scenario: Scenario, now: number): Record<string, unknown> {
  const end = new Date(now + 7 * 86400_000).toISOString();
  const percent = Number(scenario.slice(4));
  const xai = scenario.startsWith("xai-");
  const ag = scenario.startsWith("ag-");
  return {
    ...(xai ? {
      "GET https://auth.x.ai/.well-known/openid-configuration": { token_endpoint: "https://auth.x.ai/oauth2/token" },
      "POST https://auth.x.ai/oauth2/device/code": { device_code: "qa-device", user_code: "QA-ONLY", verification_uri: "https://auth.x.ai/activate", verification_uri_complete: "https://auth.x.ai/activate?user_code=QA-ONLY", expires_in: 300, interval: 1 },
      "POST https://auth.x.ai/oauth2/token": { access_token: "qa-access", refresh_token: "qa-refresh", token_type: "Bearer", expires_in: 3600 },
      "GET https://auth.x.ai/oauth2/userinfo": { sub: "qa-account", email: "qa@example.invalid" },
      "GET https://cli-chat-proxy.grok.com/v1/billing?format=credits": { config: {
        currentPeriod: { start: new Date(now - 86400_000).toISOString(), end, type: "WEEK" },
        creditUsagePercent: percent, isUnifiedBillingUser: true,
        productUsage: [{ product: "GrokBuild", usagePercent: percent }],
        onDemandUsed: { val: percent }, onDemandCap: { val: 100 },
      } },
      "GET https://cli-chat-proxy.grok.com/v1/billing": { config: {
        billingPeriodStart: new Date(now - 86400_000).toISOString(), billingPeriodEnd: end,
        used: { val: scenario === "xai-overage" ? 120 : percent }, monthlyLimit: { val: 100 },
        ...(scenario === "xai-overage" ? { onDemandUsed: { val: 120 }, onDemandCap: { val: 100 } } : {}),
      } },
    } : {}),
    ...(ag ? {
      "POST https://oauth2.googleapis.com/token": { access_token: "qa-access", refresh_token: "qa-refresh", expires_in: 3600 },
      "GET https://www.googleapis.com/oauth2/v1/userinfo?alt=json": { email: "qa@example.invalid" },
      "POST https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": {
        currentTier: { id: "free-tier" }, paidTier: { id: "paid" }, cloudaicompanionProject: "qa-project",
      },
      "POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary": scenario === "ag-remaining" ? remaining : {},
      ...(scenario === "ag-weekly" ? {
        "POST https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels": {
          models: { google: { ...antigravity["legacy-independent"].legacy.models.google,
            quotaInfos: [{ windowId: "daily", remainingFraction: 0.9, resetTime: end }, { windowId: "weekly", remainingFraction: 0.01 }] } },
        },
      } : {}),
    } : {}),
    ...(scenario === "zai-mixed" ? {
      "POST https://api.z.ai/api/coding/paas/v4/chat/completions": {},
      "GET https://api.z.ai/api/monitor/usage/quota/limit": zai,
    } : {}),
    ...(scenario === "cursor-used" ? {
      "GET https://api2.cursor.sh/auth/usage": { coreRequests: { numRequests: 42.5, maxRequestUsage: null } },
    } : {}),
    ...(scenario === "opencode-12" ? {
      "GET https://opencode.ai/zen/go/v1/usage": { usage: {
        rolling: { percent: 12, status: "rate-limited", resetsAt: end },
        weekly: { percent: 20, status: "ok", resetsAt: end },
        monthly: { percent: 30, status: "ok", resetsAt: end },
      } },
    } : {}),
    ...(scenario === "nekos" ? { "GET https://claude.nekos.me/v1/usage/self": nekos } : {}),
  };
}
