import { describe, expect, test } from "bun:test";
import { fetchFixtureUsage } from "../src/connectors/fixture";
import { BridgeError, encodeBridgeResponse } from "../src/protocol";
import type { BridgeCredential } from "../src/protocol";
import { buildUsageRequest, expectNoModelFields, readFixtureSource } from "./helpers";

const FIXTURE_REQUEST = buildUsageRequest();

const OAUTH_FIXTURE_CREDENTIAL: BridgeCredential = {
  kind: "oauth",
  secret: "oauth-access-1",
  oauth: {
    access: "oauth-access-1",
    refresh: "oauth-refresh-1",
    expiresAtMs: 1787014800000,
    refreshEndpoint: "https://auth.unit.test/token",
    clientId: "client-1",
    identity: { login: "octocat" },
  },
};

const NOW_MS = 1787011200250;

function fetchComplete(): ReturnType<typeof fetchFixtureUsage> {
  return fetchFixtureUsage({
    request: FIXTURE_REQUEST,
    fixtureSource: readFixtureSource("quota.json"),
    nowMs: NOW_MS,
  });
}

function bridgeErrorFrom(action: () => unknown): BridgeError {
  try {
    action();
  } catch (error) {
    if (error instanceof BridgeError) {
      return error;
    }
    throw new Error(`expected BridgeError, got ${String(error)}`);
  }
  throw new Error("expected BridgeError but the action succeeded");
}

const EXPECTED_WINDOWS = [
  { id: "premium-requests-5h", unit: "requests", resolvedFraction: 0.8, severity: "warning", used: 80, limit: 100, resetsAtMs: 1787014800000 },
  { id: "core-tokens-5h", unit: "tokens", resolvedFraction: 0.95, severity: "critical" },
  { id: "spend-usd-monthly", unit: "usd", resolvedFraction: 1.2, severity: "exhausted", used: 1200, limit: 1000, resetsAtMs: 1789603200000 },
  { id: "explicit-requests-7d", unit: "requests", resolvedFraction: 0.25, severity: "ok", used: 25, limit: 100 },
  { id: "percent-minutes-weekly", unit: "minutes", resolvedFraction: 0.42, severity: "ok" },
  { id: "capacity-percent-daily", unit: "percent", resolvedFraction: 0.76, severity: "ok", resetsAtMs: 1787022000000 },
  { id: "bonus-credits-reset", unit: "unknown", severity: "unknown", resetCredits: 120, resetsAtMs: 1787014800000 },
] as const;

describe("fetchFixtureUsage — complete fixture", () => {
  test("returns a correlated success envelope when the complete fixture is normalized", () => {
    const response = fetchComplete();
    expect(response.status).toBe("ok");
    expect(response.requestId).toBe(FIXTURE_REQUEST.requestId);
    expect(response.providerId).toBe("fixture");
    expect(response.connectorId).toBe("fixture");
    expect(response.accountRef).toBe(FIXTURE_REQUEST.accountRef);
    expect(response.completedAtMs).toBe(NOW_MS);
  });

  test("carries quota provenance when the report is assembled", () => {
    const report = fetchComplete().report;
    expect(report.productKind).toBe("quota");
    expect(report.sourceKind).toBe("localObserved");
    expect(report.fetchedAtMs).toBe(1787011200000);
    expect(report.connectorVersion).not.toBe("");
  });

  test("preserves fixture window order when windows are normalized", () => {
    const ids = fetchComplete().report.windows.map((window) => window.id);
    expect(ids).toEqual(EXPECTED_WINDOWS.map((window) => window.id));
  });

  test("resolves fraction, severity, amounts and resets per window when precedence runs", () => {
    const windows = fetchComplete().report.windows;
    for (const expected of EXPECTED_WINDOWS) {
      const window = windows.find((candidate) => candidate.id === expected.id);
      if (window === undefined) {
        throw new Error(`window ${expected.id} missing from report`);
      }
      expect(window.unit).toBe(expected.unit);
      expect(window.severity).toBe(expected.severity);
      if ("resolvedFraction" in expected) {
        expect(window.resolvedFraction).toBe(expected.resolvedFraction);
      } else {
        expect(window.resolvedFraction).toBeUndefined();
      }
      if ("used" in expected) {
        expect(window.used).toBe(expected.used);
      } else {
        expect(window.used).toBeUndefined();
      }
      if ("limit" in expected) {
        expect(window.limit).toBe(expected.limit);
      } else {
        expect(window.limit).toBeUndefined();
      }
      if ("resetsAtMs" in expected) {
        expect(window.resetsAtMs).toBe(expected.resetsAtMs);
      }
      if ("resetCredits" in expected) {
        expect(window.resetCredits).toBe(expected.resetCredits);
      } else {
        expect(window.resetCredits).toBeUndefined();
      }
    }
  });

  test("leaks no raw fixture body, credential or model fields when encoded", () => {
    const encoded = encodeBridgeResponse(fetchComplete());
    expect(encoded).toContain("premium-requests-5h");
    expect(encoded).not.toContain("demo");
    expect(encoded).not.toContain("snapshotVersion");
    expect(encoded).not.toContain("secret");
    expectNoModelFields(JSON.parse(encoded));
  });

  test("accepts an oauth credential when the 1.2.0 credential union feeds the fixture path", () => {
    const request = buildUsageRequest({ credential: OAUTH_FIXTURE_CREDENTIAL });
    const response = fetchFixtureUsage({
      request,
      fixtureSource: readFixtureSource("quota.json"),
      nowMs: NOW_MS,
    });
    expect(response.status).toBe("ok");
    const encoded = encodeBridgeResponse(response);
    expect(encoded).not.toContain("oauth-access-1");
    expect(encoded).not.toContain("oauth-refresh-1");
  });

  test("omits refreshedCredential when the fixture connector does not rotate tokens", () => {
    const response = fetchComplete();
    expect("refreshedCredential" in response).toBe(false);
    expect("refreshedCredential" in JSON.parse(encodeBridgeResponse(response))).toBe(false);
  });
});

