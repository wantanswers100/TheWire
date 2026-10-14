import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeAgentDispatchId,
  computeAgentQuarantineId,
  getAgentStatusGroups,
  runAgentWatchCycle,
} from "../src/dispatch/agentWatchLoop.js";
import { DispatchDB } from "../src/dispatch/db.js";
import { computeDispatchId } from "../src/dispatch/codexDispatchId.js";

let testRoot: string;
let stateDir: string;
let inboxDir: string;

function writeInbox(name: string, content: string): string {
  const p = join(inboxDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function makeHandoff(from: string, to: string, overrides: Record<string, string> = {}): string {
  const fields = {
    from,
    to,
    target: to,
    date: "2026-08-11 17:45:00",
    project: "agent-wire",
    status: "pending",
    work_type: "review",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    "# Handoff",
    "",
    "Review this.",
    "",
  ].join("\n");
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-agent-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("agentWatchLoop — no execution imports", () => {
  test("watch loop is structurally incapable of dispatching agents", () => {
    const source = readFileSync(join(import.meta.dir, "../src/dispatch/agentWatchLoop.ts"), "utf8");
    const importLines = source.split("\n").filter(l => l.trim().startsWith("import"));
    expect(importLines.some(l => l.includes("workers.js"))).toBe(false);
    expect(importLines.some(l => l.includes("child_process"))).toBe(false);
    expect(importLines.some(l => l.includes("adapters"))).toBe(false);
  });
});

describe("runAgentWatchCycle — direction matrix", () => {
  const directions: Array<[string, string]> = [
    ["claude", "codex"],
    ["codex", "claude"],
    ["claude", "gemini"],
    ["gemini", "claude"],
    ["claude", "ollama"],
    ["ollama", "claude"],
    ["claude", "antigravity"],
    ["antigravity", "claude"],
  ];

  for (const [from, to] of directions) {
    test(`parks ${from} -> ${to}`, () => {
      const filePath = writeInbox(`${from}_${to}.md`, makeHandoff(from, to));

      const result = runAgentWatchCycle(stateDir, inboxDir);

      expect(result.parked).toBe(1);
      expect(result.quarantined).toBe(0);

      const id = computeAgentDispatchId(to, "agent-wire", filePath);
      const record = new DispatchDB(stateDir).get(id);
      expect(record?.from).toBe(from);
      expect(record?.routed_to).toBe(to);
      expect(record?.status).toBe("awaiting_hitl");
      expect(record?.skill).toBe("review");
      expect(record?.source_file).toBe(`${from}_${to}.md`);
    });
  }
});

describe("runAgentWatchCycle — classification", () => {
  test("malformed known-target handoff quarantines", () => {
    const filePath = writeInbox("broken-claude.md", [
      "---",
      "from: codex",
      "to: claude",
      "target: claude",
      "project: agent-wire",
      "---",
      "",
      "body",
      "",
    ].join("\n"));

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.quarantined).toBe(1);
    const id = computeAgentQuarantineId("claude", filePath);
    const record = new DispatchDB(stateDir).get(id);
    expect(record?.status).toBe("quarantined");
    expect(record?.routed_to).toBe("claude");
    expect(record?.error).toContain("date");
  });

  test("unknown target is ignored, not quarantined", () => {
    writeInbox("unknown.md", makeHandoff("claude", "nobody"));

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.ignored).toBe(1);
    expect(result.parked).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(new DispatchDB(stateDir).listRecentByRoutedTo("nobody", 10)).toHaveLength(0);
  });

  test("unrelated inbox files are ignored", () => {
    writeInbox("notes.md", "just notes\n");

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.ignored).toBe(1);
    expect(result.parked).toBe(0);
    expect(result.quarantined).toBe(0);
  });

  test("non-markdown files are not scanned", () => {
    writeInbox("raw.txt", makeHandoff("claude", "codex"));

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.scanned).toBe(0);
    expect(result.ignored).toBe(0);
  });

  test("actioned result handoffs are recorded as completed, not parked as fresh work", () => {
    const filePath = writeInbox("claude_codex_result.md", makeHandoff("claude", "codex", { status: "actioned" }));

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.parked).toBe(0);
    expect(result.completed).toBe(1);
    expect(result.skipped).toBe(0);
    const id = computeAgentDispatchId("codex", "agent-wire", filePath);
    const record = new DispatchDB(stateDir).get(id);
    expect(record?.status).toBe("done");

    const groups = getAgentStatusGroups(stateDir, 50, "codex");
    expect(groups.ready).toHaveLength(0);
    expect(groups.recentCompleted.map(r => r.id)).toEqual([id]);
  });
});

