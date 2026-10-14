import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { parseHandoffFile, validateHandoffFields, parseFrontmatter, splitFrontmatter } from "../src/dispatch/codexHandoff.js";
import { resolveScope } from "../src/dispatch/codexScope.js";
import { dryRunCore } from "../src/cli/codex-cmd.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let testRoot: string;
let activeRoot: string;
let projectDir: string;

function makeHandoff(overrides: Record<string, string> = {}, extraFrontmatter = ""): string {
  const fields: Record<string, string> = {
    from: "claude",
    to: "codex",
    target: "codex",
    date: "2026-08-11 12:00:00",
    project: "testproj",
    project_path: projectDir,
    status: "pending",
    work_type: "execution",
    task_type: "review",
    action_type: "read",
    ...overrides,
  };

  const lines = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    lines.push(`${k}: ${v}`);
  }
  if (extraFrontmatter) lines.push(extraFrontmatter);
  lines.push("---", "", "# Task", "", "Do the thing.", "");
  return lines.join("\n");
}

function writeHandoff(name: string, content: string): string {
  const p = join(testRoot, name);
  writeFileSync(p, content, "utf8");
  return p;
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-codex-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  activeRoot = join(testRoot, "active");
  projectDir = join(activeRoot, "testproj");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "README.md"), "# testproj\n", "utf8");
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── splitFrontmatter / parseFrontmatter ────────────────────────────────────

describe("splitFrontmatter", () => {
  test("splits a valid frontmatter block", () => {
    const content = "---\nfoo: bar\n---\nbody text\n";
    const result = splitFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter).toBe("foo: bar");
    expect(result!.body).toBe("body text\n");
  });

  test("returns null when no frontmatter block present", () => {
    expect(splitFrontmatter("just some text\nno frontmatter\n")).toBeNull();
  });
});

describe("parseFrontmatter", () => {
  test("parses flat key: value pairs and lists", () => {
    const raw = parseFrontmatter([
      "from: claude",
      "allowed_files:",
      "  - src/a.ts",
      "  - src/b.ts",
      "forbidden_actions:",
      "  - git push",
    ].join("\n"));
    expect(raw["from"]).toBe("claude");
    expect(raw["allowed_files"]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(raw["forbidden_actions"]).toEqual(["git push"]);
  });
});

// ─── validateHandoffFields / parseHandoffFile ───────────────────────────────

describe("codexHandoff — valid handoff", () => {
  test("a fully-formed handoff parses successfully", () => {
    const content = makeHandoff({}, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("valid.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.to).toBe("codex");
      expect(result.request.target).toBe("codex");
      expect(result.request.project).toBe("testproj");
      expect(result.request.action_type).toBe("read");
      expect(result.request.allowed_files).toEqual(["README.md"]);
      expect(result.request.body).toContain("Do the thing.");
    }
  });
});

describe("codexHandoff — missing required fields", () => {
  test("rejects when project_path is missing", () => {
    const raw = parseFrontmatter([
      "from: claude",
      "to: codex",
      "target: codex",
      "project: testproj",
      "task_type: review",
      "action_type: read",
    ].join("\n"));
    const result = validateHandoffFields(raw, "body", "test.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "project_path")).toBe(true);
    }
  });

  test("rejects when action_type is invalid", () => {
    const content = makeHandoff({ action_type: "delete-everything" });
    const filePath = writeHandoff("bad-action.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "action_type")).toBe(true);
    }
  });
});

describe("codexHandoff — EXECUTE gate", () => {
  test("rejects EXECUTE without approved_by", () => {
    const content = makeHandoff({ task_type: "EXECUTE", approval_date: "2026-08-11" });
    const filePath = writeHandoff("execute-no-approver.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "approved_by")).toBe(true);
    }
  });

  test("rejects EXECUTE without approval_date", () => {
    const content = makeHandoff({ task_type: "EXECUTE", approved_by: "owner" });
    const filePath = writeHandoff("execute-no-date.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "approval_date")).toBe(true);
    }
  });

  test("rejects EXECUTE approved by someone other than the owner", () => {
    const content = makeHandoff({ task_type: "EXECUTE", approved_by: "Codex", approval_date: "2026-08-11" });
    const filePath = writeHandoff("execute-wrong-approver.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "approved_by")).toBe(true);
    }
  });

  test("accepts EXECUTE with approved_by: owner and approval_date present", () => {
    const content = makeHandoff({
      task_type: "EXECUTE",
      approved_by: "owner",
      approval_date: "2026-08-11",
      action_type: "write",
    }, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("execute-ok.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(true);
  });
});

describe("codexHandoff — non-codex target", () => {
  test("rejects when target is not codex", () => {
    const content = makeHandoff({ target: "gemini" });
    const filePath = writeHandoff("wrong-target.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "target")).toBe(true);
    }
  });

  test("rejects when to is not codex", () => {
    const content = makeHandoff({ to: "claude" });
    const filePath = writeHandoff("wrong-to.md", content);
    const result = parseHandoffFile(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "to")).toBe(true);
    }
  });
});

// ─── codexScope ──────────────────────────────────────────────────────────────

describe("codexScope — project_path boundary", () => {
  test("rejects project_path outside active root", () => {
    const outsideDir = join(testRoot, "not-active", "testproj");
    mkdirSync(outsideDir, { recursive: true });
    const content = makeHandoff({ project_path: outsideDir });
    const filePath = writeHandoff("outside-active.md", content);
    const parsed = parseHandoffFile(filePath);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const scopeResult = resolveScope(parsed.request, { activeRootOverride: activeRoot });
      expect(scopeResult.ok).toBe(false);
      if (!scopeResult.ok) {
        expect(scopeResult.errors.some(e => e.field === "project_path")).toBe(true);
      }
    }
  });

  test("rejects project_path that does not match the declared project name", () => {
    const otherProjectDir = join(activeRoot, "otherproj");
    mkdirSync(otherProjectDir, { recursive: true });
    const content = makeHandoff({ project: "testproj", project_path: otherProjectDir });
    const filePath = writeHandoff("mismatched-project.md", content);
    const parsed = parseHandoffFile(filePath);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const scopeResult = resolveScope(parsed.request, { activeRootOverride: activeRoot });
      expect(scopeResult.ok).toBe(false);
    }
  });

  test("accepts project_path correctly inside active/<project>/", () => {
    const content = makeHandoff({}, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("valid-scope.md", content);
    const parsed = parseHandoffFile(filePath);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const scopeResult = resolveScope(parsed.request, { activeRootOverride: activeRoot });
      expect(scopeResult.ok).toBe(true);
      if (scopeResult.ok) {
        expect(scopeResult.scope.canonicalAllowedFiles).toHaveLength(1);
      }
    }
  });
});

