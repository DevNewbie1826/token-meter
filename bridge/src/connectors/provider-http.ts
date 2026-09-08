import { BridgeError, redactSecrets } from "../protocol-core";
import type { BridgeErrorKind } from "../protocol-core";

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderHttpCall = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: NonNullable<RequestInit["redirect"]>;
};

export async function callProviderHttp(input: {
  call: ProviderHttpCall;
  fetcher: Fetcher;
  signal: AbortSignal;
  endpointLabel: string;
  acceptedStatuses?: readonly number[];
  statusMap?: Partial<Record<number, BridgeErrorKind>>;
  extraSecrets?: readonly string[];
}): Promise<{ status: number; headers: Headers; json: () => Promise<unknown> }> {
  let response: Response;
  try {
    response = await input.fetcher(input.call.url, {
      ...(input.call.method === undefined ? {} : { method: input.call.method }),
      ...(input.call.headers === undefined ? {} : { headers: input.call.headers }),
      ...(input.call.body === undefined ? {} : { body: input.call.body }),
      ...(input.call.redirect === undefined ? {} : { redirect: input.call.redirect }),
      signal: input.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safe = redactSecrets(message, input.extraSecrets ?? []);
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw new BridgeError("timeout", `${input.endpointLabel} request timed out${safe ? `: ${safe}` : ""}`);
    }
    throw new BridgeError("transport", `network failure contacting ${input.endpointLabel}${safe ? `: ${safe}` : ""}`);
  }

  if (!response.ok && !input.acceptedStatuses?.includes(response.status)) {
    const kind = input.statusMap?.[response.status] ?? defaultStatusKind(response.status);
    const retryAfterMs = kind === "rateLimited" ? retryAfterMsFrom(response) : undefined;
    throw new BridgeError(kind, `${input.endpointLabel} returned HTTP ${response.status}`, { retryAfterMs });
  }

  return {
    status: response.status,
    headers: response.headers,
    json: async (): Promise<unknown> => {
      try {
        return await response.json();
      } catch (error) {
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
          throw new BridgeError("timeout", `${input.endpointLabel} request timed out`);
        }
        throw new BridgeError("malformedPayload", `${input.endpointLabel} returned a non-JSON body`);
      }
    },
  };
}

function defaultStatusKind(status: number): BridgeErrorKind {
  if (status === 401) return "authRequired";
  if (status === 403) return "permissionDenied";
  if (status === 429) return "rateLimited";
  if (status >= 500 && status <= 599) return "upstreamError";
  return "upstreamError";
}

function retryAfterMsFrom(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
}
