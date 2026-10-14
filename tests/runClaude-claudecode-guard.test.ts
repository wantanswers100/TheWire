// Regression coverage for the 2026-08-12 live-dispatch finding: every
// recorded "spawnSync claude ETIMEDOUT" traced back to the dispatch daemon
// itself running with CLAUDECODE=1 in its environment (started from inside a
// live Claude Code session), which makes the nested `claude -p` child hang
// until the 120s timeout instead of failing fast. runClaude() now checks for
// CLAUDECODE up front and throws immediately instead of ever attempting the
// spawn.

import { describe, test, expect, afterEach } from "bun:test";
import { runClaude } from "../src/dispatch/workers.js";

const ORIGINAL_CLAUDECODE = process.env["CLAUDECODE"];

afterEach(() => {
  if (ORIGINAL_CLAUDECODE === undefined) delete process.env["CLAUDECODE"];
  else process.env["CLAUDECODE"] = ORIGINAL_CLAUDECODE;
});

describe("runClaude() — CLAUDECODE nested-session guard", () => {
  test("throws immediately (no spawn attempted) when CLAUDECODE=1 is set", async () => {
    process.env["CLAUDECODE"] = "1";
    await expect(runClaude("quick", { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" }))
      .rejects.toThrow(/CLAUDECODE=1/);
  });

  test("error message names the fix (restart the daemon outside a claude session)", async () => {
    process.env["CLAUDECODE"] = "1";
    try {
      await runClaude("quick", { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" });
      throw new Error("expected runClaude to throw");
    } catch (e) {
      expect((e as Error).message).toContain("wire dispatch stop && wire dispatch start");
    }
  });
});
