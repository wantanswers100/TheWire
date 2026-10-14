import { describe, test, expect, beforeEach } from "bun:test";
import { MemoryStore } from "../src/agents/memory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wire-memory-"));
}

describe("MemoryStore", () => {
  let stateDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    stateDir = tmpDir();
    store = new MemoryStore(stateDir);
  });

  test("set and get a memory entry", async () => {
    const id = await store.set({ key: "test:key", value: "hello world", category: "observation" });
    expect(id).toBeGreaterThan(0);

    const entry = store.get("test:key", "observation");
    expect(entry).not.toBeNull();
    expect(entry!.key).toBe("test:key");
    expect(entry!.value).toBe("hello world");
    expect(entry!.category).toBe("observation");
  });

  test("upsert updates existing entry", async () => {
    await store.set({ key: "project:x", value: "v1", category: "project_state" });
    await store.set({ key: "project:x", value: "v2", category: "project_state" });

    const entry = store.get("project:x", "project_state");
    expect(entry!.value).toBe("v2");
  });

  test("keyword search finds matching entries", async () => {
    await store.set({ key: "task:1", value: "implemented dispatch loop in TypeScript", category: "task_log" });
    await store.set({ key: "task:2", value: "summarized gemini response", category: "task_log" });
    await store.set({ key: "pref:1", value: "prefer terse responses", category: "preference" });

    const results = await store.search({ query: "dispatch", topK: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.key).toBe("task:1");
    expect(results[0]!.score).toBe(1.0);
  });

  test("search returns empty when no match", async () => {
    await store.set({ key: "k", value: "something unrelated", category: "observation" });
    const results = await store.search({ query: "zzznomatch999" });
    expect(results.length).toBe(0);
  });

  test("category filter works on get", async () => {
    await store.set({ key: "shared:key", value: "task version", category: "task_log" });
    await store.set({ key: "shared:key", value: "pref version", category: "preference", agentId: "other" });

    const task = store.get("shared:key", "task_log");
    expect(task!.value).toBe("task version");
  });

  test("recent returns entries in reverse update order", async () => {
    await store.set({ key: "a", value: "first", category: "observation" });
    await store.set({ key: "b", value: "second", category: "observation" });

    const results = store.recent("observation", 10);
    expect(results.length).toBe(2);
    expect(results[0]!.key).toBe("b");
  });

  test("logTask stores task record", async () => {
    await store.logTask({
      taskId: "abc-123",
      from: "claude",
      skill: "research",
      subject: "agent architecture",
      routedTo: "gemini",
      status: "success",
      resultSummary: "Agent wire is a personal presence...",
    });

    const entry = store.get("task:abc-123", "task_log");
    expect(entry).not.toBeNull();
    const data = JSON.parse(entry!.value);
    expect(data.skill).toBe("research");
    expect(data.routedTo).toBe("gemini");
    expect(data.status).toBe("success");
  });

  test("tags are stored and retrievable", async () => {
    await store.set({ key: "tagged", value: "val", tags: ["typescript", "routing"] });
    const entry = store.get("tagged");
    expect(entry).not.toBeNull();
    const tags = JSON.parse(entry!.tags);
    expect(tags).toContain("typescript");
    expect(tags).toContain("routing");
  });
});
