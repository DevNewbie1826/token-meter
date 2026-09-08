/** Test-only executable. Never imported by the release CLI. No live fetch fallback. */
import { failureEnvelope } from "../src/cli";
import { encodeBridgeResponse, parseBridgeRequest } from "../src/protocol";
import type { BridgeRequest } from "../src/protocol";
import type { Fetcher } from "../src/connectors/provider-http";
import { createXaiOauthConnector, xaiOauthConnector } from "../src/providers/xai-oauth";

const TOKEN = "https://auth.x.ai/oauth2/token";

function syntheticFetcher(request: BridgeRequest, cancel: () => void): Fetcher {
  if (request.credential?.kind !== "oauth") throw new Error("probe requires synthetic OAuth input");
  const oauth = request.credential.oauth;
  const scenario = oauth.identity?.["probeScenario"] ?? "";
  const threshold = /^threshold-(80|87\.5|89\.9|95|99\.9)$/.exec(scenario)?.[1];
  const weeklyAmount = {
    currentPeriod: { start: "2026-08-10T00:00:00Z", end: "2026-08-24T00:00:00Z", type: "WEEK" },
    creditUsagePercent: 42, isUnifiedBillingUser: true,
  };
  const monthlyAmount = {
    billingPeriodStart: "2026-08-01T00:00:00Z", billingPeriodEnd: "2026-09-01T00:00:00Z",
    used: { val: 120 }, monthlyLimit: { val: 100 },
  };
  const onDemand = { onDemandUsed: { val: 120 }, onDemandCap: { val: 100 } };
  const monthlyOverflow = { ...monthlyAmount, used: { val: Number.MAX_VALUE }, monthlyLimit: { val: Number.MIN_VALUE } };
  const onDemandOverflow = { onDemandUsed: { val: Number.MAX_VALUE }, onDemandCap: { val: Number.MIN_VALUE } };
  // Upstream HTTP fixtures only: normalization remains in the real adapter.
  const amountCase = ([
    ["monthly-at-cap", 500, {}, 200, { ...monthlyAmount, used: { val: 100 } }],
    ["monthly-overage", 500, {}, 200, monthlyAmount],
    ["optional-monthly-overage", 200, weeklyAmount, 200, monthlyAmount],
    ["weekly-on-demand-overage", 200, { ...weeklyAmount, ...onDemand }, 500, {}],
    ["monthly-on-demand-overage", 500, {}, 200, { ...monthlyAmount, used: { val: 42 }, ...onDemand }],
    ["weekly-monthly-overflow", 200, weeklyAmount, 200, monthlyOverflow],
    ["weekly-on-demand-overflow", 200, { ...weeklyAmount, ...onDemandOverflow }, 500, {}],
    ["monthly-overflow-valid-on-demand", 500, {}, 200, { ...monthlyOverflow, ...onDemand, onDemandUsed: { val: 42 } }],
    ["monthly-valid-on-demand-overflow", 500, {}, 200, { ...monthlyAmount, used: { val: 42 }, ...onDemandOverflow }],
    ["both-ratios-overflow", 200, {}, 200, { ...monthlyOverflow, ...onDemandOverflow }],
  ] as const).find(([name]) => name === scenario);
  const scenarios = new Set([
    "credits-500", "credits-malformed", "weekly-monthly-500", "inferred-monthly-500", "inferred-zero-monthly",
    "no-data", "expired-inferred", "credits-401", "credits-403", "credits-429", "monthly-401", "monthly-403", "monthly-429",
    "rotated-rate", "rotated-no-data", "rotated-malformed", "retry-401-rate", "identity-timeout", "identity-cancel", "billing-cancel",
  ]);
  if (threshold === undefined && amountCase === undefined && !scenarios.has(scenario)) throw new Error("unknown xAI probe scenario");
  const percent = threshold === undefined ? 42 : Number(threshold);
  const weekly = { config: {
    currentPeriod: { start: "2026-08-10T00:00:00Z", end: "2026-08-24T00:00:00Z", type: "WEEK" },
    creditUsagePercent: percent,
    productUsage: [{ product: "GrokBuild", usagePercent: percent }],
    isUnifiedBillingUser: true,
    onDemandCap: { val: 100 }, onDemandUsed: { val: percent },
  } };
  const monthly = { config: {
    billingPeriodStart: "2026-08-01T00:00:00Z", billingPeriodEnd: "2026-09-01T00:00:00Z",
    used: { val: percent }, monthlyLimit: { val: 100 },
  } };
  let creditsCalls = 0;
  return async (url, init) => {
    if (init.signal?.aborted) throw init.signal.reason;
    if (url === "https://auth.x.ai/.well-known/openid-configuration") {
      return Response.json({ token_endpoint: TOKEN });
    }
    if (url === TOKEN) {
      return Response.json({ access_token: `${oauth.access}-rotated`, refresh_token: `${oauth.refresh}-rotated`, expires_in: 3600 });
    }
    const credits = url === "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
    if (url === "https://auth.x.ai/oauth2/userinfo") {
      cancel();
      init.signal?.throwIfAborted();
      return Response.json({});
    }
    const isMonthly = url === "https://cli-chat-proxy.grok.com/v1/billing";
    if (!credits && !isMonthly) throw new Error("unrouted synthetic HTTP request");
    if (amountCase !== undefined) {
      const [, creditsStatus, creditsConfig, monthlyStatus, monthlyConfig] = amountCase;
      return Response.json({ config: credits ? creditsConfig : monthlyConfig }, { status: credits ? creditsStatus : monthlyStatus });
    }
    if (credits) creditsCalls += 1;
    if (scenario === "retry-401-rate" && credits && creditsCalls === 1) return Response.json({}, { status: 401 });
    if (scenario === "billing-cancel") {
      cancel();
      init.signal?.throwIfAborted();
    }
    if (scenario === "retry-401-rate" || scenario === "rotated-rate") {
      return Response.json({}, { status: 429, headers: { "retry-after": "19" } });
    }
    if (scenario === "rotated-no-data" || scenario === "no-data") return Response.json({ config: {} });
    if (scenario === "rotated-malformed") return new Response("not JSON");
    const boundary = /^(credits|monthly)-(401|403|429)$/.exec(scenario);
    if (boundary && ((boundary[1] === "credits") === credits)) {
      return Response.json({}, { status: Number(boundary[2]), headers: { "retry-after": "19" } });
    }
    if (scenario === "credits-500" && credits) return Response.json({}, { status: 500 });
    if (scenario === "credits-malformed" && credits) return new Response("not JSON");
    if ((scenario === "weekly-monthly-500" || scenario === "inferred-monthly-500") && isMonthly) {
      return Response.json({}, { status: 500 });
    }
    if (scenario === "inferred-monthly-500" && credits) {
      return Response.json({ config: { currentPeriod: weekly.config.currentPeriod, isUnifiedBillingUser: true } });
    }
    if (scenario === "expired-inferred") {
      return Response.json(credits ? { config: {
        currentPeriod: { ...weekly.config.currentPeriod, end: "2026-08-17T00:00:00Z" },
      } } : { config: {} });
    }
    if (scenario === "inferred-zero-monthly") {
      return Response.json(credits
        ? { config: { currentPeriod: weekly.config.currentPeriod, isUnifiedBillingUser: true } }
        : { config: { monthlyLimit: { val: 0 } } });
    }
    return Response.json(credits ? weekly : monthly);
  };
}

let request: BridgeRequest | undefined;
try {
  request = parseBridgeRequest(await Bun.stdin.text());
  const scenario = request.credential?.kind === "oauth" ? request.credential.oauth.identity?.["probeScenario"] : undefined;
  const parent = new AbortController();
  const identity = new AbortController();
  const timedScenario = scenario === "identity-timeout" || scenario === "identity-cancel" || scenario === "billing-cancel";
  const connector = timedScenario ? createXaiOauthConnector(ms => ms === 15_000 ? identity.signal : parent.signal) : xaiOauthConnector;
  const cancel = () => {
    (scenario === "identity-timeout" ? identity : parent).abort(new DOMException("synthetic deadline", "TimeoutError"));
  };
  const response = await connector.fetchUsage({
    request, fetcher: syntheticFetcher(request, cancel), nowMs: request.requestedAtMs,
  });
  process.stdout.write(`${encodeBridgeResponse(response)}\n`);
} catch (error) {
  process.stdout.write(`${encodeBridgeResponse(failureEnvelope(request, error))}\n`);
  process.exitCode = 1;
}