describe("fetchFixtureUsage — rejection cases", () => {
  test("rejects the malformed fixture file with malformedPayload when JSON is broken", () => {
    const error = bridgeErrorFrom(() =>
      fetchFixtureUsage({
        request: FIXTURE_REQUEST,
        fixtureSource: readFixtureSource("malformed.json"),
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("rejects schema-violating JSON with malformedPayload when the shape is wrong", () => {
    const source = JSON.stringify({ snapshotVersion: "t", fetchedAtMs: 1, windows: "nope" });
    const error = bridgeErrorFrom(() =>
      fetchFixtureUsage({ request: FIXTURE_REQUEST, fixtureSource: source, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });

  test("rejects the partial fixture file with partialPayload when a required window lacks amounts", () => {
    const error = bridgeErrorFrom(() =>
      fetchFixtureUsage({
        request: FIXTURE_REQUEST,
        fixtureSource: readFixtureSource("partial.json"),
        nowMs: NOW_MS,
      }),
    );
    expect(error.kind).toBe("partialPayload");
  });

  test("rejects duplicate limit IDs with malformedPayload when windows collide", () => {
    const source = JSON.stringify({
      snapshotVersion: "t",
      fetchedAtMs: 1,
      windows: [
        { id: "dupe", label: "D", unit: "requests", used: 1, limit: 2 },
        { id: "dupe", label: "D", unit: "requests", used: 1, limit: 2 },
      ],
    });
    const error = bridgeErrorFrom(() =>
      fetchFixtureUsage({ request: FIXTURE_REQUEST, fixtureSource: source, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("dupe");
  });

  test("rejects inconsistent fraction vs amounts with malformedPayload when they disagree", () => {
    const source = JSON.stringify({
      snapshotVersion: "t",
      fetchedAtMs: 1,
      windows: [{ id: "conflicted", label: "C", unit: "requests", fraction: 0.95, used: 5, limit: 100 }],
    });
    const error = bridgeErrorFrom(() =>
      fetchFixtureUsage({ request: FIXTURE_REQUEST, fixtureSource: source, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
    expect(error.message).toContain("conflicted");
  });

  test("rejects unknown units with malformedPayload when the unit is outside the protocol set", () => {
    const source = JSON.stringify({
      snapshotVersion: "t",
      fetchedAtMs: 1,
      windows: [{ id: "weird-unit", label: "W", unit: "parsecs", used: 1, limit: 2 }],
    });
    const error = bridgeErrorFrom(() =>
      fetchFixtureUsage({ request: FIXTURE_REQUEST, fixtureSource: source, nowMs: NOW_MS }),
    );
    expect(error.kind).toBe("malformedPayload");
  });
});
