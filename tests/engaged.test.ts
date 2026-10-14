// "Wire is engaged" markers: present only while a call is in flight, removed
// on success AND on throw, and dead-process leftovers never show as engaged.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEngaged, listEngaged, engagedLine, callerFromClientName } from "../src/engaged.js";

const tmp = () => mkdtempSync(join(tmpdir(), "wire-engaged-"));

describe("engaged markers", () => {
  test("marker exists during the call and is gone after", async () => {
    const dir = tmp();
    let during: string[] = [];
    await withEngaged("codex", "wire_work", async () => { during = readdirSync(dir); }, dir);
    expect(during.length).toBe(1);
    expect(readdirSync(dir).length).toBe(0);
  });

  test("marker is removed when the call throws", async () => {
    const dir = tmp();
    await expect(withEngaged("terminal", "ask", async () => { throw new Error("boom"); }, dir)).rejects.toThrow("boom");
    expect(readdirSync(dir).length).toBe(0);
  });

  test("dead-pid and stale markers are skipped and cleaned up", () => {
    const dir = tmp();
    writeFileSync(join(dir, "999999-1.json"), JSON.stringify({ pid: 999999, caller: "x", action: "y", startedAt: Date.now() }));
    writeFileSync(join(dir, `${process.pid}-9.json`), JSON.stringify({ pid: process.pid, caller: "old", action: "z", startedAt: 0 }));
    writeFileSync(join(dir, "garbage.json"), "{not json");
    expect(listEngaged(dir)).toEqual([]);
    expect(readdirSync(dir).length).toBe(0);
  });

  test("status line text is empty when idle and compact when engaged", () => {
    expect(engagedLine([])).toBe("");
    const now = 100_000;
    const line = engagedLine([
      { pid: 1, caller: "claude-code", action: "wire_ask", startedAt: now - 12_000 },
      { pid: 2, caller: "codex", action: "wire_work", startedAt: now - 1_000 },
    ], now);
    expect(line).toBe("wire▸ claude-code:wire_ask 12s +1");
  });

  test("MCP client names map to short caller labels", () => {
    expect(callerFromClientName("claude-code")).toBe("claude-code");
    expect(callerFromClientName("codex-mcp-client")).toBe("codex");
    expect(callerFromClientName("antigravity")).toBe("antigravity");
    expect(callerFromClientName(undefined)).toBe("mcp");
  });
});
