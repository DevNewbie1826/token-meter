/**
 * Fixture (demo) connector. Normalizes a complete multi-window quota snapshot
 * into a TokenMeter/1.3.0 success envelope, or fails with typed
 * malformedPayload/partialPayload errors. Never emits partial values.
 */

import {
  BridgeError,
  PROTOCOL_VERSION,
  fractionsConsistent,
  isRecord,
  isUsageUnit,
  severityForFraction,
} from "../protocol";
import type { BridgeRequest, BridgeSuccessResponse, UsageReport, UsageWindow } from "../protocol";

export type FixtureUsageInput = {
  readonly request: BridgeRequest;
  readonly fixtureSource: string;
  readonly nowMs: number;
};

const SNAPSHOT_KEYS: readonly string[] = ["snapshotVersion", "fetchedAtMs", "notes", "windows"];
const WINDOW_KEYS: readonly string[] = [
  "id",
  "label",
  "unit",
  "used",
  "limit",
  "fraction",
  "remaining",
  "remainingFraction",
  "percentUsed",
  "resetsAtMs",
  "resetCredits",
];

type FixtureSnapshot = {
  readonly snapshotVersion: string;
  readonly fetchedAtMs: number;
  readonly windows: readonly unknown[];
};

export function fetchFixtureUsage(input: FixtureUsageInput): BridgeSuccessResponse {
  const snapshot = parseSnapshot(input.fixtureSource);
  const windows = normalizeWindows(snapshot.windows);
  const report: UsageReport = {
    productKind: "quota",
    sourceKind: "localObserved",
    fetchedAtMs: snapshot.fetchedAtMs,
    connectorVersion: snapshot.snapshotVersion,
    windows,
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

function parseSnapshot(source: string): FixtureSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new BridgeError("malformedPayload", "fixture snapshot is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new BridgeError("malformedPayload", "fixture snapshot must be a JSON object");
  }
  const record = parsed;
  for (const key of Object.keys(record)) {
    if (!SNAPSHOT_KEYS.includes(key)) {
      throw new BridgeError("malformedPayload", `unknown field "${key}" in fixture snapshot`);
    }
  }
  const snapshotVersion = fixtureString(record["snapshotVersion"], "snapshotVersion");
  const fetchedAtMs = fixtureEpochMs(record["fetchedAtMs"], "fetchedAtMs");
  if (!Array.isArray(record["windows"])) {
    throw new BridgeError("malformedPayload", "fixture snapshot windows must be an array");
  }
  if (record["windows"].length === 0) {
    throw new BridgeError("partialPayload", "fixture snapshot must carry at least one window");
  }
  return { snapshotVersion, fetchedAtMs, windows: record["windows"] };
}

function normalizeWindows(rawWindows: readonly unknown[]): readonly UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const raw of rawWindows) {
    const window = normalizeWindow(raw);
    if (seen.has(window.id)) {
      throw new BridgeError("malformedPayload", `duplicate limit id "${window.id}" in fixture snapshot`);
    }
    seen.add(window.id);
    windows.push(window);
  }
  return windows;
}

