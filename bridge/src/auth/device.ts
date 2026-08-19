/**
 * RFC 8628 device authorization grant primitives, ported from OMP
 * packages/ai/src/registry/oauth/device-code.ts (the polling engine) and the
 * device-flow usage in xai-oauth.ts / kimi.ts (the HTTP request shape) @
 * 8500092.
 *
 * Kept from the OMP sources:
 * - pollOAuthDeviceCodeFlow: poll/interval/deadline engine with a 1s minimum
 *   interval, the RFC 8628 default of 5s, +5s on every slow_down, abortable
 *   sleep, cancellation via "Login cancelled", terminal polling errors, and
 *   the plain vs. slow-down timeout messages (including the clock-drift hint).
 * - Device authorization request: form-urlencoded POST (client_id + optional
 *   scope), JSON parsing, verification_uri_complete falling back to
 *   verification_uri, kimi's defaults when the response omits expires_in
 *   (15 min) or interval (5s).
 * - Token polling: form-urlencoded POST (grant_type device_code, client_id,
 *   device_code), authorization_pending -> pending, slow_down -> slow_down,
 *   any other error or non-OK status -> terminal failure; 5-minute client-side
 *   skew when converting expires_in into an absolute expiry.
 *
 * Deviations from the OMP sources (with reasons):
 * - OMP's AIError.LoginCancelledError/OAuthError become
 *   DeviceFlowCancelledError/DeviceFlowFailedError (the bridge has no AIError).
 * - Provider-specific validation (xAI's *.x.ai host pinning, Kimi's
 *   X-Msh-* headers) is not ported: endpoints and client id are injected, so
 *   provider auth modules own those rules.
 * - now/sleep are injectable for deterministic tests; the defaults match
 *   OMP's Date.now()/Bun.sleep behavior exactly.
 * - OMP's xai parser requires a refresh_token; this shared primitive makes it
 *   optional because the bridge credential union models refresh as optional.
 */

import type { AuthEvents } from "./types";

/** Injectable fetcher (OMP FetchImpl minus the TLS-pinning extras). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEVICE_FLOW_CANCEL_MESSAGE = "Login cancelled";
const DEVICE_FLOW_TIMEOUT_MESSAGE = "Device flow timed out";
const DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE =
  "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const MINIMUM_DEVICE_FLOW_INTERVAL_MS = 1000;
const DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;
/** Kimi's DEFAULT_DEVICE_FLOW_TTL_MS (15 min) expressed in seconds. */
const DEFAULT_DEVICE_FLOW_TTL_SECONDS = 900;
/** OMP TOKEN_REQUEST_TIMEOUT_MS for device-auth and token requests. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
/** The 5-min client skew OMP applies (xai ACCESS_TOKEN_CLIENT_SKEW_MS / kimi OAUTH_EXPIRY_SKEW_MS). */
const ACCESS_TOKEN_CLIENT_SKEW_MS = 5 * 60 * 1000;
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** Mirrors OMP's LoginCancelledError for device-flow cancellation. */
export class DeviceFlowCancelledError extends Error {
  readonly name = "DeviceFlowCancelledError";
}

/** Mirrors OMP's OAuthError for device-flow failures. */
export class DeviceFlowFailedError extends Error {
  readonly name = "DeviceFlowFailedError";
}

/** Result returned by one OAuth device-code polling attempt. */
export type OAuthDeviceCodePollResult<T> =
  | { status: "complete"; value: T }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "failed"; message: string };

/** Options for polling an RFC 8628-style OAuth device-code flow. */
export interface OAuthDeviceCodeFlowOptions<T> {
  /** Poll the provider once and classify the response. */
  poll(): OAuthDeviceCodePollResult<T> | Promise<OAuthDeviceCodePollResult<T>>;
  /** Provider-requested polling cadence; defaults to RFC 8628's five seconds. */
  intervalSeconds?: number;
  /** Provider-issued expiry window for the device code. */
  expiresInSeconds?: number;
  /** Cancels the flow with the legacy "Login cancelled" error. */
  signal?: AbortSignal;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep for tests; defaults to the abortable Bun.sleep below. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

async function abortableDeviceFlowSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await Bun.sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw new DeviceFlowCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
  }

  const { promise, resolve, reject } = Promise.withResolvers<void>();
  let timer: Timer | undefined;
  const onAbort = () => {
    clearTimeout(timer);
    reject(new DeviceFlowCancelledError(DEVICE_FLOW_CANCEL_MESSAGE));
  };
  timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  await promise;
}

