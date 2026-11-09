// WIRE_ROUTING_AGENTS operator allowlist: only listed agents may do work.
// Unset keeps every agent (public default unchanged).

import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WireRouter } from "../src/router/index.js";
import { isAgentAllowed, routingAllowlist } from "../src/router/agentAllowlist.js";
import { classify } from "../src/router/classifier.js";

let testRoot: string;
const saved = process.env["WIRE_ROUTING_AGENTS"];

function makeRoot(): string {
  testRoot = join(tmpdir(), `wire-allowlist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  return testRoot;
}

afterEach(() => {
  if (saved === undefined) delete process.env["WIRE_ROUTING_AGENTS"]; else process.env["WIRE_ROUTING_AGENTS"] = saved;
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
});

function rules(skill: string, filter?: string[]) {
  const router = new WireRouter(makeRoot()) as any;
  return router.routeByRules(
    { skill, verb: "query", domains: [], type: "task", ...(filter ? { modelFilter: new Set(filter) } : {}) },
    true, true, "balanced", [],
  );
}

describe("WIRE_ROUTING_AGENTS allowlist", () => {
  test("unset: every agent allowed", () => {
    delete process.env["WIRE_ROUTING_AGENTS"];
    expect(routingAllowlist()).toBeNull();
    expect(isAgentAllowed("ollama")).toBe(true);
  });

  test("set: only listed agents (plus system) allowed", () => {
    process.env["WIRE_ROUTING_AGENTS"] = "claude, codex,antigravity";
    for (const a of ["claude", "codex", "antigravity", "system"]) expect(isAgentAllowed(a as any)).toBe(true);
    for (const a of ["ollama", "gemini", "llama4", "deepseek"]) expect(isAgentAllowed(a as any)).toBe(false);
  });

  test("quick (normally ollama-first) never routes to a disabled agent", () => {
    process.env["WIRE_ROUTING_AGENTS"] = "claude,codex,antigravity";
    const d = rules("quick");
    expect(["claude", "codex", "antigravity"]).toContain(d.agent);
    for (const f of d.fallbacksAvailable) expect(["claude", "codex", "antigravity"]).toContain(f);
  });

  test("explicit request for a disabled agent is not silently substituted", () => {
    process.env["WIRE_ROUTING_AGENTS"] = "claude,codex,antigravity";
    const d = rules("quick", ["ollama"]);
    expect(d.agent).toBe("ollama");          // dispatch layer refuses it with a clear error
    expect(d.fallbacksAvailable).toEqual([]);
  });

  test("explicit antigravity request routes to antigravity", () => {
    process.env["WIRE_ROUTING_AGENTS"] = "claude,codex,antigravity";
    expect(rules("research", ["antigravity"]).agent).toBe("antigravity");
  });

  test("Ollama classifier is skipped when ollama is disabled (keyword fallback)", async () => {
    process.env["WIRE_ROUTING_AGENTS"] = "claude,codex,antigravity";
    expect(await classify("summarize these notes")).toBeNull();
  });
});

describe("dispatch loop refuses a disabled agent (second layer)", () => {
  test("callAgent throws for ollama when the allowlist excludes it", async () => {
    process.env["WIRE_ROUTING_AGENTS"] = "claude,codex,antigravity";
    const { DispatchLoop } = await import("../src/dispatch/loop.js");
    const root = makeRoot();
    const loop = new DispatchLoop({
      keysDir: join(root, ".keys"), stateDir: join(root, "state"), inboxDir: join(root, "inbox"),
      gatewayUrl: "http://localhost:0", agentToken: "test-token",
      judgeOverride: async () => ({ verdict: "pass", reason: "test judge" }),
    }) as any;
    await expect(loop.callAgent("ollama", "quick", { subject: "x" }, undefined))
      .rejects.toThrow("disabled by WIRE_ROUTING_AGENTS");
  });
});
