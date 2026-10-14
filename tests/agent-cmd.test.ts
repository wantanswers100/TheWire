import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasReadyPickupWork, statusCore } from "../src/cli/agent-cmd.js";
import { DispatchDB } from "../src/dispatch/db.js";

let testRoot: string;
let stateDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-agent-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("statusCore — filtered agent visibility", () => {
  test("unfiltered status lists all known tokens", () => {
    const out = statusCore(stateDir);

    expect(out).toContain("claude       rows: 0");
    expect(out).toContain("codex        rows: 0");
    expect(out).toContain("gemini       rows: 0");
    expect(out).toContain("ollama       rows: 0");
    expect(out).toContain("antigravity  rows: 0");
    expect(out).toContain("execution:    explicit pickup only; watch/status never invoke LLMs");
  });

  test("status does not create dispatch.db when no state exists yet", () => {
    const out = statusCore(stateDir);

    expect(out).toContain("claude       rows: 0");
    expect(existsSync(join(stateDir, "dispatch.db"))).toBe(false);
  });

  test("filtered status shows only the requested target rows", () => {
    const db = new DispatchDB(stateDir);
    db.insert({ id: "gemini-ready", from: "claude", skill: "research", routed_to: "gemini", status: "awaiting_hitl", created_at: 1, project: "p", source_file: "gemini.md" });
    db.insert({ id: "codex-ready", from: "claude", skill: "THINK", routed_to: "codex", status: "awaiting_hitl", created_at: 2, project: "p", source_file: "codex.md" });

    const out = statusCore(stateDir, "gemini");

    expect(out).toContain("filter:       gemini");
    expect(out).toContain("gemini       rows: 1");
    expect(out).toContain("gemini.md");
    expect(out).not.toContain("codex        rows:");
    expect(out).not.toContain("codex.md");
  });

  test("pickup readiness sees awaiting work even when a newer completed row exists", () => {
    const db = new DispatchDB(stateDir);
    db.insert({ id: "claude-ready", from: "codex", skill: "review", routed_to: "claude", status: "awaiting_hitl", created_at: 1, project: "p", source_file: "ready.md" });
    db.insert({ id: "claude-done", from: "codex", skill: "review", routed_to: "claude", status: "done", created_at: 2, project: "p", source_file: "done.md", result_id: "done-result.md" });

    expect(hasReadyPickupWork(stateDir, "claude")).toBe(true);
  });
});
