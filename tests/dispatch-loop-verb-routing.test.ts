// Regression coverage for ISS-029: the daemon's route() call (loop.ts,
// inside processFile()) must pass `verb` through, matching what nl-cmd.ts's
// own route() call (used for the CLI's plan-preview display) already sends.
// Before this fix, loop.ts omitted `verb` entirely — since verb-scoped rules
// in the routing table gate/score on req.verb, the daemon's actual routing
// decision could structurally diverge from what the CLI displayed and the
// user confirmed, not just from expected temporal drift.
//
// Mocks router/index.js via bun:test's mock.module() to capture the exact
// request object passed to WireRouter.route() — no real router logic,
// Ollama, or gateway calls involved. Uses a HITL skill so processFile() stops
// after routing/status update instead of launching a detached provider worker;
// otherwise the worker can outlive the test and write to a removed temp DB.

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
const { buildMessage, serializeMessage, wireFilename } = await import("../src/envelope/encode.js");

let testRoot: string;
let stateDir: string;
let inboxDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-loop-verb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  capturedRequests = [];
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("DispatchLoop.processFile() — routes with verb (ISS-029)", () => {
  test("a task message with verb=summarize passes verb through to WireRouter.route()", async () => {
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
      skill: "implement",
      payload: {
        format: "task",
        verb: "summarize",
        domain: ["general"],
        output: { format: "prose" },
        subject: "test subject",
      },
    });
    const filepath = join(inboxDir, wireFilename(msg));
    await Bun.write(filepath, serializeMessage(msg));

    await loop.processFile(filepath);

    expect(capturedRequests.length).toBe(1);
    expect(capturedRequests[0]!.skill).toBe("implement");
    expect(capturedRequests[0]!.verb).toBe("summarize");
  });
});
