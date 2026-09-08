/**
 * OpenCode Go usage, hand-ported from packages/ai/src/usage/opencode-go.ts
 * @ d720e81fb747132f0b6c6c0f44eafc887552ec7f.
 * Auth is retained from packages/ai/src/registry/oauth/opencode.ts and
 * packages/ai/src/registry/opencode-go.ts @ 8500092296621a6826b7136e840f8a59ea338958;
 * those provider-specific registry files no longer exist at the usage pin.
 *
 * Auth is explicitly not OAuth: open https://opencode.ai/auth and paste the
 * API key. Usage is GET https://opencode.ai/zen/go/v1/usage with Bearer auth.
 */
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuthEvents, AuthMethod, AuthModule, ConnectorModule, LoginInputs, LoginResult } from "../dispatch";
import { callProviderHttp } from "../connectors/provider-http";
import { BridgeError, PROTOCOL_VERSION, isRecord, severityForFraction } from "../protocol";
import type { BridgeSuccessResponse, UsageWindow } from "../protocol";

const PROVIDER_ID = "opencode-go";
const CONNECTOR_VERSION = "opencode-go-1";
const AUTH_URL = "https://opencode.ai/auth";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
// Current upstream packages/utils/src/dirs.ts + package.json at the pin above.
const USER_AGENT = "omp/18.1.14";

/** Non-secret installation metadata, separate from auth.json and ProviderAccounts. */
function installationId(path: string): string {
  try {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = mkdtempSync(join(directory, ".opencode-install-"));
      try {
        const candidate = join(temporary, "id");
        writeFileSync(candidate, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
        try {
          // Publish a complete file without overwriting a concurrent winner.
          // Direct O_EXCL creation at `path` would expose an empty file to readers.
          linkSync(candidate, path);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        }
        contents = readFileSync(path, "utf8");
      } finally {
        rmSync(temporary, { recursive: true });
      }
    }
    const id = contents.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new BridgeError("dependencyUnavailable", "OpenCode installation metadata is invalid");
    }
    return id;
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    // Never leak filesystem paths/content or silently use a per-process identity.
    throw new BridgeError("dependencyUnavailable", "OpenCode installation metadata is unavailable");
  }
}

/**
 * OMP `OPENCODE_GO_WINDOWS` limit ids / labels. Monthly is the subscription
 * anniversary — resetsAtMs is reported, with no duration semantics.
 */
const OPENCODE_GO_WINDOWS = [
  { key: "rolling", id: "rolling-5h", label: "5 Hour limit" },
  { key: "weekly", id: "weekly", label: "Weekly limit" },
  { key: "monthly", id: "monthly", label: "Monthly limit" },
] as const;

function decodeWindow(
  descriptor: (typeof OPENCODE_GO_WINDOWS)[number],
  payload: unknown,
): UsageWindow | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const percent = payload["percent"];
  const status = payload["status"];
  if (
    typeof percent !== "number" ||
    !Number.isFinite(percent) ||
    percent < 0 ||
    percent > 100 ||
    (status !== "ok" && status !== "rate-limited")
  ) {
    return undefined;
  }
  const resetsAtMs = typeof payload["resetsAt"] === "string" ? Date.parse(payload["resetsAt"]) : Number.NaN;
  if (!Number.isFinite(resetsAtMs)) {
    return undefined;
  }
  // Availability is separate from measured utilization. Preserve the upstream
  // percent and show rate limiting only in the existing optional display label.
  const usedFraction = percent / 100;
  return {
    id: descriptor.id,
    label: status === "rate-limited" ? `${descriptor.label} (rate-limited)` : descriptor.label,
    unit: "percent",
    resolvedFraction: usedFraction,
    severity: severityForFraction(usedFraction),
    used: percent,
    resetsAtMs,
  };
}

export const opencodeGoConnector = {
  providerId: PROVIDER_ID,
  connectorVersion: CONNECTOR_VERSION,
  async fetchUsage({ request, fetcher, nowMs, installationIdPath = join(homedir(), "Library", "Application Support", "TokenMeter", "opencode-install-id") }:
    Parameters<ConnectorModule["fetchUsage"]>[0] & { readonly installationIdPath?: string },
  ): Promise<BridgeSuccessResponse> {
    if (request.providerId !== PROVIDER_ID) {
      throw new BridgeError("invalidProvider", `unsupported provider: ${request.providerId}`);
    }
    if (request.credential === undefined) {
      throw new BridgeError("missingCredential", "opencode-go usage requires a credential");
    }
    const secret = request.credential.secret;
    const signal = AbortSignal.timeout(Math.max(1, request.deadlineAtMs - nowMs));
    const response = await callProviderHttp({
      call: {
        url: USAGE_URL,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${secret}`,
          "User-Agent": USER_AGENT,
          "x-opencode-session": installationId(installationIdPath),
        },
      },
      fetcher,
      signal,
      endpointLabel: "OpenCode Go usage",
      extraSecrets: [secret],
    });
    const payload = await response.json();
    if (!isRecord(payload) || !isRecord(payload["usage"])) {
      throw new BridgeError("noData", "OpenCode Go usage response had no usage object");
    }
    const usage = payload["usage"];
    const windows: UsageWindow[] = [];
    for (const descriptor of OPENCODE_GO_WINDOWS) {
      const window = decodeWindow(descriptor, usage[descriptor.key]);
      if (window !== undefined) {
        windows.push(window);
      }
    }
    if (windows.length === 0) {
      throw new BridgeError("noData", "OpenCode Go usage response contained no usable windows");
    }
    if (windows.length !== OPENCODE_GO_WINDOWS.length) {
      throw new BridgeError("partialPayload", "OpenCode Go usage response was missing or malformed windows");
    }
    return {
      schemaVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      providerId: request.providerId,
      connectorId: request.connectorId,
      accountRef: request.accountRef,
      status: "ok",
      completedAtMs: nowMs,
      report: {
        productKind: "quota",
        sourceKind: "firstPartyApi",
        fetchedAtMs: nowMs,
        connectorVersion: CONNECTOR_VERSION,
        windows,
      },
    };
  },
} satisfies ConnectorModule;

export const opencodeGoAuth: AuthModule = {
  providerId: PROVIDER_ID,
  methods: ["apiKey"],
  async login(method: AuthMethod, inputs: LoginInputs, events: AuthEvents, signal: AbortSignal): Promise<LoginResult> {
    if (signal.aborted) {
      throw new BridgeError("timeout", "OpenCode Go login cancelled");
    }
    if (method !== "apiKey") {
      throw new BridgeError("invalidRequest", "OpenCode Go supports only apiKey login");
    }
    events.onEvent({ type: "openUrl", url: AUTH_URL });
    // OMP onAuth instructions ("Log in and copy your API key") plus the exact
    // onPrompt message ("Paste your OpenCode Zen API key"). OMP performs no
    // key validation for this provider, so none is faked here either.
    events.onEvent({ type: "pasteHint", detail: "Log in and copy your API key, then paste your OpenCode Zen API key" });
    if (signal.aborted) {
      throw new BridgeError("timeout", "OpenCode Go login cancelled");
    }
    const secret = inputs.apiKey?.trim() ?? "";
    if (secret === "") {
      throw new BridgeError("invalidRequest", "OpenCode Go API key is required");
    }
    return { credential: { kind: "apiKey", secret } };
  },
};
