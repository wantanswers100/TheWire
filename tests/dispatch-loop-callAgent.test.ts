// Regression coverage for ISS-022: callAgent()'s per-agent routing and the
// runWorker() fallback chain. Direct coverage was previously missing entirely
// (see ISSUES.md ISS-022) — this is the test that would have caught both the
// original bug (agent="claude" silently falling through to runGemini() while
// still reporting status:"success"/usedAgent:"claude") and the follow-on
// invocation bug (--permission-mode plan + --tools "" deadlocking runClaude()).
//
// Mocks workers.js via bun:test's mock.module() so no real CLI process is
// ever spawned — this file must never invoke a real `claude`/`gemini`/`codex`
// binary (nested `claude` subprocess is blocked from inside Claude Code
// sessions; a real spawn would also make this test slow/flaky/network-bound).

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { rmSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { WorkerResult } from "../src/dispatch/workers.js";

// bun:test's mock.module() patches the shared module registry for the whole
// `bun test` process, not just this file — so every OTHER export must be
// forwarded to the real implementation, or other test files that import
// workers.js (e.g. tests/parallel-dispatcher.test.ts, which depends on the
// REAL runOllama's timing to test timeout behavior) will silently start
// exercising these stubs instead and their assertions will break. Only
// runClaude/runGemini are overridden; everything else is the real function.
const realWorkers = await import("../src/dispatch/workers.js");

let claudeCalls = 0;
let claudeShouldThrow = false;
let geminiCalls = 0;

mock.module("../src/dispatch/workers.js", () => ({
  ...realWorkers,
  runClaude: async (_skill: string, _payload: unknown, _ctx?: string): Promise<WorkerResult> => {
    claudeCalls++;
    if (claudeShouldThrow) throw new Error("mock claude failure (simulates a hang/deadlock surfacing as a thrown error)");
    return { text: "real claude answer", model: "claude/mock" };
  },
  runGemini: async (_skill: string, _payload: unknown, _ctx?: string): Promise<WorkerResult> => {
    geminiCalls++;
    return { text: "real gemini answer", model: "gemini/mock" };
  },
}));

// Restore the real workers.js after this file's tests complete so subsequent
// test files (runClaude-claudecode-guard.test.ts etc.) get the real module.
// mock.module() patches the shared registry for the whole bun test process.
afterAll(() => {
  mock.module("../src/dispatch/workers.js", () => realWorkers);
});

// Import AFTER mock.module so DispatchLoop binds to the mocked workers.
const { DispatchLoop } = await import("../src/dispatch/loop.js");
const { DispatchDB } = await import("../src/dispatch/db.js");

let testRoot: string;
let stateDir: string;
let inboxDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-loop-callagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
  claudeCalls = 0;
  claudeShouldThrow = false;
  geminiCalls = 0;
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function makeLoop(): InstanceType<typeof DispatchLoop> {
  return new DispatchLoop({
    keysDir: join(testRoot, ".keys"),
    stateDir,
    inboxDir,
    gatewayUrl: "http://localhost:0",
    agentToken: "test-token",
    // Bypass Ollama judge in tests — always pass so fallback chain tests
    // exercise agent routing, not the quality gate.
    judgeOverride: async () => ({ verdict: "pass", reason: "test judge" }),
  });
}

describe("DispatchLoop.callAgent() — per-agent routing (ISS-022)", () => {
  test("agent=claude routes to runClaude(), never runGemini()", async () => {
    const loop = makeLoop() as any;
    const result = await loop.callAgent("claude", "explain", { subject: "test" }, undefined);

    expect(result.text).toBe("real claude answer");
    expect(claudeCalls).toBe(1);
    expect(geminiCalls).toBe(0);
  });

  test("agent=gemini routes to runGemini(), never runClaude()", async () => {
    const loop = makeLoop() as any;
    const result = await loop.callAgent("gemini", "explain", { subject: "test" }, undefined);

    expect(result.text).toBe("real gemini answer");
    expect(geminiCalls).toBe(1);
    expect(claudeCalls).toBe(0);
  });

  test("genuinely unknown agent id throws instead of silently defaulting to any worker", async () => {
    const loop = makeLoop() as any;
    await expect(
      loop.callAgent("not-a-real-agent" as any, "explain", {}, undefined)
    ).rejects.toThrow(/Unknown agent/);

    expect(claudeCalls).toBe(0);
    expect(geminiCalls).toBe(0);
  });
});

describe("DispatchLoop.runWorker() — fallback chain (ISS-022 primary regression guard)", () => {
  test("claude tier throwing (e.g. a hang surfaced as an error) falls back to gemini — task still completes honestly labeled", async () => {
    claudeShouldThrow = true;
    const loop = makeLoop() as any;
    const taskId = "regression-test-task-1";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });

    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    // The exact bug this guards against: a claude-tier failure must never be
    // silently reported as a successful claude result. It must either fall
    // back to the next real agent (asserted here) or report an honest failure.
    expect(claudeCalls).toBe(1);
    expect(geminiCalls).toBe(1);

    const row = db.get(taskId);
    expect(row?.status).toBe("done");

    const resultFiles = readdirSync(inboxDir).filter(f => f.startsWith("claude_codex_"));
    expect(resultFiles.length).toBe(1);
    const body = readFileSync(join(inboxDir, resultFiles[0]!), "utf8");
    // usedAgent must reflect gemini (who actually answered), not claude.
    expect(body).toContain("routed to gemini");
    expect(body).not.toContain("routed to claude");
    expect(body).toContain("real gemini answer");
  });

  test("claude tier succeeding is reported honestly as claude, not silently substituted", async () => {
    const loop = makeLoop() as any;
    const taskId = "regression-test-task-2";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });

    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    expect(claudeCalls).toBe(1);
    expect(geminiCalls).toBe(0);

    const row = db.get(taskId);
    expect(row?.status).toBe("done");

    const resultFiles = readdirSync(inboxDir).filter(f => f.startsWith("claude_codex_"));
    const body = readFileSync(join(inboxDir, resultFiles[0]!), "utf8");
    expect(body).toContain("routed to claude");
    expect(body).toContain("real claude answer");
  });

  test("every tier in the chain throwing reports an honest failure, not a fabricated success", async () => {
    claudeShouldThrow = true;
    const loop = makeLoop() as any;
    const taskId = "regression-test-task-3";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });

    // Only "claude" in the chain, and it throws — no fallback available.
    await loop.runWorker(taskId, "codex", "explain", ["claude"], { subject: "test" });

    const row = db.get(taskId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("claude");
  });
});

