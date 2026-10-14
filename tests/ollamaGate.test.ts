// Tests for the Ollama request gate — serializes local Ollama calls within
// this process so concurrent dispatch tasks don't each fire a classify/
// generate request at once, forcing model swaps under Wire's "max 2 models
// loaded" cap (root cause of the classifier timeouts documented in DEVLOG
// 2026-09-09). No real Ollama calls here — fn is a fake async worker with an
// artificial delay so concurrency can be measured deterministically.

import { describe, test, expect } from "bun:test";
import { withOllamaLock } from "../src/router/ollamaGate.js";

describe("withOllamaLock", () => {
  test("never runs two guarded calls concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fakeCall = async (ms: number) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return ms;
    };

    // Fire 4 "requests" at once — without the gate these would all overlap.
    const results = await Promise.all([
      withOllamaLock(() => fakeCall(30)),
      withOllamaLock(() => fakeCall(10)),
      withOllamaLock(() => fakeCall(20)),
      withOllamaLock(() => fakeCall(5)),
    ]);

    expect(maxInFlight).toBe(1);
    expect(results.sort((a, b) => a - b)).toEqual([5, 10, 20, 30]);
  });

  test("a rejected call does not wedge the queue for later calls", async () => {
    const order: string[] = [];

    const failing = withOllamaLock(async () => {
      order.push("fail-start");
      throw new Error("simulated Ollama error");
    });

    const succeeding = withOllamaLock(async () => {
      order.push("succeed");
      return "ok";
    });

    await expect(failing).rejects.toThrow("simulated Ollama error");
    await expect(succeeding).resolves.toBe("ok");
    expect(order).toEqual(["fail-start", "succeed"]);
  });

  test("preserves call order (FIFO), not completion order", async () => {
    const completed: number[] = [];

    const p1 = withOllamaLock(async () => {
      await new Promise((r) => setTimeout(r, 15));
      completed.push(1);
    });
    const p2 = withOllamaLock(async () => {
      completed.push(2);
    });

    await Promise.all([p1, p2]);
    // p1 was queued first, so it must fully finish before p2 starts running,
    // even though p2's own work is instant.
    expect(completed).toEqual([1, 2]);
  });
});
