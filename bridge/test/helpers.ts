import { readFileSync } from "node:fs";
import { expect } from "bun:test";
import { PROTOCOL_VERSION } from "../src/protocol";
import type { BridgeCredential, BridgeRequest } from "../src/protocol";
import type { AuthMethod, LoginInputs, LoginRequest } from "../src/dispatch";

/** Raw text of a fixture file under bridge/fixtures. */
export function readFixtureSource(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

/** Every object key reachable from the value, including inside arrays. */
export function deepKeys(value: unknown): readonly string[] {
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  walk(value);
  return keys;
}

const MODEL_FIELD_KEYS = new Set(["models", "modelList", "modelCatalog"]);

/** Fails when any model-catalog field appears anywhere in the value. */
export function expectNoModelFields(value: unknown): void {
  const offenders = deepKeys(value).filter((key) => MODEL_FIELD_KEYS.has(key));
  expect(offenders).toEqual([]);
}

export type UsageRequestOverrides = {
  readonly requestId?: string;
  readonly providerId?: string;
  readonly connectorId?: string;
  readonly accountRef?: string;
  readonly requestedAtMs?: number;
  readonly deadlineAtMs?: number;
  readonly credential?: BridgeCredential;
};

/** A valid TokenMeter/1.2.0 usage request for the fixture connector. */
export function buildUsageRequest(overrides: UsageRequestOverrides = {}): BridgeRequest {
  return {
    schemaVersion: PROTOCOL_VERSION,
    requestId: "00000000-0000-4000-8000-000000000001",
    operation: "fetchUsage",
    providerId: "fixture",
    connectorId: "fixture",
    accountRef: "00000000-0000-4000-8000-000000000002",
    requestedAtMs: 1787011200000,
    deadlineAtMs: 1787011210000,
    credential: { kind: "bearer", secret: "demo" },
    ...overrides,
  };
}

export type LoginRequestOverrides = {
  readonly providerId?: string;
  readonly method?: AuthMethod;
  readonly requestedAtMs?: number;
  readonly deadlineAtMs?: number;
  readonly inputs?: LoginInputs;
};

/** A valid TokenMeter/1.2.0 login request using the apiKey method. */
export function buildLoginRequest(overrides: LoginRequestOverrides = {}): LoginRequest {
  return {
    schemaVersion: PROTOCOL_VERSION,
    providerId: "github-copilot",
    method: "apiKey",
    requestedAtMs: 1787011200000,
    deadlineAtMs: 1787011210000,
    inputs: { apiKey: "tm_unit_api_key" },
    ...overrides,
  };
}

export type MockResponse = {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

/** Route matcher: either the literal "METHOD url" or a predicate. */
export type MockRouteWhen = string | ((method: string, url: string) => boolean);

export type MockRouteRule = {
  readonly when: MockRouteWhen;
  readonly respond: MockResponse;
};

export type RecordedCall = {
  readonly method: string;
  readonly url: string;
  readonly init: RequestInit;
};

/** A Fetcher whose calls are recorded; routes map "METHOD url" or predicates to canned responses. */
export type MockFetcher = {
  (url: string, init: RequestInit): Promise<Response>;
  readonly calls: readonly RecordedCall[];
};

export function mockFetcher(
  routes: readonly MockRouteRule[] | Readonly<Record<string, MockResponse>>,
): MockFetcher {
  const rules: readonly { readonly when: MockRouteWhen; readonly respond: MockResponse }[] = Array.isArray(routes)
    ? routes
    : Object.entries(routes).map(([key, respond]) => ({
        when: (method: string, url: string) => `${method} ${url}` === key,
        respond,
      }));
  const calls: RecordedCall[] = [];
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    calls.push({ method, url, init });
    const rule = rules.find((candidate) =>
      typeof candidate.when === "string" ? candidate.when === `${method} ${url}` : candidate.when(method, url),
    );
    if (rule === undefined) {
      throw new Error(`mockFetcher has no route for ${method} ${url}`);
    }
    const text = rule.respond.body === undefined ? null : JSON.stringify(rule.respond.body);
    return new Response(text, {
      status: rule.respond.status,
      ...(rule.respond.headers !== undefined ? { headers: rule.respond.headers } : {}),
    });
  };
  return Object.assign(fetcher, { calls });
}

/**
 * Subscribe before triggering the producer, which dispatches "ready" only after
 * registering both the counted item and its response handler. Checks the current
 * count on subscription and on that exact event, never by polling.
 */
export function waitForCount(
  getCount: () => number,
  count: number,
  ready: EventTarget,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      ready.removeEventListener("ready", onReady);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const onReady = (): void => {
      if (getCount() >= count) {
        cleanup();
        resolve();
      }
    };
    const onAbort = (): void => {
      cleanup();
      reject(options.signal?.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`expected a count of at least ${count}, saw ${getCount()}`));
    }, options.timeoutMs ?? 1000);
    ready.addEventListener("ready", onReady);
    options.signal?.addEventListener("abort", onAbort);
    if (options.signal?.aborted) {
      onAbort();
    } else {
      onReady();
    }
  });
}

/**
 * Asserts a loopback callback URL no longer accepts connections (the login
 * flow closed its listener). A single successful connection fails the
 * assertion; connection refusal passes.
 */
export async function expectLoopbackClosed(redirectUri: string): Promise<void> {
  try {
    const response = await fetch(`${redirectUri}?probe=1`);
    await response.arrayBuffer();
    throw new Error(`expected ${redirectUri} to be closed, but the probe connected (HTTP ${response.status})`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("expected")) {
      throw error;
    }
  }
}