describe("DispatchLoop.runWorker() — confidence reflects fallback tier (ISS-025)", () => {
  test("preferred agent (tier 0) succeeding reports confidence 0.9, not a flat 0.85", async () => {
    const loop = makeLoop() as any;
    const taskId = "regression-test-confidence-tier0";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });
    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    const resultFiles = readdirSync(inboxDir).filter(f => f.startsWith("claude_codex_"));
    const body = JSON.parse(readFileSync(join(inboxDir, resultFiles[0]!), "utf8"));
    expect(body.payload.confidence).toBe(0.9);
  });

  test("first fallback tier (claude fails, gemini succeeds) reports a lower confidence than the preferred-tier case", async () => {
    claudeShouldThrow = true;
    const loop = makeLoop() as any;
    const taskId = "regression-test-confidence-tier1";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });
    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    const resultFiles = readdirSync(inboxDir).filter(f => f.startsWith("claude_codex_"));
    const body = JSON.parse(readFileSync(join(inboxDir, resultFiles[0]!), "utf8"));
    expect(body.payload.confidence).toBe(0.75);
    expect(body.payload.confidence).toBeLessThan(0.9);
  });
});

describe("DispatchLoop.runWorker() — agent cooldown integration (Phase 53)", () => {
  test("an agent failure records a cooldown that the router state can see", async () => {
    claudeShouldThrow = true;
    const loop = makeLoop() as any;
    const taskId = "regression-test-cooldown-record";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });
    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    expect(loop.cooldown.isOnCooldown("claude")).toBe(true);
    // gemini succeeded — must not be penalized
    expect(loop.cooldown.isOnCooldown("gemini")).toBe(false);
  });

  test("an agent already on cooldown is skipped without being called, and falls through to the next tier", async () => {
    const loop = makeLoop() as any;
    loop.cooldown.recordFailure("claude", "quota_exhausted");
    const taskId = "regression-test-cooldown-skip";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });
    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    // claude was on cooldown — never actually invoked
    expect(claudeCalls).toBe(0);
    expect(geminiCalls).toBe(1);

    const row = db.get(taskId);
    expect(row?.status).toBe("done");
    const resultFiles = readdirSync(inboxDir).filter(f => f.startsWith("claude_codex_"));
    const body = readFileSync(join(inboxDir, resultFiles[0]!), "utf8");
    expect(body).toContain("routed to gemini");
  });

  test("every agent in the chain on cooldown falls through to an honest failure, never hangs", async () => {
    const loop = makeLoop() as any;
    loop.cooldown.recordFailure("claude", "quota_exhausted");
    loop.cooldown.recordFailure("gemini", "timeout");
    const taskId = "regression-test-cooldown-all-skipped";

    const db = new DispatchDB(stateDir);
    db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });
    await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

    expect(claudeCalls).toBe(0);
    expect(geminiCalls).toBe(0);

    const row = db.get(taskId);
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("cooldown");
  });

  test("WIRE_COOLDOWN_DISABLED=1 ignores an active cooldown and attempts the agent anyway", async () => {
    const loop = makeLoop() as any;
    loop.cooldown.recordFailure("claude", "quota_exhausted");
    process.env["WIRE_COOLDOWN_DISABLED"] = "1";
    const taskId = "regression-test-cooldown-disabled";

    try {
      const db = new DispatchDB(stateDir);
      db.insert({ id: taskId, from: "codex", skill: "explain", routed_to: "claude", status: "routing", created_at: Date.now() });
      await loop.runWorker(taskId, "codex", "explain", ["claude", "gemini"], { subject: "test" });

      expect(claudeCalls).toBe(1);
    } finally {
      delete process.env["WIRE_COOLDOWN_DISABLED"];
    }
  });
});
