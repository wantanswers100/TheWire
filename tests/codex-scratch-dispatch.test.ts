import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { dispatchCore, dispatchTestScratchCore } from "../src/cli/codex-cmd.js";
import type { DispatchDeps } from "../src/cli/codex-cmd.js";
import { DispatchDB } from "../src/dispatch/db.js";
import type { WorkerResult } from "../src/dispatch/workers.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────
// testRoot mimics a whole workspace: testRoot/active/... and testRoot/scratch/...
// side by side, so cross-mode rejection tests (active-mode rejecting scratch
// paths and vice versa) exercise real, distinct directory trees.

let testRoot: string;
let stateDir: string;
let inboxDir: string;
let activeRoot: string;
let scratchRoot: string;
let scratchProjectDir: string;
let activeProjectDir: string;

function git(args: string[], cwd: string): { stdout: string; status: number | null } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { stdout: (r.stdout ?? "").trim(), status: r.status };
}

function initGitProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  writeFileSync(join(dir, "STATUS.md"), [
    "# STATUS — fixture",
    "**Last updated:** 2026-08-11",
    "**Phase:** N/A",
    "**State:** ACTIVE",
    "**Active session:** none",
    "",
  ].join("\n"), "utf8");
  git(["init", "-q"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test"], dir);
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "initial"], dir);
}

function makeHandoff(projectPath: string, overrides: Record<string, string> = {}, extraFrontmatter = "allowed_files:\n  - README.md"): string {
  const fields: Record<string, string> = {
    from: "claude",
    to: "codex",
    target: "codex",
    date: "2026-08-11 23:00:00",
    project: "scratchfixture",
    project_path: projectPath,
    status: "pending",
    work_type: "implement",
    task_type: "EXECUTE",
    action_type: "write",
    approved_by: "owner",
    approval_date: "2026-08-11",
    ...overrides,
  };
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  if (extraFrontmatter) lines.push(extraFrontmatter);
  lines.push("---", "", "# Task", "", "Append one line to README.md.", "");
  return lines.join("\n");
}