function normalizeWindow(value: unknown): UsageWindow {
  if (!isRecord(value)) {
    throw new BridgeError("malformedPayload", "fixture window must be a JSON object");
  }
  const record = value;
  for (const key of Object.keys(record)) {
    if (!WINDOW_KEYS.includes(key)) {
      throw new BridgeError("malformedPayload", `unknown field "${key}" in fixture window`);
    }
  }
  const id = fixtureString(record["id"], "window id");
  const label = record["label"] === undefined ? undefined : fixtureString(record["label"], "window label");
  const unit = record["unit"];
  if (!isUsageUnit(unit)) {
    throw new BridgeError("malformedPayload", `window "${id}" carries a unit outside the protocol unit set`);
  }
  const used = optionalNonNegative(record["used"], id, "used");
  const limit = optionalPositive(record["limit"], id, "limit");
  const remaining = optionalNonNegative(record["remaining"], id, "remaining");
  const fraction = optionalNonNegative(record["fraction"], id, "fraction");
  const percentUsed = optionalNonNegative(record["percentUsed"], id, "percentUsed");
  const remainingRaw = optionalNonNegative(record["remainingFraction"], id, "remainingFraction");
  const remainingFraction =
    remainingRaw === undefined ? undefined : remainingFractionValue(remainingRaw, id);
  const resetsAtMs =
    record["resetsAtMs"] === undefined ? undefined : fixtureEpochMs(record["resetsAtMs"], "resetsAtMs");
  const resetCredits = optionalNonNegative(record["resetCredits"], id, "resetCredits");

  if ((used !== undefined && limit === undefined) || (limit !== undefined && used === undefined && remaining === undefined)) {
    throw new BridgeError("partialPayload", `window "${id}" carries only one of used/limit`);
  }
  if (fraction !== undefined && used !== undefined && limit !== undefined && !fractionsConsistent(fraction, used, limit)) {
    throw new BridgeError("malformedPayload", `inconsistent fraction and used/limit amounts in window "${id}"`);
  }

  const resolvedFraction = resolveFraction({ fraction, used, limit, percentUsed, remainingFraction });
  if (resolvedFraction !== undefined && !Number.isFinite(resolvedFraction)) {
    throw new BridgeError("malformedPayload", `non-finite utilization ratio in window "${id}"`);
  }
  if (remaining !== undefined && limit !== undefined && remaining > limit) {
    throw new BridgeError("malformedPayload", `remaining exceeds limit in window "${id}"`);
  }
  // Compare normalized proportions to avoid overflow in used + remaining.
  // Overage usage legitimately leaves zero remaining quota.
  const expectedRemaining = resolvedFraction === undefined ? undefined : Math.max(0, 1 - resolvedFraction);
  if (remainingFraction !== undefined && expectedRemaining !== undefined && !fractionsConsistent(remainingFraction, expectedRemaining, 1)) {
    throw new BridgeError("malformedPayload", `inconsistent remainingFraction in window "${id}"`);
  }
  if (remaining !== undefined && limit !== undefined) {
    const expected = remainingFraction ?? expectedRemaining;
    if (expected !== undefined && !fractionsConsistent(expected, remaining, limit)) {
      throw new BridgeError("malformedPayload", `inconsistent remaining/limit amounts in window "${id}"`);
    }
  }
  if (resolvedFraction === undefined && remaining === undefined && resetCredits === undefined) {
    throw new BridgeError("partialPayload", `window "${id}" lacks any utilization or reset amounts`);
  }

  return {
    id,
    ...(label !== undefined ? { label } : {}),
    unit,
    ...(resolvedFraction !== undefined ? { resolvedFraction } : {}),
    severity: severityForFraction(resolvedFraction),
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(remainingFraction !== undefined ? { remainingFraction } : {}),
    ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    ...(resetCredits !== undefined ? { resetCredits } : {}),
  };
}

/** Utilization precedence: explicit fraction, used/limit, percent, inverted remaining. */
function resolveFraction(signals: {
  readonly fraction: number | undefined;
  readonly used: number | undefined;
  readonly limit: number | undefined;
  readonly percentUsed: number | undefined;
  readonly remainingFraction: number | undefined;
}): number | undefined {
  if (signals.fraction !== undefined) {
    return signals.fraction;
  }
  if (signals.used !== undefined && signals.limit !== undefined) {
    return signals.used / signals.limit;
  }
  if (signals.percentUsed !== undefined) {
    return signals.percentUsed / 100;
  }
  if (signals.remainingFraction !== undefined) {
    return 1 - signals.remainingFraction;
  }
  return undefined;
}

function remainingFractionValue(value: number, id: string): number {
  if (value > 1) {
    throw new BridgeError("malformedPayload", `window "${id}" field remainingFraction must be within [0, 1]`);
  }
  return value;
}

function fixtureString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BridgeError("malformedPayload", `${field} must be a non-empty string`);
  }
  return value;
}

function fixtureEpochMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeError("malformedPayload", `${field} must be a positive integer Unix millisecond timestamp`);
  }
  return value;
}

function optionalNonNegative(value: unknown, id: string, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BridgeError("malformedPayload", `window "${id}" field ${field} must be a finite non-negative number`);
  }
  return value;
}

function optionalPositive(value: unknown, id: string, field: string): number | undefined {
  const parsed = optionalNonNegative(value, id, field);
  if (parsed !== undefined && parsed <= 0) {
    throw new BridgeError("malformedPayload", `window "${id}" field ${field} must be greater than zero`);
  }
  return parsed;
}