/** Poll an OAuth device-code flow until completion, provider failure, timeout, or cancellation. */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodeFlowOptions<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableDeviceFlowSleep;
  const deadline =
    typeof options.expiresInSeconds === "number"
      ? now() + options.expiresInSeconds * 1000
      : Number.POSITIVE_INFINITY;
  let intervalMs = Math.max(
    MINIMUM_DEVICE_FLOW_INTERVAL_MS,
    Math.floor((options.intervalSeconds ?? DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS) * 1000),
  );
  let slowDownResponses = 0;

  while (now() < deadline) {
    if (options.signal?.aborted) {
      throw new DeviceFlowCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
    }
    const result = await options.poll();
    if (result.status === "complete") {
      return result.value;
    }
    if (result.status === "failed") {
      throw new DeviceFlowFailedError(result.message);
    }
    if (result.status === "slow_down") {
      slowDownResponses += 1;
      intervalMs = Math.max(MINIMUM_DEVICE_FLOW_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remainingMs), options.signal);
  }

  throw new DeviceFlowFailedError(
    slowDownResponses > 0 ? DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE : DEVICE_FLOW_TIMEOUT_MESSAGE,
  );
}

export interface DeviceFlowEndpoints {
  /** RFC 8628 device-authorization endpoint. */
  readonly deviceAuthorizationUrl: string;
  /** Token endpoint to poll. */
  readonly tokenUrl: string;
  readonly clientId: string;
  /** Optional scope sent with the device-authorization request. */
  readonly scope?: string;
}

/** Tokens captured from a successful device-flow token response. */
export interface DeviceFlowTokens {
  readonly access: string;
  readonly refresh?: string;
  /** Absolute epoch-ms expiry (already skewed 5 min early, like OMP). */
  readonly expiresAtMs?: number;
}

export interface DeviceFlowRunOptions {
  /** Injectable fetcher; defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
  /** Cancels the flow. */
  readonly signal?: AbortSignal;
  /** Receives openUrl / code / waiting events for the UI. */
  readonly events?: AuthEvents;
  /** Per-request timeout; defaults to 20s (OMP TOKEN_REQUEST_TIMEOUT_MS). */
  readonly requestTimeoutMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable sleep for tests; defaults to the engine's abortable sleep. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

function parseDeviceAuthorization(payload: unknown): DeviceAuthorization {
  if (!isRecord(payload)) {
    throw new DeviceFlowFailedError("Device authorization response was not a JSON object.");
  }
  const deviceCode = typeof payload["device_code"] === "string" ? payload["device_code"].trim() : "";
  const userCode = typeof payload["user_code"] === "string" ? payload["user_code"].trim() : "";
  const verificationUri =
    typeof payload["verification_uri"] === "string" ? payload["verification_uri"].trim() : "";
  if (!deviceCode || !userCode || !verificationUri) {
    throw new DeviceFlowFailedError("Device authorization response missing required fields.");
  }
  const verificationUriComplete =
    typeof payload["verification_uri_complete"] === "string" && payload["verification_uri_complete"].trim()
      ? payload["verification_uri_complete"].trim()
      : verificationUriWithUserCode(verificationUri, userCode);
  const expiresInSeconds =
    typeof payload["expires_in"] === "number" && Number.isFinite(payload["expires_in"]) && payload["expires_in"] > 0
      ? payload["expires_in"]
      : DEFAULT_DEVICE_FLOW_TTL_SECONDS;
  const intervalSeconds =
    typeof payload["interval"] === "number" && Number.isFinite(payload["interval"]) && payload["interval"] > 0
      ? payload["interval"]
      : DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS;
  return { deviceCode, userCode, verificationUri, verificationUriComplete, expiresInSeconds, intervalSeconds };
}

export function verificationUriWithUserCode(
  verificationUri: string,
  userCode: string,
): string {
  try {
    const url = new URL(verificationUri);
    url.searchParams.set("user_code", userCode);
    return url.toString();
  } catch {
    const separator = verificationUri.includes("?") ? "&" : "?";
    return `${verificationUri}${separator}user_code=${encodeURIComponent(userCode)}`;
  }
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    // Ignore body-read failures; the status code is the diagnostic.
    return "";
  }
}

