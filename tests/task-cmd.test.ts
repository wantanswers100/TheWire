// Regression coverage for ISS-027: `wire task` must address the wire
// envelope to "claude" (so DispatchLoop's inbox watcher — which only
// processes messages with to==="claude", loop.ts:126 — actually picks it
// up), and must route the `--to <agent>` request through payload.modelFilter
// instead of the envelope `to` field. Before this fix, `wire task --to
// gemini ...` silently produced a message nothing ever consumed: the daemon
// discarded it (wrong `to`), and agentPickup.ts's manual pickup mechanism
// only reads .md handoff files, never .wire.json task messages.
//
// This file existed nowhere before the fix — `bun test` stayed green through
// the entire ISS-027 investigation because runTask() had zero coverage.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runTask } from "../src/cli/task-cmd.js";

let testRoot: string;
let inboxDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-task-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function readOnlyFile(): Record<string, unknown> {
  const files = readdirSync(inboxDir);
  expect(files.length).toBe(1);
  return JSON.parse(readFileSync(join(inboxDir, files[0]!), "utf8"));
}

describe("wire task — envelope addressing (ISS-027)", () => {
  test("--to ollama writes an envelope addressed to claude, with ollama in modelFilter", async () => {
    await runTask(
      ["--to", "ollama", "--skill", "quick", "--verb", "query", "--subject", "test subject"],
      "", "", inboxDir
    );

    const msg = readOnlyFile();
    expect(msg["to"]).toBe("claude");
    expect((msg["payload"] as Record<string, unknown>)["modelFilter"]).toEqual(["ollama"]);
  });

  test("--to gemini writes an envelope addressed to claude, with gemini in modelFilter (never addressed directly to gemini)", async () => {
    await runTask(
      ["--to", "gemini", "--skill", "research", "--verb", "query", "--subject", "test subject"],
      "", "", inboxDir
    );

    const msg = readOnlyFile();
    expect(msg["to"]).toBe("claude");
    expect(msg["to"]).not.toBe("gemini");
    expect((msg["payload"] as Record<string, unknown>)["modelFilter"]).toEqual(["gemini"]);
  });

  test("--to claude writes an envelope addressed to claude, with claude in modelFilter", async () => {
    await runTask(
      ["--to", "claude", "--skill", "explain", "--verb", "explain", "--subject", "test subject"],
      "", "", inboxDir
    );

    const msg = readOnlyFile();
    expect(msg["to"]).toBe("claude");
    expect((msg["payload"] as Record<string, unknown>)["modelFilter"]).toEqual(["claude"]);
  });

  test("--models overrides --to for modelFilter (explicit multi-agent restriction wins)", async () => {
    await runTask(
      ["--to", "ollama", "--models", "ollama,deepseek", "--skill", "quick", "--verb", "query", "--subject", "test subject"],
      "", "", inboxDir
    );

    const msg = readOnlyFile();
    expect(msg["to"]).toBe("claude");
    expect((msg["payload"] as Record<string, unknown>)["modelFilter"]).toEqual(["ollama", "deepseek"]);
  });

  test("payload.domain always has at least one entry (schema requires non-empty domain — see the live-test finding logged in ISSUES.md)", async () => {
    await runTask(
      ["--to", "ollama", "--skill", "quick", "--verb", "query", "--subject", "test subject"],
      "", "", inboxDir
    );

    const msg = readOnlyFile();
    const domain = (msg["payload"] as Record<string, unknown>)["domain"] as unknown[];
    expect(Array.isArray(domain)).toBe(true);
    expect(domain.length).toBeGreaterThan(0);
  });
});
