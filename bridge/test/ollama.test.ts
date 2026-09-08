import { describe, expect, test } from "bun:test";
import { ollamaAuth, ollamaConnector } from "../src/providers/ollama";
import type { AuthEvent, AuthPrompt } from "../src/dispatch";
import { buildUsageRequest, expectNoModelFields, mockFetcher } from "./helpers";

/** Duplex client that fails the test if the module ever prompts (the
 * credential-free login path must complete without a prompt round-trip). */
function noPromptClient(): { readonly prompts: AuthPrompt[]; readonly requestInput: (prompt: AuthPrompt, signal: AbortSignal) => Promise<string> } {
  const prompts: AuthPrompt[] = [];
  return {
    prompts,
    requestInput: (prompt: AuthPrompt) => {
      prompts.push(prompt);
      return Promise.reject(new Error("ollama login must not prompt"));
    },
  };
}

describe("ollama provider", () => {
  test("returns the honest no-quota report without network access", async () => {
    const fetcher = mockFetcher([]);
    const response = await ollamaConnector.fetchUsage({
      request: buildUsageRequest({ providerId: "ollama", connectorId: "ollama", credential: { kind: "apiKey", secret: "key" } }),
      fetcher,
      nowMs: 1787011200000,
    });
    expect(response).toEqual({
      schemaVersion: "1.3.0",
      requestId: "00000000-0000-4000-8000-000000000001",
      providerId: "ollama",
      connectorId: "ollama",
      accountRef: "00000000-0000-4000-8000-000000000002",
      status: "ok",
      completedAtMs: 1787011200000,
      report: { productKind: "localActivity", sourceKind: "noQuotaApi", fetchedAtMs: 1787011200000, connectorVersion: "ollama-1", windows: [] },
    });
    expect(fetcher.calls).toHaveLength(0);
    expectNoModelFields(response.report);
  });

  test("accepts the none credential and returns the exact noQuotaApi empty report", async () => {
    const fetcher = mockFetcher([]);
    const response = await ollamaConnector.fetchUsage({
      request: buildUsageRequest({ providerId: "ollama", connectorId: "ollama", credential: { kind: "none" } }),
      fetcher,
      nowMs: 1787011200000,
    });
    expect(response.status).toBe("ok");
    expect(response.report).toEqual({
      productKind: "localActivity",
      sourceKind: "noQuotaApi",
      fetchedAtMs: 1787011200000,
      connectorVersion: "ollama-1",
      windows: [],
    });
    expect(fetcher.calls).toHaveLength(0);
    expectNoModelFields(response.report);
  });

  test("a blank key maps to the none credential, never a fake local-noauth secret", async () => {
    const signal = new AbortController().signal;
    expect(await ollamaAuth.login("apiKey", {}, { onEvent: () => {} }, signal)).toEqual({
      credential: { kind: "none" },
      accountLabel: "Local (no key)",
    });
    expect(await ollamaAuth.login("apiKey", { apiKey: "   " }, { onEvent: () => {} }, signal)).toEqual({
      credential: { kind: "none" },
      accountLabel: "Local (no key)",
    });
  });

  test("a missing key completes as the none credential without a prompt round-trip", async () => {
    const events: AuthEvent[] = [];
    const duplex = noPromptClient();
    const result = await ollamaAuth.login(
      "apiKey",
      {},
      { onEvent: (event) => events.push(event), requestInput: duplex.requestInput },
      new AbortController().signal,
    );
    expect(duplex.prompts).toHaveLength(0);
    expect(events).toEqual([]);
    expect(result).toEqual({ credential: { kind: "none" }, accountLabel: "Local (no key)" });
  });

  test("an optional key is trimmed exactly like OMP loginOllama", async () => {
    const result = await ollamaAuth.login("apiKey", { apiKey: "  ollama-token-7  " }, { onEvent: () => {} }, new AbortController().signal);
    expect(result).toEqual({ credential: { kind: "apiKey", secret: "ollama-token-7" } });
    expect(result.accountLabel).toBeUndefined();
  });

  test("structured inputs win without any prompts", async () => {
    const events: AuthEvent[] = [];
    const duplex = noPromptClient();
    const result = await ollamaAuth.login(
      "apiKey",
      { apiKey: "ollama-token-11" },
      { onEvent: (event) => events.push(event), requestInput: duplex.requestInput },
      new AbortController().signal,
    );
    expect(duplex.prompts).toHaveLength(0);
    expect(events).toEqual([]);
    expect(result).toEqual({ credential: { kind: "apiKey", secret: "ollama-token-11" } });
  });

  test("rejects invalid provider and missing credential", async () => {
    const fetcher = mockFetcher([]);
    await expect(ollamaConnector.fetchUsage({ request: buildUsageRequest({ providerId: "other" }), fetcher, nowMs: 1 })).rejects.toMatchObject({ kind: "invalidProvider" });
    const { credential: _credential, ...missingCredentialRequest } = buildUsageRequest({ providerId: "ollama" });
    await expect(ollamaConnector.fetchUsage({ request: missingCredentialRequest, fetcher, nowMs: 1 })).rejects.toMatchObject({ kind: "missingCredential" });
  });

  test("maps cancellation to timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(ollamaAuth.login("apiKey", {}, { onEvent: () => {} }, controller.signal)).rejects.toMatchObject({ kind: "timeout" });
    await expect(
      ollamaAuth.login("apiKey", {}, { onEvent: () => {}, requestInput: () => Promise.reject(new Error("must not prompt")) }, controller.signal),
    ).rejects.toMatchObject({ kind: "timeout" });
  });
});