describe("runAgentWatchCycle — idempotency", () => {
  test("rescanning a parked file does not duplicate rows", () => {
    writeInbox("twice.md", makeHandoff("claude", "gemini"));

    const first = runAgentWatchCycle(stateDir, inboxDir);
    const second = runAgentWatchCycle(stateDir, inboxDir);

    expect(first.parked).toBe(1);
    expect(second.parked).toBe(0);
    expect(second.skipped).toBe(1);
    expect(new DispatchDB(stateDir).listRecentByRoutedTo("gemini", 10)).toHaveLength(1);
  });

  test("existing row in any status is skipped", () => {
    const filePath = writeInbox("existing.md", makeHandoff("claude", "ollama"));
    const id = computeAgentDispatchId("ollama", "agent-wire", filePath);
    new DispatchDB(stateDir).insert({
      id,
      from: "claude",
      skill: "review",
      routed_to: "ollama",
      status: "failed",
      created_at: Date.now(),
      project: "agent-wire",
      source_file: "existing.md",
    });

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.skipped).toBe(1);
    expect(result.parked).toBe(0);
    expect(new DispatchDB(stateDir).get(id)?.status).toBe("failed");
  });

  test("existing Codex-specific watcher row is not duplicated by universal watcher", () => {
    const filePath = writeInbox("codex-compatible.md", makeHandoff("claude", "codex", { task_type: "THINK" }));
    const codexId = computeDispatchId("agent-wire", filePath);
    new DispatchDB(stateDir).insert({
      id: codexId,
      from: "claude",
      skill: "THINK",
      routed_to: "codex",
      status: "awaiting_hitl",
      created_at: Date.now(),
      project: "agent-wire",
      source_file: "codex-compatible.md",
    });

    const result = runAgentWatchCycle(stateDir, inboxDir);

    expect(result.skipped).toBe(1);
    expect(result.parked).toBe(0);
    expect(new DispatchDB(stateDir).listRecentByRoutedTo("codex", 10)).toHaveLength(1);
  });
});

describe("getAgentStatusGroups", () => {
  test("groups ready (including antigravity), quarantined, and completed rows", () => {
    const db = new DispatchDB(stateDir);
    db.insert({ id: "ready", from: "claude", skill: "review", routed_to: "gemini", status: "awaiting_hitl", created_at: 1, project: "p", source_file: "ready.md" });
    // antigravity is now a first-class dispatch agent — its handoffs land in ready, not manualOnly
    db.insert({ id: "agy-ready", from: "claude", skill: "review", routed_to: "antigravity", status: "awaiting_hitl", created_at: 2, project: "p", source_file: "agy.md" });
    db.insert({ id: "bad", from: "unknown", skill: "quarantine", routed_to: "claude", status: "quarantined", created_at: 3, source_file: "bad.md" });
    db.insert({ id: "done", from: "claude", skill: "THINK", routed_to: "codex", status: "done", created_at: 4, project: "p", source_file: "done.md" });

    const groups = getAgentStatusGroups(stateDir);

    expect(groups.ready.map(r => r.id).sort()).toEqual(["agy-ready", "ready"]);
    expect(groups.manualOnly).toEqual([]);
    expect(groups.quarantined.map(r => r.id)).toEqual(["bad"]);
    expect(groups.recentCompleted.map(r => r.id)).toEqual(["done"]);
  });

  test("can filter groups to one target for Gemini/manual pickup views", () => {
    const db = new DispatchDB(stateDir);
    db.insert({ id: "gemini-ready", from: "claude", skill: "research", routed_to: "gemini", status: "awaiting_hitl", created_at: 1, project: "p", source_file: "gemini.md" });
    db.insert({ id: "codex-ready", from: "claude", skill: "THINK", routed_to: "codex", status: "awaiting_hitl", created_at: 2, project: "p", source_file: "codex.md" });

    const groups = getAgentStatusGroups(stateDir, 50, "gemini");

    expect(groups.ready.map(r => r.id)).toEqual(["gemini-ready"]);
    expect(groups.ready.some(r => r.routed_to === "codex")).toBe(false);
  });
});
