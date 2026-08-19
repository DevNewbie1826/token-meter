/**
 * Shared vocabulary for provider auth modules (apiKey / browser OAuth /
 * RFC 8628 device flow). The credential shape is the bridge protocol's
 * BridgeCredential union re-exported through ../protocol so auth modules and
 * the wire layer can never drift apart.
 */

import type { BridgeCredential } from "../protocol";

export type AuthMethod = "apiKey" | "browser" | "device";

export type LoginInputs = {
  readonly apiKey?: string;
  readonly apiBaseUrl?: string;
  readonly cookieHeader?: string;
  readonly enterpriseHost?: string;
};

export const AUTH_INPUT_KINDS = ["text", "code", "redirectUrl", "cookieHeader", "apiBaseUrl"] as const;
export type AuthInputKind = (typeof AUTH_INPUT_KINDS)[number];

export type AuthPrompt = {
  readonly prompt: string;
  readonly inputKind: AuthInputKind;
  readonly sensitive: boolean;
};

export type PromptResponse = {
  readonly type: "promptResponse";
  readonly requestId: string;
  readonly value: string;
};

export type AuthEvent =
  | { type: "openUrl"; url: string }
  | { type: "code"; code: string; verificationUrl: string }
  | { type: "waiting"; detail: string }
  | { type: "pasteHint"; detail: string }
  | ({ type: "prompt"; requestId: string } & AuthPrompt);

export type AuthEvents = {
  readonly onEvent: (event: AuthEvent) => void;
  /**
   * Requests one correlated input value from the duplex login client.
   * Optional only for compatibility with non-interactive provider unit
   * harnesses; the CLI always supplies it.
   */
  readonly requestInput?: (prompt: AuthPrompt, signal: AbortSignal) => Promise<string>;
};

export type LoginResult = {
  readonly credential: BridgeCredential;
  readonly accountLabel?: string;
};

export type AuthModule = {
  readonly providerId: string;
  readonly methods: readonly AuthMethod[];
  login(
    method: AuthMethod,
    inputs: LoginInputs,
    events: AuthEvents,
    signal: AbortSignal,
  ): Promise<LoginResult>;
  refresh?(credential: BridgeCredential, signal: AbortSignal): Promise<BridgeCredential>;
};