async function requestDeviceAuthorization(
  endpoints: DeviceFlowEndpoints,
  fetchImpl: FetchLike,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<DeviceAuthorization> {
  const params: Record<string, string> = { client_id: endpoints.clientId };
  if (endpoints.scope !== undefined) {
    params["scope"] = endpoints.scope;
  }

  let response: Response;
  try {
    response = await postForm(fetchImpl, endpoints.deviceAuthorizationUrl, params, requestTimeoutMs, signal);
  } catch (error) {
    if (signal?.aborted) throw new DeviceFlowCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
    throw new DeviceFlowFailedError(
      `Device authorization request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new DeviceFlowFailedError(
      `Device authorization request failed: ${response.status}${detail ? ` ${detail}` : ""}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DeviceFlowFailedError(
      `Device authorization response returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseDeviceAuthorization(payload);
}

function parseTokenResponse(payload: unknown, now: () => number): OAuthDeviceCodePollResult<DeviceFlowTokens> {
  if (!isRecord(payload)) {
    return { status: "failed", message: "Device flow token response was not a JSON object." };
  }
  const access = typeof payload["access_token"] === "string" ? payload["access_token"] : "";
  if (!access) {
    return { status: "failed", message: "Device flow token response missing access_token." };
  }
  const refresh = typeof payload["refresh_token"] === "string" ? payload["refresh_token"] : undefined;
  const expiresInSeconds = payload["expires_in"];
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds)) {
    return { status: "failed", message: "Device flow token response missing expires_in." };
  }
  return {
    status: "complete",
    value: {
      access,
      ...(refresh !== undefined ? { refresh } : {}),
      expiresAtMs: now() + expiresInSeconds * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
    },
  };
}

async function pollDeviceToken(
  endpoints: DeviceFlowEndpoints,
  deviceCode: string,
  fetchImpl: FetchLike,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
  now: () => number,
): Promise<OAuthDeviceCodePollResult<DeviceFlowTokens>> {
  let response: Response;
  try {
    response = await postForm(
      fetchImpl,
      endpoints.tokenUrl,
      {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: endpoints.clientId,
        device_code: deviceCode,
      },
      requestTimeoutMs,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) throw new DeviceFlowCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
    throw new DeviceFlowFailedError(
      `Device flow token polling failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new DeviceFlowFailedError(
      `Device flow token polling returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (response.ok) {
    return parseTokenResponse(payload, now);
  }
  if (!isRecord(payload)) {
    return { status: "failed", message: `Device flow token polling failed: ${response.status}` };
  }

  const errorCode = typeof payload["error"] === "string" ? payload["error"] : "";
  if (errorCode === "authorization_pending") return { status: "pending" };
  if (errorCode === "slow_down") return { status: "slow_down" };

  const errorDescription = typeof payload["error_description"] === "string" ? payload["error_description"] : "";
  const detail = errorDescription || errorCode || String(response.status);
  return { status: "failed", message: `Device flow token polling failed: ${detail}` };
}

/**
 * Run a full RFC 8628 device authorization flow: request the device code,
 * emit the verification URI/code as auth events, then poll the token endpoint
 * at the advertised interval until success, a terminal error, or the deadline.
 */
export async function runDeviceAuthorizationFlow(
  endpoints: DeviceFlowEndpoints,
  options: DeviceFlowRunOptions = {},
): Promise<DeviceFlowTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const device = await requestDeviceAuthorization(endpoints, fetchImpl, requestTimeoutMs, options.signal);
  options.events?.onEvent({ type: "openUrl", url: device.verificationUriComplete });
  options.events?.onEvent({ type: "code", code: device.userCode, verificationUrl: device.verificationUri });
  options.events?.onEvent({ type: "waiting", detail: "Waiting for device authorization..." });

  return pollOAuthDeviceCodeFlow({
    poll: () =>
      pollDeviceToken(
        endpoints,
        device.deviceCode,
        fetchImpl,
        requestTimeoutMs,
        options.signal,
        now,
      ),
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
    now,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  });
}
