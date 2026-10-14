import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "../src/skills/SkillRegistry.js";
import type { OutcomeRecord } from "../src/types.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `wire-skills-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function makeOutcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    skill: "summarize",
    subject: "daily standup",
    agentUsed: "ollama",
    status: "success",
    resultSummary: "Summarized the key points from the standup meeting.",
    tokensUsed: 150,
    model: "qwen3:1.7b",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("SkillRegistry — record and retrieve", () => {
  test("record returns a positive id", () => {
    const reg = new SkillRegistry(testDir);
    const id = reg.record(makeOutcome());
    expect(id).toBeGreaterThan(0);
  });

  test("list returns recorded outcomes", () => {
    const reg = new SkillRegistry(testDir);
    reg.record(makeOutcome({ skill: "summarize" }));
    reg.record(makeOutcome({ skill: "summarize" }));
    const records = reg.list("summarize");
    expect(records.length).toBe(2);
  });

  test("list without skill arg returns all records", () => {
    const reg = new SkillRegistry(testDir);
    reg.record(makeOutcome({ skill: "summarize" }));
    reg.record(makeOutcome({ skill: "research" }));
    const all = reg.list();
    expect(all.length).toBe(2);
  });
});

describe("SkillRegistry — stats()", () => {
  test("returns null for unknown skill", () => {
    const reg = new SkillRegistry(testDir);
    expect(reg.stats("nonexistent")).toBeNull();
  });

  test("success_rate is 1.0 for all-success outcomes", () => {
    const reg = new SkillRegistry(testDir);
    reg.record(makeOutcome({ skill: "quick", status: "success" }));
    reg.record(makeOutcome({ skill: "quick", status: "success" }));
    reg.record(makeOutcome({ skill: "quick", status: "success" }));
    const stats = reg.stats("quick");
    expect(stats).not.toBeNull();
    expect(stats!.total).toBe(3);
    expect(stats!.successes).toBe(3);
    expect(stats!.failures).toBe(0);
    expect(stats!.success_rate).toBe(1.0);
  });

  test("success_rate is 0 for all-failed outcomes", () => {
    const reg = new SkillRegistry(testDir);
    reg.record(makeOutcome({ skill: "debug", status: "failed" }));
    reg.record(makeOutcome({ skill: "debug", status: "failed" }));
    const stats = reg.stats("debug");
    expect(stats!.success_rate).toBe(0);
  });

  test("mixed outcomes produce correct rate", () => {
    const reg = new SkillRegistry(testDir);
    reg.record(makeOutcome({ skill: "explain", status: "success" }));
    reg.record(makeOutcome({ skill: "explain", status: "success" }));
    reg.record(makeOutcome({ skill: "explain", status: "failed" }));
    const stats = reg.stats("explain");
    expect(stats!.total).toBe(3);
    // 2/3 ≈ 0.666
    expect(stats!.success_rate).toBeCloseTo(2 / 3, 2);
  });
});

describe("SkillRegistry — compression", () => {
  test("pendingCompression returns uncompressed success records", () => {
    const reg = new SkillRegistry(testDir);
    reg.record(makeOutcome({ skill: "research", status: "success" }));
    reg.record(makeOutcome({ skill: "research", status: "failed" })); // excluded
    const pending = reg.pendingCompression("research", 50);
    expect(pending.length).toBe(1);
    expect(pending[0]!.outcome).toBe("success");
  });

  test("markCompressed updates records", () => {
    const reg = new SkillRegistry(testDir);
    const id = reg.record(makeOutcome({ skill: "research", status: "success" }));
    reg.markCompressed([id], "Pattern: research tasks work well.", "qwen3:4b");
    const updated = reg.list("research");
    expect(updated[0]!.compressed_summary).toBe("Pattern: research tasks work well.");
    expect(updated[0]!.compression_model).toBe("qwen3:4b");
    expect(updated[0]!.compressed_at).toBeGreaterThan(0);
  });

  test("pendingCompression excludes already-compressed records", () => {
    const reg = new SkillRegistry(testDir);
    const id = reg.record(makeOutcome({ skill: "quick", status: "success" }));
    reg.markCompressed([id], "Already compressed.", "qwen3:4b");
    const pending = reg.pendingCompression("quick", 50);
    expect(pending.length).toBe(0);
  });
});
