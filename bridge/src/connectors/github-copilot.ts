/**
 * GitHub Copilot connector over the documented user billing API:
 *   GET /user                                        (identity)
 *   GET /users/{login}/settings/billing/premium_request/usage
 *
 * Produces one aggregated billingUsage window (premium requests, monthly).
 * The documented response carries no allowance, so no fraction is resolved.
 * Per-model breakdowns are aggregated away; the credential never reaches any
 * message or the report.
 */

import { BridgeError, PROTOCOL_VERSION, isRecord } from "../protocol";
import type { BridgeRequest, BridgeSuccessResponse, UsageReport, UsageWindow } from "../protocol";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type GitHubUsageInput = {
  readonly request: BridgeRequest;
  readonly fetcher: Fetcher;
  readonly nowMs: number;
};

/** Upstream call context shared by every GitHub request in one usage fetch. */
type CallContext = {
  readonly fetcher: Fetcher;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
};

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "token-meter-bridge/1.0.0";
const CONNECTOR_VERSION = "github-billing-1";

type BillingUsageItem = {
  readonly unitType: string;
  readonly netQuantity: number;
};

export async function fetchGitHubCopilotUsage(input: GitHubUsageInput): Promise<BridgeSuccessResponse> {
  const credential = input.request.credential;
  if (credential === undefined) {
    throw new BridgeError("missingCredential", "github-copilot usage requires a credential");
  }
  const signal = AbortSignal.timeout(Math.max(1, input.request.deadlineAtMs - input.nowMs));
  const headers: Readonly<Record<string, string>> = {
    authorization: `Bearer ${credential.secret}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": API_VERSION,
    "user-agent": USER_AGENT,
  };
  const context: CallContext = { fetcher: input.fetcher, headers, signal };

  const login = await fetchLogin(context);
  const items = await fetchBillingItems(context, login);
  const used = sumPremiumRequests(items);
  const window: UsageWindow = {
    id: "premium-requests-monthly",
    label: "Premium requests (monthly)",
    unit: "requests",
    used,
    severity: "unknown",
  };
  const report: UsageReport = {
    productKind: "billingUsage",
    sourceKind: "documentedApi",
    fetchedAtMs: input.nowMs,
    connectorVersion: CONNECTOR_VERSION,
    windows: [window],
  };
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId: input.request.requestId,
    providerId: input.request.providerId,
    connectorId: input.request.connectorId,
    accountRef: input.request.accountRef,
    status: "ok",
    completedAtMs: input.nowMs,
    report,
  };
}

async function fetchLogin(context: CallContext): Promise<string> {
  const response = await callUpstream(context, `${API_ORIGIN}/user`, "identity endpoint");
  const body = await readJson(response, "identity endpoint");
  if (!isRecord(body)) {
    throw new BridgeError("malformedPayload", "identity endpoint returned a non-object body");
  }
  const login = body["login"];
  if (typeof login !== "string" || login === "") {
    throw new BridgeError("malformedPayload", "identity endpoint returned no login");
  }
  return login;
}

async function fetchBillingItems(context: CallContext, login: string): Promise<readonly BillingUsageItem[]> {
  const url = `${API_ORIGIN}/users/${encodeURIComponent(login)}/settings/billing/premium_request/usage`;
  const response = await callUpstream(context, url, "billing endpoint");
  const body = await readJson(response, "billing endpoint");
  if (!isRecord(body)) {
    throw new BridgeError("malformedPayload", "billing endpoint returned a non-object body");
  }
  const usageItems = body["usageItems"];
  if (!Array.isArray(usageItems)) {
    throw new BridgeError("malformedPayload", "billing endpoint returned no usageItems array");
  }
  return usageItems.map(itemFromValue);
}

function itemFromValue(value: unknown): BillingUsageItem {
  if (!isRecord(value)) {
    throw new BridgeError("malformedPayload", "billing usage item must be an object");
  }
  const unitType = value["unitType"];
  const netQuantity = value["netQuantity"];
  if (typeof unitType !== "string" || typeof netQuantity !== "number" || !Number.isFinite(netQuantity) || netQuantity < 0) {
    throw new BridgeError("malformedPayload", "billing usage item carries an unusable unitType/netQuantity");
  }
  return { unitType, netQuantity };
}

function sumPremiumRequests(items: readonly BillingUsageItem[]): number {
  const requestItems = items.filter((item) => item.unitType === "requests");
  if (requestItems.length === 0) {
    throw new BridgeError("noData", "billing report contained no premium request usage");
  }
  return requestItems.reduce((total, item) => total + item.netQuantity, 0);
}

async function callUpstream(context: CallContext, url: string, endpoint: string): Promise<Response> {
  let response: Response;
  try {
    response = await context.fetcher(url, { headers: context.headers, signal: context.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new BridgeError("timeout", `GitHub ${endpoint} exceeded the request deadline`);
    }
    throw new BridgeError("transport", `network failure contacting the GitHub ${endpoint}`);
  }
  ensureOk(response, endpoint);
  return response;
}

async function readJson(response: Response, endpoint: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new BridgeError("malformedPayload", `GitHub ${endpoint} returned a non-JSON body`);
  }
}

function ensureOk(response: Response, endpoint: string): void {
  if (response.ok) {
    return;
  }
  const status = response.status;
  if (status === 401) {
    throw new BridgeError("authRequired", `GitHub rejected the credential at the ${endpoint} (401)`);
  }
  if (status === 429) {
    throw new BridgeError("rateLimited", `GitHub rate limit hit at the ${endpoint} (429)`, {
      retryAfterMs: retryAfterMsFrom(response),
    });
  }
  if (status === 403) {
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      throw new BridgeError("rateLimited", `GitHub rate limit exhausted at the ${endpoint} (403)`);
    }
    throw new BridgeError("permissionDenied", `GitHub denied access at the ${endpoint} (403)`);
  }
  throw new BridgeError("upstreamError", `GitHub ${endpoint} failed (${status})`);
}

function retryAfterMsFrom(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) {
    return undefined;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}
