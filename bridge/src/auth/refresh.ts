/**
 * Shared OAuth helpers for provider auth modules: the generic token-rotation
 * primitive, the rotation-durability rethrow (a rotated bundle must reach the
 * caller even when the retried usage call fails, because most providers burn
 * the old refresh token server-side), and the manual callback paste race
 * ported from OMP's callback-server (onManualCodeInput + parseCallbackInput)
 * onto the duplex AuthEvents.requestInput channel.
 */

import { BridgeError, isRecord } from "../protocol-core";
import type { BridgeCredential, OAuthCredential } from "../protocol-core";
import type { AuthPrompt } from "./types";
import { callProviderHttp } from "../connectors/provider-http";
import type { Fetcher } from "../connectors/provider-http";

export async function rotateOAuthToken(input: {
  credential: OAuthCredential;
  fetcher: Fetcher;
  signal: AbortSignal;
  extraBody?: Readonly<Record<string, string>>;
  mapResponse?: (json: unknown) => { access: string; refresh?: string; expiresInMs?: number };
}): Promise<OAuthCredential> {
  const { credential } = input;
  if (credential.oauth.refreshEndpoint === undefined || credential.oauth.clientId === undefined || credential.oauth.refresh === undefined) {
    throw new BridgeError("authRequired", "token refresh requires a refresh endpoint, client id, and refresh token");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credential.oauth.clientId,
    refresh_token: credential.oauth.refresh,
    ...(input.extraBody ?? {}),
  });
  const response = await callProviderHttp({
    call: {
      url: credential.oauth.refreshEndpoint,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    fetcher: input.fetcher,
    signal: input.signal,
    endpointLabel: "token refresh",
    extraSecrets: [credential.secret, credential.oauth.access, credential.oauth.refresh],
  });

  const json = await response.json();
  const mapped = input.mapResponse === undefined ? defaultMap(json) : input.mapResponse(json);
  if (typeof mapped.access !== "string" || mapped.access.length === 0) {
    throw new BridgeError("authRequired", "token refresh returned no access token");
  }
  return {
    kind: "oauth",
    secret: mapped.access,
    oauth: {
      access: mapped.access,
      ...(mapped.refresh !== undefined ? { refresh: mapped.refresh } : credential.oauth.refresh !== undefined ? { refresh: credential.oauth.refresh } : {}),
      ...(mapped.expiresInMs !== undefined ? { expiresAtMs: Date.now() + mapped.expiresInMs } : credential.oauth.expiresAtMs !== undefined ? { expiresAtMs: credential.oauth.expiresAtMs } : {}),
      refreshEndpoint: credential.oauth.refreshEndpoint,
      clientId: credential.oauth.clientId,
      ...(credential.oauth.identity !== undefined ? { identity: credential.oauth.identity } : {}),
    },
  };
}

function defaultMap(json: unknown): { access: string; refresh?: string; expiresInMs?: number } {
  if (!isRecord(json)) {
    return { access: "" };
  }
  return {
    access: typeof json["access_token"] === "string" ? json["access_token"] : "",
    ...(typeof json["refresh_token"] === "string" ? { refresh: json["refresh_token"] } : {}),
    ...(typeof json["expires_in"] === "number" ? { expiresInMs: json["expires_in"] * 1000 } : {}),
  };
}

/**
 * Re-throw a failed usage fetch with the rotated credential attached so the
 * caller persists it before surfacing the error. Rotation is often
 * single-use upstream (the old refresh token dies with the grant): dropping
 * the rotated bundle on a later failure would strand the whole credential
 * family. No-op when nothing rotated or the error already carries one.
 */
export function rethrowWithRefreshedCredential(
  error: unknown,
  refreshedCredential: BridgeCredential | undefined,
): never {
  if (refreshedCredential === undefined) {
    throw error;
  }
  if (error instanceof BridgeError) {
    if (error.refreshedCredential !== undefined) {
      throw error;
    }
    throw new BridgeError(error.kind, error.message, {
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      refreshedCredential,
    });
  }
  throw error;
}

/** One captured OAuth callback redirect (loopback or manual paste). */
export type ManualCallbackResult = { readonly code: string; readonly state: string };

/** The duplex input channel providers request manual pastes through. */
export type ManualInputRequest = (prompt: AuthPrompt, signal: AbortSignal) => Promise<string>;

/**
 * OMP parseCallbackInput: accept a full redirect URL, a bare query string
 * (`?code=..&state=..` / `code=..&state=..`), or a raw code with an optional
 * `#state` suffix. Empty input yields no code.
 */
export function parseManualCallbackInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (value === "") {
    return {};
  }
  try {
    const url = new URL(value);
    const urlCode = url.searchParams.get("code");
    const urlState = url.searchParams.get("state");
    return {
      ...(urlCode !== null ? { code: urlCode } : {}),
      ...(urlState !== null ? { state: urlState } : {}),
    };
  } catch {
    // Not a URL — check for query string format.
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    const paramCode = params.get("code");
    const paramState = params.get("state");
    return {
      ...(paramCode !== null ? { code: paramCode } : {}),
      ...(paramState !== null ? { state: paramState } : {}),
    };
  }
  // Assume a raw code, possibly with state after #.
  const [rawCode, rawState] = value.split("#", 2);
  return {
    ...(rawCode !== undefined ? { code: rawCode } : {}),
    ...(rawState !== undefined ? { state: rawState } : {}),
  };
}

/**
 * OMP OAuthCallbackFlow.#waitForCallback's manual-input race, ported onto the
 * duplex channel: the loopback callback and a requestInput paste prompt race;
 * an invalid paste (no code, missing state, or mismatched state)
 * re-prompts. Without a requestInput channel the wait is the plain callback.
 */
export async function waitForCallbackOrManualPaste(input: {
  readonly wait: Promise<ManualCallbackResult>;
  readonly expectedState: string;
  readonly requestInput?: ManualInputRequest | undefined;
  readonly prompt: AuthPrompt;
  readonly signal: AbortSignal;
}): Promise<ManualCallbackResult> {
  const { wait, expectedState, requestInput, prompt, signal } = input;
  if (requestInput === undefined) {
    return await wait;
  }
  // Set once the loopback wait settles, so the re-prompt loop stops issuing
  // new prompts after the callback already resolved the login.
  let callbackSettled = false;
  const settledWait = wait.then(
    (result) => {
      callbackSettled = true;
      return result;
    },
    (error: unknown) => {
      callbackSettled = true;
      throw error;
    },
  );
  void wait.catch(() => undefined);
  const manualPaste = async (): Promise<ManualCallbackResult> => {
    for (;;) {
      let pasted: string;
      try {
        pasted = await requestInput(prompt, signal);
      } catch {
        // The duplex input channel failed; the loopback callback is the only
        // remaining path, so settle on its outcome (it rejects on abort).
        return await wait;
      }
      const parsed = parseManualCallbackInput(pasted);
      const parsedState = parsed.state;
      const stateMatches = parsedState === expectedState;
      if (parsed.code !== undefined && parsed.code !== "" && stateMatches) {
        return { code: parsed.code, state: parsedState };
      }
      if (callbackSettled) {
        // The callback won while this paste was in flight; stop re-prompting.
        return await settledWait;
      }
      // Invalid paste: re-prompt (OMP loop).
    }
  };
  return await Promise.race([settledWait, manualPaste()]);
}