function writeHandoff(name: string, content: string): string {
  const p = join(testRoot, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function ackYes(): Promise<boolean> { return Promise.resolve(true); }
function confirmYes(): Promise<boolean> { return Promise.resolve(true); }

function scratchDeps(overrides: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    scratchAckFn: ackYes,
    confirmFn: confirmYes,
    stateDir,
    inboxDir,
    scopeOpts: { activeRootOverride: scratchRoot },
    ...overrides,
  };
}

function mockWriteClean(): (skill: string, payload: Record<string, unknown>, ctx: string, projectPath: string) => Promise<WorkerResult> {
  return async (_s, _p, _c, projectPath) => {
    writeFileSync(join(projectPath, "README.md"), "# fixture\n\nUpdated by mock Codex.\n", "utf8");
    return { text: "Updated README.md.", model: "codex/mock" };
  };
}

function gitStatusPorcelain(dir: string): string {
  return git(["status", "--porcelain", "--untracked-files=all"], dir).stdout;
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-codex-scratch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  activeRoot = join(testRoot, "active");
  scratchRoot = join(testRoot, "scratch");
  scratchProjectDir = join(scratchRoot, "scratchfixture");
  activeProjectDir = join(activeRoot, "scratchfixture");
  initGitProject(scratchProjectDir);
  initGitProject(activeProjectDir);
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── Cross-mode rejection (both directions) ─────────────────────────────────

describe("scratch mode — cross-mode rejection", () => {
  test("dispatchTestScratchCore refuses a project_path inside active/", async () => {
    const content = makeHandoff(activeProjectDir);
    const filePath = writeHandoff("active-via-scratch.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("scratch mode");
  });

  test("normal dispatchCore still refuses a project_path inside scratch/", async () => {
    const content = makeHandoff(scratchProjectDir, { work_type: "review", task_type: "THINK", action_type: "read" }, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("scratch-via-normal.md", content);

    const result = await dispatchCore(filePath, { scopeOpts: { activeRootOverride: activeRoot }, stateDir, inboxDir });

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("normal mode");
  });
});

// ─── action_type restriction ─────────────────────────────────────────────────

describe("scratch mode — action_type restriction", () => {
  test("refuses action_type: read outright", async () => {
    const content = makeHandoff(scratchProjectDir, { task_type: "THINK", action_type: "read" });
    const filePath = writeHandoff("scratch-read.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("only for write-mode EXECUTE validation");
  });
});

// ─── CLI-only, frontmatter cannot self-enable ───────────────────────────────

describe("scratch mode — CLI-only activation", () => {
  test("a handoff file with a stray test_scratch: true field is still refused by normal dispatch when pointed at scratch/", async () => {
    const content = makeHandoff(scratchProjectDir, { work_type: "review", task_type: "THINK", action_type: "read" }, "allowed_files:\n  - README.md\ntest_scratch: true");
    const filePath = writeHandoff("self-enable-attempt.md", content);

    // Dispatched via the NORMAL entry point (no --test-scratch flag equivalent) —
    // the stray frontmatter field must have zero effect.
    const result = await dispatchCore(filePath, { scopeOpts: { activeRootOverride: activeRoot }, stateDir, inboxDir });

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("normal mode");
  });
});

// ─── Reused git-only preflight ───────────────────────────────────────────────

describe("scratch mode — reused git-only preflight", () => {
  test("refuses a non-git scratch directory", async () => {
    const nonGitDir = join(scratchRoot, "nongit");
    mkdirSync(nonGitDir, { recursive: true });
    writeFileSync(join(nonGitDir, "README.md"), "# nongit\n", "utf8");
    writeFileSync(join(nonGitDir, "STATUS.md"), "**Active session:** none\n", "utf8");

    const content = makeHandoff(nonGitDir, { project: "nongit" });
    const filePath = writeHandoff("nongit-scratch.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("git-only in this build");
  });

  test("refuses a dirty scratch tree", async () => {
    writeFileSync(join(scratchProjectDir, "README.md"), "# fixture\n\ndirty\n", "utf8");
    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("dirty-scratch.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("working tree is not clean");
  });

  test("refuses missing/malformed Active session field", async () => {
    writeFileSync(join(scratchProjectDir, "STATUS.md"), "# STATUS\nno active session field\n", "utf8");
    git(["add", "-A"], scratchProjectDir);
    git(["commit", "-q", "-m", "malformed status"], scratchProjectDir);

    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("malformed-status.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("Active session");
  });

  test("refuses project name mismatch against the scratch directory", async () => {
    const content = makeHandoff(scratchProjectDir, { project: "wrongname" });
    const filePath = writeHandoff("wrong-project-name.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
  });

  test("refuses empty allowed_files", async () => {
    const content = makeHandoff(scratchProjectDir, {}, "");
    const filePath = writeHandoff("empty-allowed-scratch.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps());

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("non-empty allowed_files");
  });
});

// ─── Two required confirmations ─────────────────────────────────────────────

describe("scratch mode — two required confirmations", () => {
  test("refusing the scratch acknowledgment writes zero DB rows and zero files", async () => {
    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("ack-no.md", content);
    mkdirSync(inboxDir, { recursive: true });
    const beforeStatus = gitStatusPorcelain(scratchProjectDir);

    const result = await dispatchTestScratchCore(filePath, scratchDeps({ scratchAckFn: async () => false, runCodexWriteFn: mockWriteClean() }));

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("scratch-mode acknowledgment not confirmed");
    expect(new DispatchDB(stateDir).listRecentByRoutedTo("codex", 100)).toHaveLength(0);
    expect(readdirSync(inboxDir)).toHaveLength(0);
    expect(gitStatusPorcelain(scratchProjectDir)).toBe(beforeStatus);
  });

  test("refusing the cost gate (after ack passes) writes zero DB rows and zero files", async () => {
    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("ack-yes-confirm-no.md", content);
    mkdirSync(inboxDir, { recursive: true });

    const result = await dispatchTestScratchCore(filePath, scratchDeps({ confirmFn: async () => false, runCodexWriteFn: mockWriteClean() }));

    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("not confirmed at cost gate");
    expect(new DispatchDB(stateDir).listRecentByRoutedTo("codex", 100)).toHaveLength(0);
    expect(readdirSync(inboxDir)).toHaveLength(0);
  });

  test("confirmation order: ack must fire before cost gate, before DB insert, before runCodexWrite", async () => {
    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("order.md", content);
    const calls: string[] = [];

    const scratchAckFn = async () => { calls.push("ack"); return true; };
    const confirmFn = async () => { calls.push("confirm"); return true; };
    const runCodexWriteFn = async (_s: string, _p: Record<string, unknown>, _c: string, projectPath: string) => {
      calls.push("runCodexWrite");
      writeFileSync(join(projectPath, "README.md"), "# fixture\n\nmock\n", "utf8");
      return { text: "ok" };
    };

    await dispatchTestScratchCore(filePath, scratchDeps({ scratchAckFn, confirmFn, runCodexWriteFn }));

    expect(calls).toEqual(["ack", "confirm", "runCodexWrite"]);
  });

  test("both confirmations yes -> proceeds successfully", async () => {
    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("both-yes.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps({ runCodexWriteFn: mockWriteClean() }));

    expect(result.ok).toBe(true);
  });
});

// ─── Result handoff carries scratch_mode: true ──────────────────────────────

describe("scratch mode — result handoff", () => {
  test("done result handoff includes scratch_mode: true", async () => {
    const content = makeHandoff(scratchProjectDir);
    const filePath = writeHandoff("scratch-result.md", content);

    const result = await dispatchTestScratchCore(filePath, scratchDeps({ runCodexWriteFn: mockWriteClean() }));

    expect(result.ok).toBe(true);
    expect(result.resultFilePath).toBeDefined();
    expect(result.resultFilePath!.startsWith(inboxDir)).toBe(true);

    const resultContent = readFileSync(result.resultFilePath!, "utf8");
    expect(resultContent).toContain("scratch_mode: true");
    expect(resultContent).toContain("dispatch_status: done");

    const db = new DispatchDB(stateDir);
    expect(db.get(result.dispatchId!)?.status).toBe("done");
  });

  test("a real (non-scratch) write-mode result handoff never includes scratch_mode", async () => {
    // Regression: confirms scratch_mode is opt-in per call, not a default that
    // leaked into the normal write path.
    const content = makeHandoff(activeProjectDir, {}, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("normal-result.md", content);

    const result = await dispatchCore(filePath, {
      scopeOpts: { activeRootOverride: activeRoot },
      stateDir,
      inboxDir,
      confirmFn: confirmYes,
      runCodexWriteFn: mockWriteClean(),
    });

    expect(result.ok).toBe(true);
    const resultContent = readFileSync(result.resultFilePath!, "utf8");
    expect(resultContent).not.toContain("scratch_mode");
  });
});
