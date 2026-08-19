/**
 * token-meter-bridge CLI.
 *
 *   token-meter-bridge providers --format json
 *   token-meter-bridge usage --stdin [--fixture <path>]
 *   token-meter-bridge login --stdin
 *
 * Usage reads one JSON request and writes one JSON response. Login is a
 * duplex NDJSON session: the first stdin line is the login request, later
 * stdin lines are correlated promptResponse messages, progress/prompt events
 * stream to stderr, and one final response line is written to stdout. Bridge
 * failures print the typed error envelope and exit 1; CLI misuse prints usage
 * to stderr and exits 2.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Interface as ReadlineInterface } from "node:readline";
import { fetchFixtureUsage } from "./connectors/fixture";
import {
  BridgeError,
  PROTOCOL_VERSION,
  credentialSecrets,
  encodeBridgeResponse,
  parseBridgeRequest,
  parseLoginRequest,
  parsePromptResponse,
  redactSecrets,
} from "./protocol";
import type { BridgeErrorResponse, BridgeErrorPayload, BridgeRequest, BridgeResponse } from "./protocol";
import { lookupAuth, lookupConnector } from "./dispatch";
import type {
  AuthEvents,
  AuthPrompt,
  Fetcher,
  LoginErrorResponse,
  LoginRequest,
  LoginResponse,
  LoginResult,
} from "./dispatch";
import { listProviderCapabilities, REGISTRY_VERSION } from "./registry";

// Registers the connector + auth module for every locked provider; both the
// usage and login commands resolve providers through this side-effect import.
import "./providers/index";

const USAGE = [
  "usage: token-meter-bridge providers --format json",
  "       token-meter-bridge usage --stdin [--fixture <path>]",
  "       token-meter-bridge login --stdin",
].join("\n");

const platformFetch: Fetcher = (url, init) => fetch(url, init);

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...flags] = argv;
  switch (command) {
    case "providers":
      return runProviders(flags);
    case "usage":
      return await runUsage(flags);
    case "login":
      return await runLogin(flags);
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

function runProviders(flags: readonly string[]): number {
  if (flags.length !== 2 || flags[0] !== "--format" || flags[1] !== "json") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const listing = {
    schemaVersion: REGISTRY_VERSION,
    providers: listProviderCapabilities(),
  };
  process.stdout.write(`${JSON.stringify(listing, null, "\t")}\n`);
  return 0;
}

async function runUsage(flags: readonly string[]): Promise<number> {
  const fixturePath = flagValue(flags, "--fixture");
  const expectedLength = fixturePath === undefined ? 1 : 3;
  if (flags[0] !== "--stdin" || flags.length !== expectedLength) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const raw = await Bun.stdin.text();
  let request: BridgeRequest | undefined;
  try {
    request = parseBridgeRequest(raw);
    const response = await dispatch(request, fixturePath);
    process.stdout.write(`${encodeBridgeResponse(response)}\n`);
    return 0;
  } catch (error) { // no-excuse-ok: catch — CLI boundary; failureEnvelope narrows BridgeError internally.
    process.stdout.write(`${encodeBridgeResponse(failureEnvelope(request, error))}\n`);
    return 1;
  }
}

async function runLogin(flags: readonly string[]): Promise<number> {
  if (flags.length !== 1 || flags[0] !== "--stdin") {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const reader = new StdinLineReader();
  return await runLoginSession({
    readLine: () => reader.readLine(),
    writeOutput: line => process.stdout.write(`${line}\n`),
    writeEvent: line => process.stderr.write(`${line}\n`),
    closeInput: () => reader.close(),
  });
}

/** Injectable line transport used by the real CLI and deterministic tests. */
export type LoginSessionIO = {
  readonly readLine: () => Promise<string | undefined>;
  readonly writeOutput: (line: string) => void;
  readonly writeEvent: (line: string) => void;
  readonly closeInput: () => void;
};

/** Runs one versioned duplex login session over an NDJSON line transport. */
export async function runLoginSession(io: LoginSessionIO): Promise<number> {
  let request: LoginRequest | undefined;
  let prompts: PromptResponseRouter | undefined;
  try {
    const firstLine = await io.readLine();
    if (firstLine === undefined) {
      throw new BridgeError("invalidRequest", "login session produced no request line");
    }
    request = parseLoginRequest(firstLine);
    prompts = new PromptResponseRouter(io);
    prompts.start();
    const response = await loginViaAuthModule(request, prompts.events);
    prompts.throwIfFailed();
    io.writeOutput(JSON.stringify(response));
    return 0;
  } catch (error) { // no-excuse-ok: catch — CLI boundary; loginFailureEnvelope narrows BridgeError internally.
    const extraSecrets = prompts?.sensitiveValues() ?? [];
    io.writeOutput(JSON.stringify(loginFailureEnvelope(request, error, extraSecrets)));
    return 1;
  } finally {
    prompts?.close();
    io.closeInput();
  }
}

