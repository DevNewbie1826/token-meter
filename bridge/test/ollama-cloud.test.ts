import { describe, expect, test } from "bun:test";
import { ollamaCloudAuth, ollamaCloudConnector } from "../src/providers/ollama-cloud";
import { BridgeError } from "../src/protocol";
import { buildUsageRequest, expectNoModelFields } from "./helpers";

describe("ollama-cloud", () => {
  test("reports no quota without making a network call", async () => {
    let calls = 0;
    const response = await ollamaCloudConnector.fetchUsage({
      request: buildUsageRequest({ providerId: "ollama-cloud", connectorId: "ollama-cloud", credential: { kind: "apiKey", secret: "key" } }),
      fetcher: async () => { calls += 1; return new Response(); },
      nowMs: 1787011200500,
    });
    expect(calls).toBe(0);
    expect(response.report).toEqual({
      productKind: "localActivity",
      sourceKind: "noQuotaApi",
      fetchedAtMs: 1787011200500,
      connectorVersion: "ollama-cloud-1",
      windows: [],
    });
    expectNoModelFields(response);
  });

  test("requires the provider and credential", async () => {
    const request = buildUsageRequest({ providerId: "wrong", credential: { kind: "apiKey", secret: "key" } });
    await expect(ollamaCloudConnector.fetchUsage({ request, fetcher: async () => new Response(), nowMs: 1 })).rejects.toMatchObject({ kind: "invalidProvider" });
    const missingCredential = buildUsageRequest({ providerId: "ollama-cloud" });
    delete (missingCredential as { credential?: unknown }).credential;
    await expect(ollamaCloudConnector.fetchUsage({ request: missingCredential, fetcher: async () => new Response(), nowMs: 1 })).rejects.toMatchObject({ kind: "missingCredential" });
  });

  test("auth trims a non-empty API key and emits the OMP guidance", async () => {
    const events: unknown[] = [];
    const result = await ollamaCloudAuth.login("apiKey", { apiKey: "  secret " }, { onEvent: event => events.push(event) }, new AbortController().signal);
    expect(result).toEqual({ credential: { kind: "apiKey", secret: "secret" } });
    expect(events).toEqual([
      { type: "openUrl", url: "https://ollama.com/settings/keys" },
      { type: "pasteHint", detail: "Create an Ollama Cloud API key, then paste it here." },
    ]);
  });

  test("rejects empty keys and cancelled login", async () => {
    await expect(ollamaCloudAuth.login("apiKey", { apiKey: " " }, { onEvent: () => {} }, new AbortController().signal)).rejects.toMatchObject({ kind: "invalidRequest" });
    const controller = new AbortController();
    controller.abort();
    const error = await ollamaCloudAuth.login("apiKey", {}, { onEvent: () => {} }, controller.signal).catch(value => value);
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).kind).toBe("timeout");
  });
});
