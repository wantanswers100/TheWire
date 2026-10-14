import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ParallelDispatcher } from "../src/dispatch/ParallelDispatcher.js";
import type { ParallelTask } from "../src/dispatch/parallel-types.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `wire-parallel-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.env["WIRE_TEST"] = "1";
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env["WIRE_TEST"];
});

function makeTask(overrides: Partial<ParallelTask> = {}): ParallelTask {
  return {
    subtaskId: ParallelDispatcher.newSubtaskId(),
    skill: "quick",
    subject: "test task",
    domain: ["general"],
    timeoutMs: 100, // short timeout for unit tests
    ...overrides,
  };
}

describe("ParallelDispatcher — safety guards", () => {
  test("rejects HITL skills at submission", async () => {
    const dispatcher = new ParallelDispatcher(testDir);
    await expect(
      dispatcher.dispatch({
        parentTaskId: "p1",
        tasks: [makeTask({ skill: "implement" as never })],
      })
    ).rejects.toThrow("HITL approval");
  });

  test("rejects duplicate subtask IDs", async () => {
    const id = ParallelDispatcher.newSubtaskId();
    const dispatcher = new ParallelDispatcher(testDir);
    await expect(
      dispatcher.dispatch({
        parentTaskId: "p2",
        tasks: [makeTask({ subtaskId: id }), makeTask({ subtaskId: id })],
      })
    ).rejects.toThrow("duplicate subtaskId");
  });

  test("all rejected HITL skills: implement, architect, scaffold, refactor, wire", async () => {
    const hitlSkills = ["implement", "architect", "scaffold", "refactor", "wire"];
    const dispatcher = new ParallelDispatcher(testDir);
    for (const skill of hitlSkills) {
      await expect(
        dispatcher.dispatch({ parentTaskId: "p3", tasks: [makeTask({ skill: skill as never })] })
      ).rejects.toThrow("HITL approval");
    }
  });
});

describe("ParallelDispatcher — subtask ID generation", () => {
  test("newSubtaskId returns unique 32-char hex strings", () => {
    const ids = new Set(Array.from({ length: 100 }, () => ParallelDispatcher.newSubtaskId()));
    expect(ids.size).toBe(100); // all unique
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

describe("ParallelDispatcher — group results retrieval", () => {
  test("getGroupResults returns empty for unknown parentTaskId", () => {
    const dispatcher = new ParallelDispatcher(testDir);
    const rows = dispatcher.getGroupResults("unknown-parent");
    expect(rows).toHaveLength(0);
  });
});

describe("ParallelDispatcher — dispatch with timeout", () => {
  test("tasks that time out return status=timeout", async () => {
    // We can't call real workers in unit tests, but we can verify timeout behavior
    // by using a very short timeout and a skill that would need a live Ollama
    const dispatcher = new ParallelDispatcher(testDir);
    const result = await dispatcher.dispatch({
      parentTaskId: "timeout-test",
      tasks: [makeTask({ skill: "quick", timeoutMs: 1 })], // 1ms timeout — will always timeout
    });
    // Either timeout or failed (worker unavailable) — not success
    expect(result.results[0]!.status).not.toBe("success");
    expect(result.parentTaskId).toBe("timeout-test");
  });

  test("dispatch returns ParallelDispatchResult shape", async () => {
    const dispatcher = new ParallelDispatcher(testDir);
    const result = await dispatcher.dispatch({
      parentTaskId: "shape-test",
      tasks: [makeTask({ timeoutMs: 1 })],
    });
    expect(typeof result.parentTaskId).toBe("string");
    expect(Array.isArray(result.results)).toBe(true);
    expect(typeof result.successCount).toBe("number");
    expect(typeof result.failureCount).toBe("number");
    expect(typeof result.totalDurationMs).toBe("number");
    expect(result.successCount + result.failureCount).toBe(result.results.length);
  });
});
