/**
 * Loopback OAuth callback capture on 127.0.0.1, ported from OMP
 * packages/ai/src/registry/oauth/callback-server.ts @ 8500092.
 *
 * Kept from the OMP flow:
 * - Bind the preferred port, fall back to a random free port on EADDRINUSE
 *   (unless allowPortFallback is false), reporting the swap via onProgress.
 * - Generate the CSRF state token (16 random bytes, hex).
 * - Capture `code` + `state` from the callback query, resolve the wait on a
 *   match, and REJECT a mismatched state with a 500 response while the wait
 *   keeps listening (state mismatches must never hand over the code).
 * - Reject the wait when the redirect carries `error` with our state nonce
 *   (user denied, etc.); forged-state errors stay ignored.
 * - Honor the deadline: a 300s default timeout combined with the caller's
 *   AbortSignal rejects the wait with CallbackCancelledError.
 *
 * Deviations from the OMP source (with reasons):
 * - OMP binds both IPv4 and IPv6 loopback when the hostname is `localhost`;
 *   this port binds a single 127.0.0.1 listener, which is what the OMP
 *   explicit-hostname path does and what this bridge requires.
 * - The `/launch` 302 route and the oauth.html success page are not ported;
 *   the callback answers with a minimal HTML page instead (the page body is
 *   not behavioral for capturing the code).
 * - The manual paste-code race (onManualCodeInput/parseCallbackInput) is not
 *   ported; interactive paste belongs to the CLI layer.
 * - stop() closes active connections (Bun stop(true)) so a finished flow
 *   cannot hold the process open on keep-alive sockets.
 */

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const CALLBACK_PATH = "/callback";

export type CallbackResult = { code: string; state: string };

/** Mirrors OMP's LoginCancelledError for loopback aborts/timeouts. */
export class CallbackCancelledError extends Error {
  readonly name = "CallbackCancelledError";
}

/** Mirrors OMP's OAuthError for a provider-reported authorization failure. */
export class CallbackFailedError extends Error {
  readonly name = "CallbackFailedError";
}

/**
 * Whether a failed bind means "another process already holds this port".
 * Bun surfaces `EADDRINUSE` on the error's `code` where the platform reports
 * it, and otherwise only in the message, so both are checked.
 */
function isAddressInUse(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") return code === "EADDRINUSE";
  return error instanceof Error && /EADDRINUSE|in use/i.test(error.message);
}

/** Generate the CSRF state token (OMP OAuthCallbackFlow.generateState). */
export function generateCallbackState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

export interface LoopbackCallbackOptions {
  /** Port to bind first; 0 (the default) asks the OS for a random free port. */
  readonly preferredPort?: number;
  /** Path the provider redirects to; defaults to "/callback". */
  readonly callbackPath?: string;
  /** Loopback address to bind; defaults to "127.0.0.1". */
  readonly hostname?: string;
  /** Overall deadline in ms; defaults to 300_000 (OMP DEFAULT_TIMEOUT). */
  readonly timeoutMs?: number;
  /** Whether a busy preferred port may fall back to a random port (default true). */
  readonly allowPortFallback?: boolean;
  /** Cancels the wait; rejects it with CallbackCancelledError. */
  readonly signal?: AbortSignal;
  /** Progress sink, e.g. the port-fallback notice (OMP ctrl.onProgress). */
  readonly onProgress?: (message: string) => void;
}

export interface LoopbackCallbackHandle {
  /** Port the callback server actually bound. */
  readonly port: number;
  /** Redirect URI to advertise to the provider. */
  readonly redirectUri: string;
  /** Resolves with the captured code+state, or rejects on error/deadline/abort. */
  readonly wait: Promise<CallbackResult>;
  /** Stops the callback server. Safe to call more than once. */
  stop(): void;
}

/**
 * Start the loopback callback server and return a handle whose `wait` promise
 * captures the next state-matching OAuth redirect.
 */
export async function startLoopbackCallback(
  expectedState: string,
  options: LoopbackCallbackOptions = {},
): Promise<LoopbackCallbackHandle> {
  const preferredPort = options.preferredPort ?? 0;
  const callbackPath = options.callbackPath ?? CALLBACK_PATH;
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPortFallback = options.allowPortFallback ?? true;

  const callback = Promise.withResolvers<CallbackResult>();
  let settled = false;
  const settleResolve = (result: CallbackResult): void => {
    if (settled) return;
    settled = true;
    queueMicrotask(() => callback.resolve(result));
  };
  const settleReject = (error: Error): void => {
    if (settled) return;
    settled = true;
    queueMicrotask(() => callback.reject(error));
  };

  const handleRequest = (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname !== callbackPath) {
      return new Response("Not Found", { status: 404 });
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error") || "";
    const errorDescription = url.searchParams.get("error_description") || error;

    type OkState = { ok: true; code: string; state: string };
    type ErrorState = { ok?: false; error?: string };
    let resultState: OkState | ErrorState;

    if (error) {
      resultState = { ok: false, error: `Authorization failed: ${errorDescription}` };
    } else if (!code) {
      resultState = { ok: false, error: "Missing authorization code" };
    } else if (expectedState && state !== expectedState) {
      resultState = { ok: false, error: "State mismatch - possible CSRF attack" };
    } else {
      resultState = { ok: true, code, state };
    }

    if (resultState.ok) {
      settleResolve({ code: resultState.code, state: resultState.state });
    } else if (error && (!expectedState || state === expectedState)) {
      // The redirect carries our state nonce, so it came from the genuine
      // authorization flow (e.g. the user denied the consent screen).
      // Surface the denial now instead of leaving the login waiting for the
      // 5-minute timeout. Errors WITHOUT the expected state stay ignored —
      // any local process can forge those.
      settleReject(
        new CallbackFailedError(resultState.error ?? `Authorization failed: ${errorDescription}`),
      );
    }

    const message = resultState.ok ? "Authorization captured. You can close this tab." : resultState.error ?? "";
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>token-meter-bridge</title><body><p>${message}</p></body>`,
      { status: resultState.ok ? 200 : 500, headers: { "Content-Type": "text/html" } },
    );
  };

  const createServer = (port: number): Bun.Server<unknown> =>
    Bun.serve({ hostname, port, reusePort: false, fetch: req => handleRequest(req) });

  let server: Bun.Server<unknown>;
  try {
    server = createServer(preferredPort);
  } catch (cause) {
    if (!allowPortFallback || !isAddressInUse(cause)) {
      throw cause;
    }
    server = createServer(0);
    options.onProgress?.(`Preferred port ${preferredPort} unavailable, using port ${server.port}`);
  }

  try {
    const port = server.port;
    if (typeof port !== "number") {
      throw new Error(
        "OAuth callback server bound to a non-TCP endpoint; expected a numeric port.",
      );
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    signal.addEventListener(
      "abort",
      () => {
        settleReject(new CallbackCancelledError(`OAuth callback cancelled: ${signal.reason}`));
      },
      { once: true },
    );

    return {
      port,
      redirectUri: `http://${hostname}:${port}${callbackPath}`,
      wait: callback.promise,
      stop: () => {
        server.stop(true);
      },
    };
  } catch (error) {
    server.stop(true);
    throw error;
  }
}
