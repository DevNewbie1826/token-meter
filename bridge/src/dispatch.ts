/**
 * TokenMeter/1.2.0 dispatch and registration layer. Connectors and auth
 * modules register themselves here; the CLI resolves them by providerId.
 *
 * The auth module contracts (AuthMethod, LoginInputs, AuthEvent, AuthEvents,
 * LoginResult, AuthModule) are owned by ./auth/types and re-exported here so
 * module authors and the wire layer can never drift apart. The login wire
 * types and the connector registry live in this file.
 */

import type { AuthMethod, AuthModule, LoginInputs } from "./auth/types";
import { PROTOCOL_VERSION } from "./protocol-core";
import type { BridgeCredential, BridgeErrorPayload, BridgeRequest, BridgeSuccessResponse } from "./protocol-core";

export type {
  AuthMethod,
  LoginInputs,
  AuthInputKind,
  AuthPrompt,
  PromptResponse,
  AuthEvent,
  AuthEvents,
  LoginResult,
  AuthModule,
} from "./auth/types";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type ConnectorModule = {
  readonly providerId: string;
  readonly connectorVersion: string;
  fetchUsage(input: { request: BridgeRequest; fetcher: Fetcher; nowMs: number }): Promise<BridgeSuccessResponse>;
};

export const AUTH_METHODS = ["apiKey", "browser", "device"] as const;

const AUTH_METHOD_SET: ReadonlySet<string> = new Set(AUTH_METHODS);

export function isAuthMethod(value: unknown): value is AuthMethod {
  return typeof value === "string" && AUTH_METHOD_SET.has(value);
}

export type LoginRequest = {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly providerId: string;
  readonly method: AuthMethod;
  readonly requestedAtMs: number;
  readonly deadlineAtMs: number;
  readonly inputs?: LoginInputs;
};

export type LoginSuccessResponse = {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly providerId: string;
  readonly status: "ok";
  readonly completedAtMs: number;
  readonly credential: BridgeCredential;
  readonly accountLabel?: string;
};

export type LoginErrorResponse = {
  readonly schemaVersion: typeof PROTOCOL_VERSION;
  readonly providerId?: string;
  readonly status: "error";
  readonly completedAtMs: number;
  readonly error: BridgeErrorPayload;
};

export type LoginResponse = LoginSuccessResponse | LoginErrorResponse;

const connectorModules = new Map<string, ConnectorModule>();
const authModules = new Map<string, AuthModule>();

export function registerConnector(module: ConnectorModule): void {
  connectorModules.set(module.providerId, module);
}

export function registerAuth(module: AuthModule): void {
  authModules.set(module.providerId, module);
}

export function lookupConnector(providerId: string): ConnectorModule | undefined {
  return connectorModules.get(providerId);
}

export function lookupAuth(providerId: string): AuthModule | undefined {
  return authModules.get(providerId);
}
