import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { computeDispatchId } from "../src/dispatch/codexDispatchId.js";
import { DispatchDB } from "../src/dispatch/db.js";
import { statusCore, statusFileCore } from "../src/cli/codex-cmd.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let testRoot: string;
let stateDir: string;
let activeRoot: string;
let projectDir: string;

function makeHandoff(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    from: "claude",
    to: "codex",
    target: "codex",
    date: "2026-08-11 18:00:00",
    project: "testproj",
    project_path: projectDir,
    status: "pending",
    work_type: "review",
    task_type: "review",
    action_type: "read",
    ...overrides,
  };
  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push("---", "", "# Task", "", "Review the thing.", "");
  return lines.join("\n");
}

function writeHandoff(name: string, content: string): string {
  const p = join(testRoot, name);
  writeFileSync(p, content, "utf8");
  return p;
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-codex-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  activeRoot = join(testRoot, "active");
  projectDir = join(activeRoot, "testproj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# testproj\n", "utf8");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── computeDispatchId ───────────────────────────────────────────────────────

describe("computeDispatchId", () => {
  test("is deterministic for the same project + same canonical path", () => {
    const filePath = join(testRoot, "handoff.md");
    writeFileSync(filePath, "content", "utf8");
    const id1 = computeDispatchId("testproj", filePath);
    const id2 = computeDispatchId("testproj", filePath);
    expect(id1).toBe(id2);
  });

  test("differs for the same project + same basename in different directories", () => {
    const dirA = join(testRoot, "dir-a");
    const dirB = join(testRoot, "dir-b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const fileA = join(dirA, "handoff.md");
    const fileB = join(dirB, "handoff.md");
    writeFileSync(fileA, "content", "utf8");
    writeFileSync(fileB, "content", "utf8");

    const id1 = computeDispatchId("testproj", fileA);
    const id2 = computeDispatchId("testproj", fileB);
    expect(id1).not.toBe(id2); // same basename, different real directory — must NOT collide
  });

  test("a symlink alias to the same real file produces the same id", () => {
    const realFile = join(testRoot, "real-handoff.md");
    writeFileSync(realFile, "content", "utf8");
    const linkPath = join(testRoot, "aliased-handoff.md");
    try {
      symlinkSync(realFile, linkPath);
    } catch {
      // Symlink creation unsupported in this environment — skip this case.
      return;
    }

    const idReal = computeDispatchId("testproj", realFile);
    const idAlias = computeDispatchId("testproj", linkPath);
    expect(idReal).toBe(idAlias); // resolves through the symlink to the same canonical path
  });

  test("differs when the filename differs (same directory)", () => {
    const fileA = join(testRoot, "handoff-a.md");
    const fileB = join(testRoot, "handoff-b.md");
    writeFileSync(fileA, "content", "utf8");
    writeFileSync(fileB, "content", "utf8");
    const id1 = computeDispatchId("testproj", fileA);
    const id2 = computeDispatchId("testproj", fileB);
    expect(id1).not.toBe(id2);
  });

  test("differs when the project differs, same canonical path", () => {
    const filePath = join(testRoot, "handoff.md");
    writeFileSync(filePath, "content", "utf8");
    const id1 = computeDispatchId("proj-a", filePath);
    const id2 = computeDispatchId("proj-b", filePath);
    expect(id1).not.toBe(id2);
  });

  test("produces a 64-char hex sha256 digest", () => {
    const filePath = join(testRoot, "handoff.md");
    writeFileSync(filePath, "content", "utf8");
    const id = computeDispatchId("testproj", filePath);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── DispatchDB migration idempotency ───────────────────────────────────────

describe("DispatchDB — additive migration", () => {
  test("constructing twice on the same stateDir does not error, columns present both times", () => {
    const db1 = new DispatchDB(stateDir);
    db1.insert({
      id: "row-1", from: "claude", skill: "review", routed_to: "codex",
      status: "done", created_at: Date.now(), project: "testproj", source_file: "h1.md",
    });

    // Re-construct against the same DB file — migration must be a no-op, not an error.
    const db2 = new DispatchDB(stateDir);
    const record = db2.get("row-1");
    expect(record).not.toBeNull();
    expect(record?.project).toBe("testproj");
    expect(record?.source_file).toBe("h1.md");
  });

  test("legacy rows without project/source_file read back as undefined, not an error", () => {
    const db = new DispatchDB(stateDir);
    // Insert without project/source_file — mirrors a pre-migration row.
    db.insert({ id: "legacy-row", from: "claude", skill: "wire", routed_to: "system", status: "done", created_at: Date.now() });
    const record = db.get("legacy-row");
    expect(record).not.toBeNull();
    expect(record?.project).toBeUndefined();
    expect(record?.source_file).toBeUndefined();
  });
});

// ─── listRecentByRoutedTo ────────────────────────────────────────────────────

describe("DispatchDB — listRecentByRoutedTo", () => {
  test("returns only rows matching routed_to, respects limit and ordering", () => {
    const db = new DispatchDB(stateDir);
    db.insert({ id: "c1", from: "claude", skill: "review", routed_to: "codex", status: "done", created_at: 1000, project: "p1", source_file: "f1.md" });
    db.insert({ id: "c2", from: "claude", skill: "review", routed_to: "codex", status: "done", created_at: 2000, project: "p2", source_file: "f2.md" });
    db.insert({ id: "g1", from: "claude", skill: "research", routed_to: "gemini", status: "done", created_at: 3000 });

    const rows = db.listRecentByRoutedTo("codex", 20);
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.routed_to === "codex")).toBe(true);
    expect(rows[0]?.id).toBe("c2"); // most recent first
    expect(rows[1]?.id).toBe("c1");
  });

  test("respects the limit parameter", () => {
    const db = new DispatchDB(stateDir);
    for (let i = 0; i < 5; i++) {
      db.insert({ id: `c${i}`, from: "claude", skill: "review", routed_to: "codex", status: "done", created_at: i, project: "p", source_file: `f${i}.md` });
    }
    const rows = db.listRecentByRoutedTo("codex", 2);
    expect(rows).toHaveLength(2);
  });
});

// ─── wire codex status (no arg) ──────────────────────────────────────────────

describe("statusCore — no arg", () => {
  test("empty DB: reports no dispatches recorded", () => {
    const result = statusCore({ stateDir });
    const text = result.lines.join("\n");
    expect(text).toContain("No codex dispatches recorded yet.");
  });

  test("with rows: lists them with project, status, source_file", () => {
    const db = new DispatchDB(stateDir);
    db.insert({ id: "abc123", from: "claude", skill: "review", routed_to: "codex", status: "done", created_at: Date.now(), project: "testproj", source_file: "handoff-1.md" });

    const result = statusCore({ stateDir });
    const text = result.lines.join("\n");
    expect(text).toContain("Recent codex dispatches (1)");
    expect(text).toContain("testproj");
    expect(text).toContain("done");
    expect(text).toContain("handoff-1.md");
  });

  test("reports auth presence without requiring real credentials", () => {
    const result = statusCore({ stateDir });
    const text = result.lines.join("\n");
    expect(text).toContain("Codex auth:");
    expect(text).toContain("OPENAI_API_KEY:");
    expect(text).toContain("OPENAI_SESSION_TOKEN:");
  });
});

// ─── wire codex status <handoff-file> ────────────────────────────────────────

describe("statusFileCore — <handoff-file>", () => {
  test("never-dispatched file reports not yet dispatched", () => {
    const content = makeHandoff();
    const filePath = writeHandoff("never-dispatched.md", content);

    const result = statusFileCore(filePath, { stateDir });
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("Not yet dispatched");
  });

  test("already-dispatched file (matching id) reports its recorded status", () => {
    const content = makeHandoff();
    const filePath = writeHandoff("already-dispatched.md", content);

    const id = computeDispatchId("testproj", filePath);
    const db = new DispatchDB(stateDir);
    db.insert({ id, from: "claude", skill: "review", routed_to: "codex", status: "done", created_at: Date.now(), project: "testproj", source_file: "already-dispatched.md" });

    const result = statusFileCore(filePath, { stateDir });
    expect(result.ok).toBe(true);
    const text = result.lines.join("\n");
    expect(text).toContain("Already recorded");
    expect(text).toContain("done");
  });

  test("invalid handoff file reports validation errors, not a dedup lookup", () => {
    const filePath = writeHandoff("invalid.md", "not a valid handoff file at all");
    const result = statusFileCore(filePath, { stateDir });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("Handoff validation FAILED");
  });
});
