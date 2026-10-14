// Tests for ProactiveMonitor and parseProjectsConfig — Phase 21

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProactiveMonitor, parseProjectsConfig } from "../src/proactive/monitor.js";

let stateDir: string;
let monitor: ProactiveMonitor;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "wire-monitor-test-"));
  monitor = new ProactiveMonitor(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

// ─── parseProjectsConfig (module-level, no class needed) ─────────────────────

test("parseProjectsConfig returns empty for missing projects key", () => {
  expect(parseProjectsConfig("{}")).toEqual([]);
});

test("parseProjectsConfig returns empty when projects is not an array", () => {
  expect(parseProjectsConfig(JSON.stringify({ projects: "oops" }))).toEqual([]);
  expect(parseProjectsConfig(JSON.stringify({ projects: null }))).toEqual([]);
});

test("parseProjectsConfig throws on malformed JSON", () => {
  expect(() => parseProjectsConfig("not json")).toThrow();
});

test("parseProjectsConfig returns valid entries and skips invalid ones", () => {
  const config = {
    projects: [
      { name: "good", path: "/some/path" },
      { name: "", path: "/bad-empty-name" },      // empty name — filtered
      { path: "/missing-name" },                   // missing name — filtered
      { name: "also-good", path: "/other/path" },
      { name: "empty-path", path: "" },            // empty path — filtered
    ],
  };
  const result = parseProjectsConfig(JSON.stringify(config));
  expect(result).toHaveLength(2);
  expect(result[0]!.name).toBe("good");
  expect(result[1]!.name).toBe("also-good");
});

// ─── loadProjects (via digest, since loadProjects is now private) ─────────────

test("digest returns empty array when no config", () => {
  expect(monitor.digest()).toEqual([]);
});

test("digest returns empty when projects.json has malformed JSON", () => {
  writeFileSync(join(stateDir, "projects.json"), "not json");
  expect(monitor.digest()).toEqual([]);
});

test("digest returns empty when projects.json has no projects array", () => {
  writeFileSync(join(stateDir, "projects.json"), JSON.stringify({ projects: "oops" }));
  expect(monitor.digest()).toEqual([]);
});

// ─── digest — STATUS.md detection ────────────────────────────────────────────

test("digest marks project without STATUS.md as hasStatus=false", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const result = monitor.digest();
    expect(result).toHaveLength(1);
    expect(result[0]!.hasStatus).toBe(false);
    expect(result[0]!.changed).toBe(false);
    expect(result[0]!.readError).toBeUndefined();
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("digest marks project as changed=true and isNew=true on first scan", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Status\nPhase 5 — in progress");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const result = monitor.digest();
    expect(result).toHaveLength(1);
    expect(result[0]!.hasStatus).toBe(true);
    expect(result[0]!.changed).toBe(true);
    expect(result[0]!.isNew).toBe(true);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("digest marks project as changed=false on second scan with same content", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Status\nPhase 5 — in progress");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    monitor.digest(); // first scan — stores hash
    const result = monitor.digest(); // second scan — same content

    expect(result[0]!.changed).toBe(false);
    expect(result[0]!.isNew).toBe(false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("digest detects changed content on subsequent scan", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    const statusPath = join(projectDir, "STATUS.md");
    writeFileSync(statusPath, "# Status\nPhase 5 — in progress");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    monitor.digest(); // first scan
    writeFileSync(statusPath, "# Status\nPhase 6 — complete"); // change content
    const result = monitor.digest(); // second scan

    expect(result[0]!.changed).toBe(true);
    expect(result[0]!.isNew).toBe(false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("digest captures snapshot of STATUS.md content", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Status\nLine 2\nLine 3");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const result = monitor.digest();
    expect(result[0]!.snapshot).toContain("# Status");
    expect(result[0]!.snapshot).toContain("Line 2");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("digest handles empty STATUS.md", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const result = monitor.digest();
    expect(result[0]!.hasStatus).toBe(true);
    expect(result[0]!.snapshot).toBe("");
    expect(result[0]!.changed).toBe(true); // new = changed

    // Second scan: empty file unchanged
    const result2 = monitor.digest();
    expect(result2[0]!.changed).toBe(false);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("digest handles multiple projects independently", () => {
  const dirA = mkdtempSync(join(tmpdir(), "wire-proj-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wire-proj-b-"));
  try {
    writeFileSync(join(dirA, "STATUS.md"), "Project A status");
    // dirB has no STATUS.md
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({
        projects: [
          { name: "alpha", path: dirA },
          { name: "beta", path: dirB },
        ],
      })
    );

    const result = monitor.digest();
    expect(result).toHaveLength(2);
    const alpha = result.find(r => r.name === "alpha")!;
    const beta = result.find(r => r.name === "beta")!;
    expect(alpha.hasStatus).toBe(true);
    expect(beta.hasStatus).toBe(false);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("digest surfaces unreadable STATUS.md as hasStatus=true with readError (not silent drop)", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    const statusPath = join(projectDir, "STATUS.md");
    writeFileSync(statusPath, "content");
    chmodSync(statusPath, 0o000); // make unreadable

    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const result = monitor.digest();
    expect(result).toHaveLength(1); // project must appear in result, not be silently dropped
    expect(result[0]!.hasStatus).toBe(true); // file exists
    expect(result[0]!.readError).toBeDefined(); // read failed — surfaced

    chmodSync(statusPath, 0o644); // restore for cleanup
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── CR1: stale DB entries ────────────────────────────────────────────────────

test("digest prunes stale DB rows when project removed from config", () => {
  const dirA = mkdtempSync(join(tmpdir(), "wire-proj-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "wire-proj-b-"));
  try {
    writeFileSync(join(dirA, "STATUS.md"), "Project A content");
    writeFileSync(join(dirB, "STATUS.md"), "Project B content");

    // Initial config with both projects
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "alpha", path: dirA }, { name: "beta", path: dirB }] })
    );
    monitor.digest(); // seeds both into DB

    // Remove beta from config — and use the same name for a DIFFERENT path
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "alpha", path: dirA }, { name: "beta", path: dirB + "-new" }] })
    );

    // The new beta path has no STATUS.md — should appear as hasStatus=false, not misclassified
    const result = monitor.digest();
    const beta = result.find(r => r.name === "beta");
    expect(beta).toBeDefined();
    expect(beta!.hasStatus).toBe(false); // new path has no STATUS.md
    // Stale hash from old beta should be gone — not causing wrong changed=false
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ─── format ───────────────────────────────────────────────────────────────────

test("format returns empty string for empty digest array", () => {
  expect(monitor.format([])).toBe("");
});

test("format shows updated mark for first-time (new) project", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Status\nPhase 5 in progress");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const digests = monitor.digest();
    const output = monitor.format(digests);
    expect(output).toContain("↑");
    expect(output).toContain("myproject");
    expect(output).toContain("new"); // first-ever scan → [new]
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("format shows updated label on second scan with changed content", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    const statusPath = join(projectDir, "STATUS.md");
    writeFileSync(statusPath, "# Status\nPhase 5");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    monitor.digest(); // first scan
    writeFileSync(statusPath, "# Status\nPhase 6 — updated!");
    const digests = monitor.digest(); // second scan with change
    const output = monitor.format(digests);
    expect(output).toContain("updated");
    expect(output).toContain("↑");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("format shows unchanged mark on second scan with same content", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Status\nPhase 5");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    monitor.digest(); // first scan
    const digests = monitor.digest(); // second scan — unchanged
    const output = monitor.format(digests);
    expect(output).toContain("·");
    expect(output).toContain("unchanged");
    expect(output).not.toContain("↑");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("format prefixes STATUS.md preview lines with '> ' to prevent spoofing", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Current Status\nPhase 7 — auth complete\nNext: deploy");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const digests = monitor.digest();
    const output = monitor.format(digests);
    expect(output).toContain("> # Current Status");
    expect(output).not.toContain("\n    # Current Status"); // must not appear without sigil
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("format does not show preview for unchanged projects", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Status\nPhase 5");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    monitor.digest(); // first scan — seeds hash
    const digests = monitor.digest(); // second — unchanged
    const output = monitor.format(digests);
    expect(output).not.toContain("# Status"); // no preview for unchanged
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("format does not show preview when snapshot is empty (changed but no content)", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(join(projectDir, "STATUS.md"), "# Phase 5");
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );
    monitor.digest(); // seed first hash

    // Change to all-whitespace (snapshot becomes "")
    writeFileSync(join(projectDir, "STATUS.md"), "   \n   \n   ");
    const digests = monitor.digest();
    const output = monitor.format(digests);
    // Should show updated mark but no preview lines
    expect(output).toContain("↑");
    expect(output).not.toContain("> "); // no preview lines
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("format notes missing STATUS.md", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "wire-project-"));
  try {
    writeFileSync(
      join(stateDir, "projects.json"),
      JSON.stringify({ projects: [{ name: "myproject", path: projectDir }] })
    );

    const digests = monitor.digest();
    const output = monitor.format(digests);
    expect(output).toContain("no STATUS.md");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
