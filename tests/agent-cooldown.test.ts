// Coverage for AgentCooldownStore (src/router/agentCooldown.ts) — Phase 53.
//
// Scope: error-type-aware cooldown consulted by dispatch/loop.ts::runWorker
// before each fallback-chain attempt. Distinct from and complementary to
// WireRouter's existing claudeRecentlyFailed() route-time liveness check
// (see router-claude-liveness.test.ts) — that one filters which agent the
// router picks; this one filters which agent runWorker actually attempts
// within an already-built chain, for every agent, classified by failure type.

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AgentCooldownStore, classifyFailure } from "../src/router/agentCooldown.js";

let testRoot: string;

function makeRoot(): string {
  testRoot = join(tmpdir(), `wire-agent-cooldown-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  return testRoot;
}

beforeEach(() => {
  delete process.env["WIRE_COOLDOWN_DISABLED"];
});

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
  delete process.env["WIRE_COOLDOWN_DISABLED"];
});

describe("classifyFailure", () => {
  test("rate limit / 429 / quota messages classify as quota_exhausted", () => {
    expect(classifyFailure(new Error("Gemini rate limit"))).toBe("quota_exhausted");
    expect(classifyFailure(new Error("Groq API error: 429 "))).toBe("quota_exhausted");
    expect(classifyFailure(new Error("Codex rate-limited or spend cap reached"))).toBe("quota_exhausted");
  });

  test("ETIMEDOUT / timeout messages classify as timeout", () => {
    expect(classifyFailure(new Error("claude spawnSync ETIMEDOUT"))).toBe("timeout");
  });

  test("missing key / no auth found messages classify as auth_missing", () => {
    expect(classifyFailure(new Error("GEMINI_API_KEY not set in .env"))).toBe("auth_missing");
    expect(classifyFailure(new Error("Codex unavailable: no OpenAI auth found (checked ...)"))).toBe("auth_missing");
  });

  test("CLI-not-found / not-responding messages classify as not_running", () => {
    expect(classifyFailure(new Error("Claude CLI not found in PATH."))).toBe("not_running");
    expect(classifyFailure(new Error("agy unavailable: CLI not found or not responding."))).toBe("not_running");
  });

  test("unrecognized message falls back to generic failed", () => {
    expect(classifyFailure(new Error("something unexpected happened"))).toBe("failed");
    expect(classifyFailure("plain string error")).toBe("failed");
  });
});

describe("AgentCooldownStore", () => {
  test("fresh agent is not on cooldown", () => {
    const store = new AgentCooldownStore(makeRoot());
    expect(store.isOnCooldown("gemini")).toBe(false);
    expect(store.reasonFor("gemini")).toBeNull();
  });

  test("recordFailure puts the agent on cooldown for the classified reason", () => {
    const store = new AgentCooldownStore(makeRoot());
    store.recordFailure("gemini", "quota_exhausted");
    expect(store.isOnCooldown("gemini")).toBe(true);
    expect(store.reasonFor("gemini")).toBe("quota_exhausted");
    // Unrelated agent is unaffected
    expect(store.isOnCooldown("claude")).toBe(false);
  });

  test("success after failure clears the cooldown immediately", () => {
    const store = new AgentCooldownStore(makeRoot());
    store.recordFailure("codex", "timeout");
    expect(store.isOnCooldown("codex")).toBe(true);
    store.clear("codex");
    expect(store.isOnCooldown("codex")).toBe(false);
    expect(store.reasonFor("codex")).toBeNull();
  });

  test("repeated quota_exhausted failures double the cooldown window, capped", () => {
    const root = makeRoot();
    const store = new AgentCooldownStore(root);
    const persisted = () => JSON.parse(readFileSync(join(root, "agent-cooldown.json"), "utf8"));

    const before1 = Date.now();
    store.recordFailure("gemini", "quota_exhausted");
    const until1 = persisted()["gemini"].until;
    expect(until1 - before1).toBeGreaterThanOrEqual(15 * 60_000 - 1000); // ~base

    const before2 = Date.now();
    store.recordFailure("gemini", "quota_exhausted");
    const until2 = persisted()["gemini"].until;
    expect(until2 - before2).toBeGreaterThanOrEqual(30 * 60_000 - 1000); // ~2x base

    // Drive failCount up further and confirm the window never exceeds the 4h cap
    for (let i = 0; i < 10; i++) store.recordFailure("gemini", "quota_exhausted");
    const beforeCap = Date.now();
    store.recordFailure("gemini", "quota_exhausted");
    const untilCap = persisted()["gemini"].until;
    expect(untilCap - beforeCap).toBeLessThanOrEqual(4 * 60 * 60_000 + 1000);
  });

  test("flat-duration reasons (auth_missing) do not escalate on repeat failures", () => {
    const root = makeRoot();
    const store = new AgentCooldownStore(root);
    const persisted = () => JSON.parse(readFileSync(join(root, "agent-cooldown.json"), "utf8"));

    store.recordFailure("codex", "auth_missing");
    const until1 = persisted()["codex"].until;
    store.recordFailure("codex", "auth_missing");
    const until2 = persisted()["codex"].until;

    // Both windows should be ~5 minutes from their own recordFailure call —
    // i.e. the second call's window is not roughly double the first's.
    expect(until2 - until1).toBeLessThan(2000);
  });

  test("WIRE_COOLDOWN_DISABLED=1 bypasses cooldown entirely", () => {
    const store = new AgentCooldownStore(makeRoot());
    store.recordFailure("gemini", "quota_exhausted");
    expect(store.isOnCooldown("gemini")).toBe(true);

    process.env["WIRE_COOLDOWN_DISABLED"] = "1";
    expect(store.isOnCooldown("gemini")).toBe(false);
  });

  test("corrupt state file resets to baseline instead of crashing", () => {
    const root = makeRoot();
    writeFileSync(join(root, "agent-cooldown.json"), "{ not valid json", "utf8");
    const store = new AgentCooldownStore(root);
    expect(store.isOnCooldown("gemini")).toBe(false);
    // Store remains usable after a corrupt-file recovery
    store.recordFailure("gemini", "failed");
    expect(store.isOnCooldown("gemini")).toBe(true);
  });
});
