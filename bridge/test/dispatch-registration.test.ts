import { describe, expect, test } from "bun:test";
import "../src/providers/index";
import { lookupAuth, lookupConnector } from "../src/dispatch";
import type { AuthMethod } from "../src/dispatch";
import { LOCKED_PROVIDER_IDS, listProviderCapabilities } from "../src/registry";
import { buildUsageRequest, mockFetcher } from "./helpers";

const AUTH_METHOD_VALUES: readonly AuthMethod[] = ["apiKey", "browser", "device"];

const TOKEN = "ghp_unit-test-token-do-not-use";
const NOW_MS = 1787011200500;
const USER_URL = "https://api.github.com/user";
const BILLING_URL = "https://api.github.com/users/octocat/settings/billing/premium_request/usage";

describe("provider registration", () => {
  test("resolves a connector and an auth module for every locked provider", () => {
    expect(LOCKED_PROVIDER_IDS.length).toBe(16);
    for (const id of LOCKED_PROVIDER_IDS) {
      const connector = lookupConnector(id);
      const auth = lookupAuth(id);
      if (connector === undefined || auth === undefined) {
        throw new Error(`provider "${id}" did not register both a connector and an auth module`);
      }
      expect(connector.providerId).toBe(id);
      expect(auth.providerId).toBe(id);
      expect(connector.connectorVersion).not.toBe("");
      expect(auth.methods.length).toBeGreaterThan(0);
      for (const method of auth.methods) {
        expect(AUTH_METHOD_VALUES).toContain(method);
      }
    }
  });

  test("keeps the fixture connector out of the dispatch registry", () => {
    expect(lookupConnector("fixture")).toBeUndefined();
    expect(lookupAuth("fixture")).toBeUndefined();
  });

  test("registry authMethods mirror the registered auth modules", () => {
    for (const capability of listProviderCapabilities()) {
      const auth = lookupAuth(capability.id);
      if (auth === undefined) {
        throw new Error(`provider "${capability.id}" did not register an auth module`);
      }
      expect(auth.methods).toEqual(capability.authMethods);
    }
  });

  test("dispatches github-copilot usage to the billing window via the registered connector", async () => {
    const connector = lookupConnector("github-copilot");
    if (connector === undefined) {
      throw new Error("github-copilot did not register a connector");
    }
    const fetcher = mockFetcher({
      [`GET ${USER_URL}`]: { status: 200, body: { login: "octocat" } },
      [`GET ${BILLING_URL}`]: { status: 200, body: { usageItems: [{ unitType: "requests", netQuantity: 45 }] } },
    });
    const response = await connector.fetchUsage({
      request: buildUsageRequest({
        providerId: "github-copilot",
        connectorId: "github-copilot",
        credential: { kind: "bearer", secret: TOKEN },
      }),
      fetcher,
      nowMs: NOW_MS,
    });

    expect(response.status).toBe("ok");
    expect(response.providerId).toBe("github-copilot");
    expect(response.report.windows).toEqual([
      {
        id: "premium-requests-monthly",
        label: "Premium requests (monthly)",
        unit: "requests",
        used: 45,
        severity: "unknown",
      },
    ]);
    expect(JSON.stringify(response)).not.toContain(TOKEN);
  });
});