describe("codexScope — allowed_files traversal", () => {
  test("rejects a ../ traversal escaping project_path", () => {
    const content = makeHandoff({}, "allowed_files:\n  - ../../etc/passwd");
    const filePath = writeHandoff("traversal.md", content);
    const parsed = parseHandoffFile(filePath);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const scopeResult = resolveScope(parsed.request, { activeRootOverride: activeRoot });
      expect(scopeResult.ok).toBe(false);
      if (!scopeResult.ok) {
        expect(scopeResult.errors.some(e => e.field === "allowed_files")).toBe(true);
      }
    }
  });

  test("rejects a symlink inside project_path that escapes to outside", () => {
    const outsideTarget = join(testRoot, "secret.txt");
    writeFileSync(outsideTarget, "outside content\n", "utf8");
    const linkPath = join(projectDir, "escape-link.txt");
    try {
      symlinkSync(outsideTarget, linkPath);
    } catch {
      // Symlink creation unsupported in this environment — skip this case.
      return;
    }

    const content = makeHandoff({}, "allowed_files:\n  - escape-link.txt");
    const filePath = writeHandoff("symlink-escape.md", content);
    const parsed = parseHandoffFile(filePath);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const scopeResult = resolveScope(parsed.request, { activeRootOverride: activeRoot });
      expect(scopeResult.ok).toBe(false);
      if (!scopeResult.ok) {
        expect(scopeResult.errors.some(e => e.field === "allowed_files")).toBe(true);
      }
    }
  });
});

// ─── dry-run — zero side effects ────────────────────────────────────────────

describe("codex-cmd dry-run — zero side effects", () => {
  test("valid handoff: dry-run succeeds and touches nothing on disk", () => {
    const content = makeHandoff({}, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("dryrun-valid.md", content);

    const before = readdirSync(projectDir).sort();
    const beforeTestRoot = readdirSync(testRoot).sort();

    const result = dryRunCore(filePath, { activeRootOverride: activeRoot });

    const after = readdirSync(projectDir).sort();
    const afterTestRoot = readdirSync(testRoot).sort();

    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("No Codex process was spawned");
    expect(result.lines.join("\n")).toContain("No result handoff was written");
    expect(after).toEqual(before);
    expect(afterTestRoot).toEqual(beforeTestRoot);
  });

  test("invalid handoff: dry-run fails cleanly without touching disk", () => {
    const content = makeHandoff({ project_path: "" });
    const filePath = writeHandoff("dryrun-invalid.md", content);

    const before = readdirSync(testRoot).sort();
    const result = dryRunCore(filePath, { activeRootOverride: activeRoot });
    const after = readdirSync(testRoot).sort();

    expect(result.ok).toBe(false);
    expect(after).toEqual(before);
  });

  test("write-mode handoff: dry-run validates but reports it cannot dispatch", () => {
    const content = makeHandoff({
      task_type: "EXECUTE",
      approved_by: "owner",
      approval_date: "2026-08-11",
      action_type: "write",
    }, "allowed_files:\n  - README.md");
    const filePath = writeHandoff("dryrun-write.md", content);

    const result = dryRunCore(filePath, { activeRootOverride: activeRoot });
    expect(result.ok).toBe(true);
    expect(result.lines.join("\n")).toContain("dry-run never invokes Codex regardless of action_type");
  });
});
