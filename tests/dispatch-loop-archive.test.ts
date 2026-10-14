// Regression coverage for ISS-033: processed inbox files must be archived,
// not left accumulating forever. Covers both archive points: a message that
// will never pass schema validation (addressed to us, malformed) and a
// message that was successfully claimed. The success-path test uses a HITL
// skill so processFile() does not launch a detached provider worker that can
// outlive the temp database.

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { rmSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RoutingRequest, RoutingDecision } from "../src/router/types.js";

// Capture real router BEFORE mocking so afterAll can restore it.
const realRouter = await import("../src/router/index.js");

mock.module("../src/router/index.js", () => ({
  WireRouter: class {
    async route(_req: RoutingRequest): Promise<RoutingDecision> {
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

// Restore real router after this file's tests so subsequent test files
// (router-claude-liveness.test.ts etc.) get the real WireRouter.
afterAll(() => {
  mock.module("../src/router/index.js", () => realRouter as any);
});

const { DispatchLoop } = await import("../src/dispatch/loop.js");
const { buildMessage, serializeMessage, wireFilename } = await import("../src/envelope/encode.js");

let testRoot: string;
let stateDir: string;
let inboxDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-loop-archive-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function makeLoop(): any {
  return new DispatchLoop({
    keysDir: join(testRoot, ".keys"),
    stateDir,
    inboxDir,
    gatewayUrl: "http://localhost:0",
    agentToken: "test-token",
  });
}

describe("DispatchLoop — inbox archiving (ISS-033)", () => {
  test("a successfully claimed HITL task file is moved to .processed/, not left in the active inbox", async () => {
    const loop = makeLoop();
    const msg = await buildMessage({
      from: "codex",
      to: "claude",
      type: "task",
      skill: "implement",
      payload: { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" },
    });
    const filepath = join(inboxDir, wireFilename(msg));
    await Bun.write(filepath, serializeMessage(msg));

    await loop.processFile(filepath);

    expect(existsSync(filepath)).toBe(false);
    const archived = readdirSync(join(inboxDir, ".processed"));
    expect(archived).toContain(wireFilename(msg));
  });

  test("a message addressed to us that fails schema validation (empty domain) is archived, not left to be re-scanned forever", async () => {
    const loop = makeLoop();
    const msg = await buildMessage({
      from: "codex",
      to: "claude",
      type: "task",
      skill: "quick",
      payload: { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" },
    });
    // Corrupt the serialized message to have an empty domain array, same
    // shape as the classifier bug ISS-028 fixed.
    const serialized = serializeMessage(msg).replace('"domain": [\n      "general"\n    ]', '"domain": []');
    const filepath = join(inboxDir, wireFilename(msg));
    await Bun.write(filepath, serialized);

    await loop.processFile(filepath);

    expect(existsSync(filepath)).toBe(false);
    const archived = readdirSync(join(inboxDir, ".processed"));
    expect(archived).toContain(wireFilename(msg));
  });

  test("a message NOT addressed to us is left untouched, not archived", async () => {
    const loop = makeLoop();
    const msg = await buildMessage({
      from: "codex",
      to: "gemini",
      type: "task",
      skill: "quick",
      payload: { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" },
    });
    const filepath = join(inboxDir, wireFilename(msg));
    await Bun.write(filepath, serializeMessage(msg));

    await loop.processFile(filepath);

    expect(existsSync(filepath)).toBe(true);
    expect(existsSync(join(inboxDir, ".processed"))).toBe(false);
  });
});
