import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runWatchCycle, getWatchStatusGroups } from "../src/dispatch/codexWatchLoop.js";
import { computeDispatchId, computeQuarantineId } from "../src/dispatch/codexDispatchId.js";
import { DispatchDB } from "../src/dispatch/db.js";
import { dispatchCore } from "../src/cli/codex-cmd.js";
import type { DispatchDeps } from "../src/cli/codex-cmd.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let testRoot: string;
let stateDir: string;
let inboxDir: string;
let activeRoot: string;
let projectDir: string;

function writeHandoff(name: string, content: string): string {
  const p = join(inboxDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function makeCodexHandoff(overrides: Record<string, string> = {}, extraFrontmatter = "allowed_files:\n  - README.md"): string {
  const fields: Record<string, string> = {
    from: "claude",
    to: "codex",
    target: "codex",
    date: "2026-08-12 00:00:00",
    project: "testproj",
    project_path: projectDir,
    status: "pending",
    work_type: "review",
    task_type: "THINK",
    action_type: "read",
    ...overrides,
  };
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  if (extraFrontmatter) lines.push(extraFrontmatter);
  lines.push("---", "", "# Task", "", "Do the thing.", "");
  return lines.join("\n");
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-codex-watch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  activeRoot = join(testRoot, "active");
  projectDir = join(activeRoot, "testproj");
  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# testproj\n", "utf8");
  writeFileSync(join(projectDir, "STATUS.md"), "**Active session:** none\n", "utf8");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── No Codex invocation path ────────────────────────────────────────────────

describe("codexWatchLoop — no Codex invocation path", () => {
  test("module never imports from workers.js — structurally cannot call runCodex/runCodexWrite", () => {
    // Checks the import surface, not a comment-fooled substring match on
    // "runCodex(" — this module's own doc comments legitimately mention both
    // function names in prose. The real guarantee is: it never imported the
    // module those functions live in, so it has no way to reach them at all.
    const source = readFileSync(join(import.meta.dir, "../src/dispatch/codexWatchLoop.ts"), "utf8");
    const importLines = source.split("\n").filter(l => l.trim().startsWith("import"));
    expect(importLines.some(l => l.includes("workers.js"))).toBe(false);
  });

  test("no --auto-read flag is parsed as actual code in codex-cmd.ts", () => {
    // The top-of-file doc comment legitimately mentions "--auto-read" in prose
    // (explicitly documenting that it does NOT exist) — strip comment lines
    // before searching, so this checks real code, not documentation text.
    const source = readFileSync(join(import.meta.dir, "../src/cli/codex-cmd.ts"), "utf8");
    const codeLines = source.split("\n").filter(l => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    expect(codeLines.some(l => l.includes("--auto-read"))).toBe(false);
  });
});

// ─── Read-only handoffs park, never dispatch ────────────────────────────────

describe("runWatchCycle — read-only handoffs park as awaiting_hitl", () => {
  test("valid THINK handoff parks, does not dispatch", () => {
    writeHandoff("think.md", makeCodexHandoff({ task_type: "THINK" }));

    const result = runWatchCycle(stateDir, inboxDir);

    expect(result.parked).toBe(1);
    expect(result.quarantined).toBe(0);

    const id = computeDispatchId("testproj", join(inboxDir, "think.md"));
    const record = new DispatchDB(stateDir).get(id);
    expect(record?.status).toBe("awaiting_hitl");
    expect(record?.skill).toBe("THINK");
  });

  test("valid RESEARCH handoff parks the same way", () => {
    writeHandoff("research.md", makeCodexHandoff({ task_type: "RESEARCH" }));
    const result = runWatchCycle(stateDir, inboxDir);
    expect(result.parked).toBe(1);
    const id = computeDispatchId("testproj", join(inboxDir, "research.md"));
    expect(new DispatchDB(stateDir).get(id)?.status).toBe("awaiting_hitl");
  });
});

// ─── Write-mode handoffs park, never dispatch ───────────────────────────────

describe("runWatchCycle — write-mode handoffs park as awaiting_hitl", () => {
  test("valid EXECUTE+write handoff parks, does not dispatch", () => {
    writeHandoff("execute.md", makeCodexHandoff({
      task_type: "EXECUTE", action_type: "write", approved_by: "owner", approval_date: "2026-08-12",
    }));

    const result = runWatchCycle(stateDir, inboxDir);

    expect(result.parked).toBe(1);
    const id = computeDispatchId("testproj", join(inboxDir, "execute.md"));
    const record = new DispatchDB(stateDir).get(id);
    expect(record?.status).toBe("awaiting_hitl");
    expect(record?.skill).toBe("EXECUTE");
  });
});

// ─── Ignore non-codex files ──────────────────────────────────────────────────

describe("runWatchCycle — ignores non-codex files", () => {
  test("target: gemini file is ignored, no DB row at all", () => {
    writeHandoff("gemini.md", makeCodexHandoff({ target: "gemini", to: "gemini" }));

    const result = runWatchCycle(stateDir, inboxDir);

    expect(result.ignored).toBe(1);
    expect(result.parked).toBe(0);
    expect(result.quarantined).toBe(0);
    expect(new DispatchDB(stateDir).listRecentByRoutedTo("codex", 100)).toHaveLength(0);
  });

  test("a completely unrelated file (not even frontmatter) is ignored, not quarantined", () => {
    writeHandoff("random-note.md", "Just some notes, not a handoff at all.\n");

    const result = runWatchCycle(stateDir, inboxDir);

    expect(result.ignored).toBe(1);
    expect(result.quarantined).toBe(0);
  });
});

// ─── Quarantine, no retry-loop ───────────────────────────────────────────────

describe("runWatchCycle — quarantines malformed codex-intended files, no retry-loop", () => {
  test("malformed codex handoff (missing project_path) quarantines", () => {
    writeHandoff("broken.md", [
      "---", "from: claude", "to: codex", "target: codex", "project: testproj",
      "task_type: THINK", "action_type: read", "---", "", "body", "",
    ].join("\n"));

    const result = runWatchCycle(stateDir, inboxDir);

    expect(result.quarantined).toBe(1);
    const qid = computeQuarantineId(join(inboxDir, "broken.md"));
    const record = new DispatchDB(stateDir).get(qid);
    expect(record?.status).toBe("quarantined");
    expect(record?.error).toContain("project_path");
  });

  test("rescanning the same broken file does not re-quarantine or reprocess", () => {
    writeHandoff("broken2.md", "---\nfrom: claude\nto: codex\ntarget: codex\n---\n\nbody\n");

    const first = runWatchCycle(stateDir, inboxDir);
    expect(first.quarantined).toBe(1);

    const second = runWatchCycle(stateDir, inboxDir);
    expect(second.quarantined).toBe(0);
    expect(second.skipped).toBe(1);

    expect(new DispatchDB(stateDir).listRecentByRoutedTo("codex", 100)).toHaveLength(1);
  });
});

// ─── Duplicate rows skipped ──────────────────────────────────────────────────

describe("runWatchCycle — duplicate handoffs not reprocessed", () => {
  test("a file already recorded (any status) is skipped on rescan", () => {
    const filePath = writeHandoff("dup.md", makeCodexHandoff());
    const id = computeDispatchId("testproj", filePath);
    new DispatchDB(stateDir).insert({ id, from: "claude", skill: "THINK", routed_to: "codex", status: "failed", created_at: Date.now(), project: "testproj", source_file: "dup.md" });

    const result = runWatchCycle(stateDir, inboxDir);

    expect(result.skipped).toBe(1);
    expect(result.parked).toBe(0);
    // status unchanged — watch never touches an existing row
    expect(new DispatchDB(stateDir).get(id)?.status).toBe("failed");
  });

  test("scanning the same new file twice in a row only parks it once", () => {
    writeHandoff("scan-twice.md", makeCodexHandoff());
    const first = runWatchCycle(stateDir, inboxDir);
    const second = runWatchCycle(stateDir, inboxDir);
    expect(first.parked).toBe(1);
    expect(second.parked).toBe(0);
    expect(second.skipped).toBe(1);
  });
});

// ─── status grouping ─────────────────────────────────────────────────────────

describe("getWatchStatusGroups — four-way grouping", () => {
  test("correctly separates ready read-only, write-awaiting, quarantined, and completed", () => {
    writeHandoff("think-a.md", makeCodexHandoff({ task_type: "THINK" }));
    writeHandoff("research-b.md", makeCodexHandoff({ task_type: "RESEARCH" }));
    writeHandoff("execute-c.md", makeCodexHandoff({ task_type: "EXECUTE", action_type: "write", approved_by: "owner", approval_date: "2026-08-12" }));
    writeHandoff("broken-d.md", "---\nfrom: claude\nto: codex\ntarget: codex\n---\n\nbody\n");

    runWatchCycle(stateDir, inboxDir);

    const db = new DispatchDB(stateDir);
    db.insert({ id: "done-row", from: "claude", skill: "THINK", routed_to: "codex", status: "done", created_at: Date.now(), project: "testproj", source_file: "old-done.md" });

    const groups = getWatchStatusGroups(stateDir);

    expect(groups.readyReadOnly).toHaveLength(2);
    expect(groups.readyReadOnly.every(r => r.skill === "THINK" || r.skill === "RESEARCH")).toBe(true);

    expect(groups.writeAwaiting).toHaveLength(1);
    expect(groups.writeAwaiting[0]?.skill).toBe("EXECUTE");

    expect(groups.quarantined).toHaveLength(1);

    expect(groups.recentCompleted).toHaveLength(1);
    expect(groups.recentCompleted[0]?.status).toBe("done");

    // No cross-contamination between groups
    expect(groups.writeAwaiting.some(r => groups.readyReadOnly.includes(r))).toBe(false);
  });
});

// ─── Insert-vs-update fix: manual dispatch still works on parked rows ───────

describe("insert-vs-update fix — manual dispatch correctly transitions a parked row", () => {
  test("dispatchCore transitions an awaiting_hitl row through running to done (mocked)", async () => {
    const filePath = writeHandoff("parked-then-dispatch.md", makeCodexHandoff({ task_type: "THINK" }));

    // Simulate watch having already parked this file.
    runWatchCycle(stateDir, inboxDir);
    const id = computeDispatchId("testproj", filePath);
    expect(new DispatchDB(stateDir).get(id)?.status).toBe("awaiting_hitl");

    const deps: DispatchDeps = {
      confirmFn: async () => true,
      runCodexFn: async () => ({ text: "mock output" }),
      stateDir,
      inboxDir: join(testRoot, "out-inbox"),
      scopeOpts: { activeRootOverride: activeRoot },
    };

    const result = await dispatchCore(filePath, deps);

    expect(result.ok).toBe(true);
    const record = new DispatchDB(stateDir).get(id);
    expect(record?.status).toBe("done");
    expect(record?.id).toBe(id); // same row, transitioned in place — not a duplicate insert
  });

  test("only one DispatchDB row exists after park + manual dispatch (no duplicate)", async () => {
    const filePath = writeHandoff("no-dup-row.md", makeCodexHandoff({ task_type: "RESEARCH" }));
    runWatchCycle(stateDir, inboxDir);

    const deps: DispatchDeps = {
      confirmFn: async () => true,
      runCodexFn: async () => ({ text: "ok" }),
      stateDir,
      inboxDir: join(testRoot, "out-inbox"),
      scopeOpts: { activeRootOverride: activeRoot },
    };
    await dispatchCore(filePath, deps);

    expect(new DispatchDB(stateDir).listRecentByRoutedTo("codex", 100)).toHaveLength(1);
  });
});