async function loginViaAuthModule(request: LoginRequest, events: AuthEvents): Promise<LoginResponse> {
  const auth = lookupAuth(request.providerId);
  if (auth === undefined) {
    throw new BridgeError("invalidProvider", `no auth module registered for providerId "${request.providerId}"`);
  }
  if (!auth.methods.includes(request.method)) {
    throw new BridgeError("invalidRequest", `provider "${request.providerId}" does not offer login method "${request.method}"`);
  }
  const remainingMs = Math.max(1, request.deadlineAtMs - Date.now());
  const controller = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = setTimeout(() => {
      controller.abort();
      reject(new BridgeError(
        "timeout",
        `login for provider "${request.providerId}" exceeded its deadline`,
      ));
    }, remainingMs);
  });
  let result: LoginResult;
  try {
    result = await Promise.race([
      auth.login(request.method, request.inputs ?? {}, events, controller.signal),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new BridgeError("timeout", `login for provider "${request.providerId}" exceeded its deadline`);
    }
    throw error;
  } finally {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
    }
  }
  const credential = isCredentialFreeLocal(request)
    ? { kind: "none" as const }
    : result.credential;
  return {
    schemaVersion: PROTOCOL_VERSION,
    providerId: request.providerId,
    status: "ok",
    completedAtMs: Date.now(),
    credential,
    ...(result.accountLabel !== undefined ? { accountLabel: result.accountLabel } : {}),
  };
}

class PromptResponseRouter {
  readonly events: AuthEvents;

  private readonly pending = new Map<string, PendingPrompt>();
  private readonly secrets = new Set<string>();
  private failed: BridgeError | undefined;
  private inputEnded = false;
  private closed = false;

  constructor(private readonly io: LoginSessionIO) {
    this.events = {
      onEvent: event => io.writeEvent(JSON.stringify(event)),
      requestInput: (prompt, signal) => this.requestInput(prompt, signal),
    };
  }

  start(): void {
    void this.readResponses();
  }

  throwIfFailed(): void {
    if (this.failed !== undefined) {
      throw this.failed;
    }
  }

  sensitiveValues(): readonly string[] {
    return [...this.secrets];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new BridgeError("transport", "login session closed while waiting for input");
    for (const [requestId, pending] of this.pending) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }

  private async requestInput(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
    this.throwIfFailed();
    if (this.inputEnded) {
      throw new BridgeError("transport", "login input ended before a prompt response was received");
    }
    if (signal.aborted) {
      throw new BridgeError("timeout", "login was cancelled while waiting for input");
    }

    const requestId = crypto.randomUUID();
    const response = Promise.withResolvers<string>();
    const onAbort = (): void => {
      if (!this.pending.has(requestId)) return;
      this.fail(new BridgeError("timeout", "login was cancelled while waiting for input"));
    };
    this.pending.set(requestId, {
      resolve: response.resolve,
      reject: response.reject,
      sensitive: prompt.sensitive,
      signal,
      onAbort,
    });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.events.onEvent({ type: "prompt", requestId, ...prompt });
    } catch (error) {
      signal.removeEventListener("abort", onAbort);
      this.pending.delete(requestId);
      throw error;
    }
    return await response.promise;
  }

  private async readResponses(): Promise<void> {
    try {
      while (!this.closed) {
        const line = await this.io.readLine();
        if (line === undefined) {
          this.inputEnded = true;
          if (this.pending.size > 0) {
            this.fail(new BridgeError("transport", "login input ended before a prompt response was received"));
          }
          return;
        }
        let response;
        try {
          response = parsePromptResponse(line);
        } catch (error) {
          this.fail(error instanceof BridgeError
            ? error
            : new BridgeError("invalidRequest", "invalid prompt response"));
          return;
        }
        const pending = this.pending.get(response.requestId);
        if (pending === undefined) {
          this.fail(new BridgeError("invalidRequest", "prompt response has no matching requestId"));
          return;
        }
        this.pending.delete(response.requestId);
        pending.signal.removeEventListener("abort", pending.onAbort);
        if (pending.sensitive && response.value !== "") {
          this.secrets.add(response.value);
        }
        pending.resolve(response.value);
      }
    } catch {
      if (!this.closed) {
        this.fail(new BridgeError("transport", "unable to read login prompt responses"));
      }
    }
  }

  private fail(error: BridgeError): void {
    if (this.failed !== undefined || this.closed) return;
    this.failed = error;
    for (const [requestId, pending] of this.pending) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }
}

type PendingPrompt = {
  readonly resolve: (value: string) => void;
  readonly reject: (reason: unknown) => void;
  readonly sensitive: boolean;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
};

class StdinLineReader {
  private readonly interface: ReadlineInterface;
  private readonly iterator: AsyncIterator<string>;

