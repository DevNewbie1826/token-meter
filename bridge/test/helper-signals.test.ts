import { describe, expect, spyOn, test } from "bun:test";
import { waitForCount } from "./helpers";

describe("waitForCount exact ready signals", () => {
  test("subscribes before the producer can synchronously publish readiness", async () => {
    const ready = new EventTarget();
    const added = spyOn(ready, "addEventListener");
    const removed = spyOn(ready, "removeEventListener");
    let count = 0;
    const waiting = waitForCount(() => count, 1, ready);
    try {
      expect(added).toHaveBeenCalledTimes(1);
      expect(added.mock.calls[0]?.[0]).toBe("ready");
    } finally {
      count = 1;
      ready.dispatchEvent(new Event("ready"));
      await waiting;
    }
    expect(removed).toHaveBeenCalledTimes(1);
  });

  test.each([0, 1, 2])("accepts an already-reached count %i without another notification", async (count) => {
    const ready = new EventTarget();
    const removed = spyOn(ready, "removeEventListener");
    await waitForCount(() => 2, count, ready);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  test("waits for deferred producer notification, not count mutation alone", async () => {
    const ready = new EventTarget();
    let count = 0;
    let reads = 0;
    const waiting = waitForCount(() => { reads += 1; return count; }, 2, ready);
    const publish = Promise.withResolvers<void>();
    const producer = (async () => {
      await publish.promise;
      expect(reads).toBe(1);
      ready.dispatchEvent(new Event("ready"));
    })();
    count = 2;
    publish.resolve();
    await Promise.all([producer, waiting]);
    expect(reads).toBe(2);
    ready.dispatchEvent(new Event("ready"));
    expect(reads).toBe(2);
  });

  test("keeps same-count and higher-count waiters independent", async () => {
    const ready = new EventTarget();
    const removed = spyOn(ready, "removeEventListener");
    let count = 0;
    const first = waitForCount(() => count, 1, ready);
    const second = waitForCount(() => count, 1, ready);
    const later = waitForCount(() => count, 2, ready);
    count = 1;
    ready.dispatchEvent(new Event("ready"));
    await Promise.all([first, second]);
    expect(removed).toHaveBeenCalledTimes(2);
    count = 2;
    ready.dispatchEvent(new Event("ready"));
    await later;
    expect(removed).toHaveBeenCalledTimes(3);
  });

  test("a missing notification times out and removes only that waiter", async () => {
    const ready = new EventTarget();
    const removed = spyOn(ready, "removeEventListener");
    let count = 0;
    const expired = waitForCount(() => count, 1, ready, { timeoutMs: 0 });
    const remaining = waitForCount(() => count, 2, ready);
    // Even an updated count is not readiness without the producer's event.
    count = 1;
    await expect(expired).rejects.toBeInstanceOf(Error);
    expect(removed).toHaveBeenCalledTimes(1);
    count = 2;
    ready.dispatchEvent(new Event("ready"));
    await remaining;
    expect(removed).toHaveBeenCalledTimes(2);
  });

  test("abort cleans both listeners without cancelling an independent waiter", async () => {
    const ready = new EventTarget();
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    const removedReady = spyOn(ready, "removeEventListener");
    const removedAbort = spyOn(controller.signal, "removeEventListener");
    let count = 0;
    const cancelled = waitForCount(() => count, 1, ready, { signal: controller.signal });
    const rejected = Promise.allSettled([cancelled]);
    const remaining = waitForCount(() => count, 1, ready);
    controller.abort(reason);
    expect(await rejected).toEqual([{ status: "rejected", reason }]);
    expect(removedReady).toHaveBeenCalledTimes(1);
    expect(removedAbort).toHaveBeenCalledTimes(1);
    count = 1;
    ready.dispatchEvent(new Event("ready"));
    await remaining;
    expect(removedReady).toHaveBeenCalledTimes(2);
  });

  test("an already-aborted signal rejects without leaving listeners", async () => {
    const ready = new EventTarget();
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    controller.abort(reason);
    const removedReady = spyOn(ready, "removeEventListener");
    const removedAbort = spyOn(controller.signal, "removeEventListener");
    await expect(waitForCount(() => 0, 1, ready, { signal: controller.signal })).rejects.toBe(reason);
    expect(removedReady).toHaveBeenCalledTimes(1);
    expect(removedAbort).toHaveBeenCalledTimes(1);
  });
});
