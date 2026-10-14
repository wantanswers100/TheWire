// Regression coverage for ISS-032: processFile() must not double-dispatch
// when called concurrently for the same message (duplicate inotify events
// from one write, or an editor's write+rename/write+chmod sequence). This
// is not a theoretical race — it fired live in production on an ordinary
// `wire ask` call during ISS-028 verification (2026-08-12): the same task
// id was dispatched to Gemini twice, two separate paid API calls, two
// distinct result files. See ISSUES.md ISS-032.
//
// Mocks router/index.js the same way tests/dispatch-loop-verb-routing.test.ts
// does — captures every call to WireRouter.route() so this test can assert
// on how many times routing (and therefore dispatch) actually happened, not
// just the final DB state (which the old race also could have left looking
// consistent purely by luck of write ordering).

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RoutingRequest, RoutingDecision } from "../src/router/types.js";

let capturedRequests: RoutingRequest[] = [];

const realRouter = await import("../src/router/index.js");

mock.module("../src/router/index.js", () => ({
  WireRouter: class {
    async route(req: RoutingRequest): Promise<RoutingDecision> {
      // Yield the event loop before resolving, same as the real router's
      // await-driven route() — this is what actually makes the race
      // reachable: without a genuine yield point, two "concurrent" calls
      // never actually interleave in a single-threaded event loop.
      await new Promise(r => setTimeout(r, 5));
      capturedRequests.push(req);
      return { agent: "ollama", rule: "mock", fallbacksAvailable: [], costTier: "free" };
    }
    async classifyAndRoute(_taskText: string, overrides?: Partial<RoutingRequest>): Promise<RoutingDecision> {
      const req = {
        skill: overrides?.skill ?? "quick",
        verb: overrides?.verb,
        domains: overrides?.domains ?? [],
        type: overrides?.type ?? "task",
      } as RoutingRequest;
      return this.route(req);
    }
  },
}));

afterAll(() => {
  mock.module("../src/router/index.js", () => realRouter as any);
});

const { DispatchLoop } = await import("../src/dispatch/loop.js");
const { DispatchDB } = await import("../src/dispatch/db.js");
const { buildMessage, serializeMessage, wireFilename } = await import("../src/envelope/encode.js");

let testRoot: string;
let stateDir: string;
let inboxDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-loop-concurrent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  capturedRequests = [];
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("DispatchLoop.processFile() — concurrent/duplicate events do not double-dispatch (ISS-032)", () => {
  test("two simultaneous processFile() calls for the same message route exactly once", async () => {
    const loop = new DispatchLoop({
      keysDir: join(testRoot, ".keys"),
      stateDir,
      inboxDir,
      gatewayUrl: "http://localhost:0",
      agentToken: "test-token",
    }) as any;

    const msg = await buildMessage({
      from: "codex",
      to: "claude",
      type: "task",
      // HITL skill: this test only asserts the pre-worker atomic claim. Using
      // a non-HITL skill would start a detached real worker that can outlive
      // the temp DB and make the suite flaky.
      skill: "implement",
      payload: {
        format: "task",
        verb: "query",
        domain: ["general"],
        output: { format: "prose" },
        subject: "test subject",
      },
    });
    const filepath = join(inboxDir, wireFilename(msg));
    await Bun.write(filepath, serializeMessage(msg));

    // Simulate the duplicate-inotify-event race: two invocations for the
    // exact same file, started together, with no await between them —
    // this is what a duplicate fs.watch callback (or an editor's
    // write+rename firing two separate events) actually looks like.
    await Promise.all([loop.processFile(filepath), loop.processFile(filepath)]);

    // The core assertion: routing (and therefore dispatch) happened exactly
    // once, not twice. Before the ISS-032 fix, both calls would pass
    // isProcessed() before either committed to the DB, and both would reach
    // router.route() — this would be 2, not 1.
    expect(capturedRequests.length).toBe(1);

    const row = new DispatchDB(stateDir).get(msg.id);
    expect(row?.routed_to).toBe("ollama");
  });
});