  constructor() {
    this.interface = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
      terminal: false,
    });
    this.iterator = this.interface[Symbol.asyncIterator]();
  }

  async readLine(): Promise<string | undefined> {
    const next = await this.iterator.next();
    return next.done ? undefined : next.value;
  }

  close(): void {
    this.interface.close();
  }
}

async function dispatch(request: BridgeRequest, fixturePath: string | undefined): Promise<BridgeResponse> {
  if (request.connectorId === "fixture") {
    if (fixturePath === undefined) {
      throw new BridgeError("invalidRequest", "the fixture connector requires --fixture <path>");
    }
    return fetchFixtureUsage({ request, fixtureSource: readFixtureSource(fixturePath), nowMs: Date.now() });
  }
  if (request.providerId !== request.connectorId) {
    throw new BridgeError(
      "invalidProvider",
      `connectorId "${request.connectorId}" only serves its own providerId "${request.providerId}"`,
    );
  }
  const connector = lookupConnector(request.connectorId);
  if (connector === undefined) {
    throw new BridgeError("invalidProvider", `unknown connectorId "${request.connectorId}"`);
  }
  let effectiveRequest = request;
  if (request.credential?.kind === "none" && !isCredentialFreeLocal(request)) {
    throw new BridgeError("missingCredential", `provider "${request.providerId}" requires a credential`);
  }
  if (request.credential === undefined && isCredentialFreeLocal(request)) {
    effectiveRequest = { ...request, credential: { kind: "none" } };
  }
  return await connector.fetchUsage({
    request: effectiveRequest,
    fetcher: platformFetch,
    nowMs: Date.now(),
  });
}

function isCredentialFreeLocal(request: Pick<LoginRequest, "providerId" | "inputs">): boolean {
  if (request.inputs?.apiKey?.trim()) {
    return false;
  }
  const capability = listProviderCapabilities().find(provider => provider.id === request.providerId);
  return capability?.authorizationBasis === "deviceNone"
    && capability.connectorTransport === "builtin-ollama"
    && capability.productKind === "localActivity";
}

export function failureEnvelope(request: BridgeRequest | undefined, error: unknown): BridgeErrorResponse {
  const refreshedCredential = error instanceof BridgeError ? error.refreshedCredential : undefined;
  const secrets = [
    ...credentialSecrets(request?.credential),
    ...credentialSecrets(refreshedCredential),
  ];
  return envelope(request, errorPayload(error, secrets), refreshedCredential);
}

function loginFailureEnvelope(
  request: LoginRequest | undefined,
  error: unknown,
  extraSecrets: readonly string[] = [],
): LoginErrorResponse {
  const secrets = request === undefined ? extraSecrets : [...loginSecrets(request), ...extraSecrets];
  return {
    schemaVersion: PROTOCOL_VERSION,
    ...(request !== undefined ? { providerId: request.providerId } : {}),
    status: "error",
    completedAtMs: Date.now(),
    error: errorPayload(error, secrets),
  };
}

function loginSecrets(request: LoginRequest): readonly string[] {
  const candidates = [request.inputs?.apiKey, request.inputs?.cookieHeader];
  return candidates.filter((value): value is string => typeof value === "string" && value !== "");
}

function errorPayload(error: unknown, secrets: readonly string[]): BridgeErrorPayload {
  if (error instanceof BridgeError) {
    return {
      kind: error.kind,
      message: redactSecrets(error.message, secrets),
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    };
  }
  const rawMessage = error instanceof Error ? error.message : "unknown failure";
  return {
    kind: "internalError",
    message: redactSecrets(`bridge helper failed: ${rawMessage}`, secrets),
  };
}

function envelope(
  request: BridgeRequest | undefined,
  error: BridgeErrorResponse["error"],
  refreshedCredential: BridgeErrorResponse["refreshedCredential"],
): BridgeErrorResponse {
  return {
    schemaVersion: PROTOCOL_VERSION,
    ...(request !== undefined
      ? {
          requestId: request.requestId,
          providerId: request.providerId,
          connectorId: request.connectorId,
          accountRef: request.accountRef,
        }
      : {}),
    status: "error",
    completedAtMs: Date.now(),
    error,
    ...(refreshedCredential !== undefined ? { refreshedCredential } : {}),
  };
}

function flagValue(flags: readonly string[], name: string): string | undefined {
  for (let i = 0; i + 1 < flags.length; i++) {
    if (flags[i] === name) {
      return flags[i + 1];
    }
  }
  return undefined;
}

function readFixtureSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new BridgeError("invalidRequest", `unable to read fixture file: ${path}`);
  }
}

if (import.meta.main) {
  const argv = process.argv;
  const runner = argv[1] ?? "";
  const args = argv.length >= 2 && (runner.endsWith(".ts") || runner.startsWith("/$bunfs/")) ? argv.slice(2) : argv.slice(1);
  process.exitCode = await main(args);
}
