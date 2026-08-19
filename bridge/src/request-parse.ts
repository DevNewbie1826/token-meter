/**
 * Strict TokenMeter/1.2.0 request parsing: the trust boundary. Untrusted
 * stdin JSON is validated once here; interior code only ever receives typed
 * requests. Unknown fields, foreign versions, framing violations, credential
 * union violations and scheduling-policy violations are typed BridgeErrors.
 */

import { isAuthMethod } from "./dispatch";
import type { LoginInputs, LoginRequest, PromptResponse } from "./dispatch";
import {
  MAX_REQUEST_BYTES,
  PROTOCOL_FAMILY,
  PROTOCOL_VERSION,
  BridgeError,
  isCredentialKind,
  isRecord,
} from "./protocol-core";
import type { BridgeCredential, BridgeErrorKind, BridgeRequest, OAuthDetails } from "./protocol-core";

const REQUEST_KEYS: readonly string[] = [
  "schemaVersion",
  "requestId",
  "operation",
  "providerId",
  "connectorId",
  "accountRef",
  "requestedAtMs",
  "deadlineAtMs",
  "credential",
];
const NO_CREDENTIAL_KEYS: readonly string[] = ["kind"];
const STATIC_CREDENTIAL_KEYS: readonly string[] = ["kind", "secret"];
const OAUTH_CREDENTIAL_KEYS: readonly string[] = ["kind", "secret", "oauth"];
const OAUTH_KEYS: readonly string[] = [
  "access",
  "refresh",
  "expiresAtMs",
  "refreshEndpoint",
  "clientId",
  "identity",
];
const LOGIN_REQUEST_KEYS: readonly string[] = [
  "schemaVersion",
  "providerId",
  "method",
  "requestedAtMs",
  "deadlineAtMs",
  "inputs",
];
const LOGIN_INPUT_KEYS: readonly string[] = ["apiKey", "apiBaseUrl", "cookieHeader", "enterpriseHost"];
const PROMPT_RESPONSE_KEYS: readonly string[] = ["type", "requestId", "value"];

export function parseBridgeRequest(raw: string): BridgeRequest {
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
    throw new BridgeError("invalidProtocol", `request exceeds the ${MAX_REQUEST_BYTES}-byte framing limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeError("invalidRequest", "request body is not valid JSON");
  }
  return requestFromValue(parsed);
}

function requestFromValue(value: unknown): BridgeRequest {
  if (!isRecord(value)) {
    throw new BridgeError("invalidRequest", "request must be a JSON object");
  }
  const record = value;
  rejectUnknownKeys(record, REQUEST_KEYS, "request", "invalidRequest");
  if (record["schemaVersion"] !== PROTOCOL_VERSION) {
    throw new BridgeError("invalidProtocol", `schemaVersion must be ${PROTOCOL_VERSION} for ${PROTOCOL_FAMILY}`);
  }
  const requestId = nonEmptyString(record["requestId"], "requestId");
  if (record["operation"] !== "fetchUsage") {
    throw new BridgeError("invalidRequest", 'operation must be "fetchUsage"');
  }
  const providerId = nonEmptyString(record["providerId"], "providerId");
  const connectorId = nonEmptyString(record["connectorId"], "connectorId");
  const accountRef = nonEmptyString(record["accountRef"], "accountRef");
  const requestedAtMs = epochMs(record["requestedAtMs"], "requestedAtMs");
  const deadlineAtMs = epochMs(record["deadlineAtMs"], "deadlineAtMs");
  if (deadlineAtMs <= requestedAtMs) {
    throw new BridgeError("invalidPolicy", "deadlineAtMs must be later than requestedAtMs");
  }
  const credential = "credential" in record ? credentialFromValue(record["credential"]) : undefined;
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId,
    operation: "fetchUsage",
    providerId,
    connectorId,
    accountRef,
    requestedAtMs,
    deadlineAtMs,
    ...(credential !== undefined ? { credential } : {}),
  };
}

function credentialFromValue(value: unknown): BridgeCredential {
  if (!isRecord(value)) {
    throw new BridgeError("invalidRequest", "credential must be a JSON object");
  }
  const record = value;
  const kind = record["kind"];
  if (!isCredentialKind(kind)) {
    throw new BridgeError("invalidProtocol", "credential.kind must be one of the closed credential union");
  }
  if (kind === "none") {
    rejectUnknownKeys(record, NO_CREDENTIAL_KEYS, "credential", "invalidProtocol");
    return { kind };
  }
  if (kind === "oauth") {
    rejectUnknownKeys(record, OAUTH_CREDENTIAL_KEYS, "credential", "invalidProtocol");
    const secret = nonEmptyString(record["secret"], "credential.secret");
    return { kind, secret, oauth: oauthDetailsFromValue(record["oauth"]) };
  }
  rejectUnknownKeys(record, STATIC_CREDENTIAL_KEYS, "credential", "invalidProtocol");
  const secret = nonEmptyString(record["secret"], "credential.secret");
  return { kind, secret };
}

function oauthDetailsFromValue(value: unknown): OAuthDetails {
  if (!isRecord(value)) {
    throw new BridgeError("invalidProtocol", "an oauth credential requires an oauth object carrying access");
  }
  const record = value;
  rejectUnknownKeys(record, OAUTH_KEYS, "credential.oauth", "invalidProtocol");
  const access = record["access"];
  if (typeof access !== "string" || access === "") {
    throw new BridgeError("invalidProtocol", "an oauth credential is missing a non-empty oauth.access");
  }
  const refresh = optionalCredentialString(record["refresh"], "credential.oauth.refresh");
  const expiresAtMs = optionalCredentialEpochMs(record["expiresAtMs"], "credential.oauth.expiresAtMs");
  const refreshEndpoint = optionalCredentialString(record["refreshEndpoint"], "credential.oauth.refreshEndpoint");
  const clientId = optionalCredentialString(record["clientId"], "credential.oauth.clientId");
  const identity = record["identity"] === undefined ? undefined : identityFromValue(record["identity"]);
  return {
    access,
    ...(refresh !== undefined ? { refresh } : {}),
    ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    ...(refreshEndpoint !== undefined ? { refreshEndpoint } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(identity !== undefined ? { identity } : {}),
  };
}

function identityFromValue(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new BridgeError("invalidProtocol", "credential.oauth.identity must be a JSON object of non-secret strings");
  }
  const identity: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new BridgeError("invalidProtocol", `credential.oauth.identity.${key} must be a string`);
    }
    identity[key] = entry;
  }
  return identity;
}

function optionalCredentialString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value === "") {
    throw new BridgeError("invalidProtocol", `field "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalCredentialEpochMs(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeError("invalidProtocol", `field "${field}" must be a positive integer Unix millisecond timestamp`);
  }
  return value;
}

export function parsePromptResponse(raw: string): PromptResponse {
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
    throw new BridgeError("invalidProtocol", `prompt response exceeds the ${MAX_REQUEST_BYTES}-byte framing limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeError("invalidRequest", "prompt response is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new BridgeError("invalidRequest", "prompt response must be a JSON object");
  }
  rejectUnknownKeys(parsed, PROMPT_RESPONSE_KEYS, "prompt response", "invalidRequest");
  if (parsed["type"] !== "promptResponse") {
    throw new BridgeError("invalidRequest", 'prompt response type must be "promptResponse"');
  }
  const requestId = nonEmptyString(parsed["requestId"], "requestId");
  const value = parsed["value"];
  if (typeof value !== "string") {
    throw new BridgeError("invalidRequest", 'field "value" must be a string');
  }
  return { type: "promptResponse", requestId, value };
}

export function parseLoginRequest(raw: string): LoginRequest {
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BYTES) {
    throw new BridgeError("invalidProtocol", `request exceeds the ${MAX_REQUEST_BYTES}-byte framing limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BridgeError("invalidRequest", "request body is not valid JSON");
  }
  return loginRequestFromValue(parsed);
}

function loginRequestFromValue(value: unknown): LoginRequest {
  if (!isRecord(value)) {
    throw new BridgeError("invalidRequest", "request must be a JSON object");
  }
  const record = value;
  rejectUnknownKeys(record, LOGIN_REQUEST_KEYS, "login request", "invalidRequest");
  if (record["schemaVersion"] !== PROTOCOL_VERSION) {
    throw new BridgeError("invalidProtocol", `schemaVersion must be ${PROTOCOL_VERSION} for ${PROTOCOL_FAMILY}`);
  }
  const providerId = nonEmptyString(record["providerId"], "providerId");
  const method = record["method"];
  if (!isAuthMethod(method)) {
    throw new BridgeError("invalidRequest", 'method must be one of "apiKey", "browser", "device"');
  }
  const requestedAtMs = epochMs(record["requestedAtMs"], "requestedAtMs");
  const deadlineAtMs = epochMs(record["deadlineAtMs"], "deadlineAtMs");
  if (deadlineAtMs <= requestedAtMs) {
    throw new BridgeError("invalidPolicy", "deadlineAtMs must be later than requestedAtMs");
  }
  const inputs = "inputs" in record ? loginInputsFromValue(record["inputs"]) : undefined;
  return {
    schemaVersion: PROTOCOL_VERSION,
    providerId,
    method,
    requestedAtMs,
    deadlineAtMs,
    ...(inputs !== undefined ? { inputs } : {}),
  };
}

function loginInputsFromValue(value: unknown): LoginInputs {
  if (!isRecord(value)) {
    throw new BridgeError("invalidRequest", "login inputs must be a JSON object");
  }
  const record = value;
  rejectUnknownKeys(record, LOGIN_INPUT_KEYS, "login inputs", "invalidRequest");
  const inputs: Record<string, string> = {};
  for (const key of LOGIN_INPUT_KEYS) {
    if (record[key] !== undefined) {
      inputs[key] = nonEmptyString(record[key], `inputs.${key}`);
    }
  }
  return inputs;
}

function rejectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
  kind: BridgeErrorKind,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new BridgeError(kind, `unknown field "${key}" in ${where}`);
    }
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new BridgeError("invalidRequest", `field "${field}" must be a non-empty string`);
  }
  return value;
}

function epochMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BridgeError("invalidRequest", `field "${field}" must be a positive integer Unix millisecond timestamp`);
  }
  return value;
}
