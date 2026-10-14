// wire sync — post-task document reconciliation
//
// Detects drift between actual project state and what documents claim.
// Run after any significant change. Produces a reconciliation report.
// Optional --fix flag applies safe auto-corrections (dates, checked boxes).
//
// Usage:
//   wire sync                    # report only
//   wire sync --fix              # report + apply safe auto-fixes
//   wire sync --project <name>   # scan one project instead of agent-wire

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename }                          from "node:path";
import { homedir }                                 from "node:os";
import { spawnSync }                               from "node:child_process";

const PROJECT_ROOT  = join(import.meta.dir, "..", "..");
const PROJECTS_ROOT = join(homedir(), "projects");

const FIX_MODE   = process.argv.includes("--fix");
const TARGET_PROJECT = (() => {
  const idx = process.argv.indexOf("--project");
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const b  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const d  = (s: string) => `\x1b[2m${s}\x1b[0m`;
const g  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y  = (s: string) => `\x1b[33m${s}\x1b[0m`;
const r  = (s: string) => `\x1b[31m${s}\x1b[0m`;
const SEP = d("─".repeat(58));

// ─── Finding types ────────────────────────────────────────────────────────────

type Severity = "STALE" | "MISMATCH" | "OPEN" | "DONE";

interface Finding {
  file:     string;
  severity: Severity;
  message:  string;
  autofix?: () => void;  // defined if --fix can resolve this safely
}

const findings: Finding[] = [];

function flag(file: string, severity: Severity, message: string, autofix?: () => void): void {
  findings.push({ file, severity, message, autofix });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function runTests(projectRoot: string): { passing: number; total: number } | null {
  const result = spawnSync("bun", ["test", "--bail"], {
    cwd: projectRoot,
    env: { ...process.env },
    timeout: 60_000,
    encoding: "utf8",
  });
  // Parse "X pass" or "X/Y" from output
  const out = (result.stdout ?? "") + (result.stderr ?? "");
  const m = out.match(/(\d+)\s+pass/) ?? out.match(/(\d+)\/(\d+)/);
  if (m) {
    const passing = parseInt(m[1]!);
    const total   = m[2] ? parseInt(m[2]) : passing;
    return { passing, total };
  }
  return null;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function checkStatusMd(projectRoot: string, projectName: string): void {
  const path   = join(projectRoot, "STATUS.md");
  const text   = readFile(path);
  if (!text) return;

  // Last updated date
  const dateMatch = text.match(/\*\*Last updated:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  if (dateMatch && dateMatch[1] !== today()) {
    flag(path, "STALE",
      `Last updated: ${dateMatch[1]} — document date is stale (today is ${today()})`,
      () => {
        const updated = text.replace(
          /(\*\*Last updated:\*\*\s*)\d{4}-\d{2}-\d{2}/,
          `$1${today()}`
        );
        writeFileSync(path, updated);
      }
    );
  }
}

function checkBriefVsStatus(projectRoot: string): void {
  const briefPath  = join(projectRoot, "context", "brief.md");
  const statusPath = join(projectRoot, "STATUS.md");
  const brief  = readFile(briefPath);
  const status = readFile(statusPath);
  if (!brief || !status) return;

  // Phase number — handle both "Phase 44" and "**Phase:** 44" formats
  const briefPhase  = brief.match(/Phase[:\*\s]*(\d+)/i)?.[1];
  const statusPhase = status.match(/\*\*Phase:\*\*\s*(\d+)/)?.[1]
                   ?? status.match(/^Phase\s+(\d+)/im)?.[1];
  if (briefPhase && statusPhase && briefPhase !== statusPhase) {
    flag(briefPath, "MISMATCH",
      `Phase mismatch — brief.md says Phase ${briefPhase}, STATUS.md says Phase ${statusPhase}`
    );
  }

  // Test count
  const briefTests  = brief.match(/(\d+)\/(\d+)\s+tests/i);
  const statusTests = status.match(/(\d+)\/(\d+)\s+tests/i);
  if (briefTests && statusTests) {
    if (briefTests[1] !== statusTests[1] || briefTests[2] !== statusTests[2]) {
      flag(briefPath, "MISMATCH",
        `Test count mismatch — brief.md says ${briefTests[1]}/${briefTests[2]}, STATUS.md says ${statusTests[1]}/${statusTests[2]}`
      );
    }
  }
}

function checkIssuesMd(projectRoot: string): void {
  const path = join(projectRoot, "ISSUES.md");
  const text = readFile(path);
  if (!text) return;

  // Find open issues with RESOLVED/DONE status in description
  const blocks = text.split(/^### /m).slice(1);
  for (const block of blocks) {
    const idMatch = block.match(/^(ISS|DEC|RES)-(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[0];

    // Status line
    const statusLine = block.match(/\*\*Status[:\*]*\s*([^\n]+)/i)?.[1]?.trim() ?? "";

    // Check: issue body says RESOLVED/FIXED but status line still says ACTIVE/OPEN
    const bodyResolved = /RESOLVED|FIXED|CLOSED/i.test(block.slice(0, 500));
    const statusOpen   = /ACTIVE|OPEN|IN.PROGRESS/i.test(statusLine);

    if (bodyResolved && statusOpen) {
      flag(path, "OPEN",
        `${id} — body indicates resolved but status field still says "${statusLine.slice(0, 60)}"`
      );
    }

    // Check: strikethrough in heading but body has no RESOLVED status
    const isStruck = block.startsWith("~~");
    if (isStruck && statusOpen) {
      flag(path, "OPEN",
        `${id} — heading is struck through but status field still says ACTIVE`
      );
    }
  }
}

function checkPendingMd(): void {
  const path = join(PROJECTS_ROOT, "pending.md");
  const text = readFile(path);
  if (!text) return;

  // Find items that mention DONE/COMPLETE/✓ but aren't in a "DONE" column
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Table rows with PENDING status that reference things marked DONE elsewhere
    if (/\|\s*PENDING\s*\|/.test(line) && /~~.+~~/.test(line)) {
      flag(path, "DONE",
        `Line ${i + 1}: row has PENDING status but strikethrough text suggests it's done — consider marking ✓ DONE`
      );
    }
  }
}

function checkModelsConsistency(projectRoot: string): void {
  const modelsPath = join(projectRoot, "src", "config", "models.ts");
  const envPath    = join(projectRoot, ".env");
  const models = readFile(modelsPath);
  const env    = readFile(envPath);
  if (!models || !env) return;

  // Check if .env overrides match what models.ts defaults to
  const modelsFastDefault = models.match(/LLAMA4_FAST\s*=\s*env\("[^"]+",\s*"([^"]+)"\)/)?.[1];
  const envFastOverride   = env.match(/^LLAMA4_FAST\s*=\s*(.+)$/m)?.[1]?.trim();

  if (modelsFastDefault && envFastOverride && modelsFastDefault !== envFastOverride) {
    flag(modelsPath, "MISMATCH",
      `LLAMA4_FAST default in models.ts ("${modelsFastDefault}") differs from .env override ("${envFastOverride}") — .env wins but document the intent`
    );
  }

  // Warn if any removed Groq model appears as a live default (not in a comment)
  for (const removed of ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"]) {
    const re = new RegExp(`LLAMA4_(?:FAST|CAPABLE|DEFAULT)\\s*=\\s*env\\([^)]*"${removed.replace(/\./g, "\\.")}"\\)`);
    if (re.test(models)) {
      flag(modelsPath, "STALE",
        `LLAMA4 default still set to removed Groq model ${removed} — update to openai/gpt-oss-20b (fast) or openai/gpt-oss-120b (capable)`
      );
    }
  }
}

function checkDevlogDate(projectRoot: string): void {
  const path = join(projectRoot, "DEVLOG.md");
  const text = readFile(path);
  if (!text) return;

  // Find most recent entry date
  const dates = [...text.matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)];
  if (dates.length === 0) return;

  const latest = dates[0]![1]!;
  if (latest !== today()) {
    flag(path, "STALE",
      `Most recent DEVLOG entry is ${latest} — work done today may not be logged yet`
    );
  }
}

function checkTestsVsStatus(projectRoot: string): void {
  const statusPath = join(projectRoot, "STATUS.md");
  const status = readFile(statusPath);
  if (!status) return;

  const statusTests = status.match(/(\d+)\/(\d+)\s+tests?\s+passing/i);
  if (!statusTests) return;

  const docPassing = parseInt(statusTests[1]!);
  const docTotal   = parseInt(statusTests[2]!);

  // Only run tests if the test directory exists
  const testsDir = join(projectRoot, "tests");
  if (!existsSync(testsDir)) return;

  process.stdout.write(d("  Running tests to verify count...  "));
  const result = runTests(projectRoot);
  if (!result) { console.log(d("(could not parse test output)")); return; }

  console.log(d(`${result.passing}/${result.total}`));

  if (result.passing !== docPassing || result.total !== docTotal) {
    flag(statusPath, "MISMATCH",
      `Test count: STATUS.md says ${docPassing}/${docTotal} but bun test reports ${result.passing}/${result.total}`
    );
  }
}

// ─── Scan one project ─────────────────────────────────────────────────────────

function scanProject(projectRoot: string, projectName: string, runTestCheck: boolean): void {
  console.log(`\n${b(`Scanning: ${projectName}`)}  ${d(projectRoot)}`);

  checkStatusMd(projectRoot, projectName);
  checkBriefVsStatus(projectRoot);
  checkIssuesMd(projectRoot);
  checkModelsConsistency(projectRoot);
  checkDevlogDate(projectRoot);
  if (runTestCheck) checkTestsVsStatus(projectRoot);
  checkPendingMd();
}

// ─── Report ───────────────────────────────────────────────────────────────────

function printReport(): void {
  const total   = findings.length;
  const fixable = findings.filter(f => f.autofix).length;

  console.log(`\n${SEP}`);
  console.log(b(`sync report  —  ${total} finding${total !== 1 ? "s" : ""}  (${fixable} auto-fixable)`));
  console.log(SEP);

  if (total === 0) {
    console.log(g("\n  ✓ All documents consistent with current state.\n"));
    return;
  }

  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = f.file.replace(homedir(), "~");
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(f);
  }

  for (const [file, items] of byFile) {
    console.log(`\n  ${b(basename(file))}  ${d(file)}`);
    for (const item of items) {
      const icon = item.severity === "MISMATCH" ? r("✗")
                 : item.severity === "STALE"    ? y("⚠")
                 : item.severity === "DONE"     ? g("✓")
                 : y("?");
      const fixTag = item.autofix ? g(" [auto-fixable]") : "";
      console.log(`    ${icon} [${item.severity}] ${item.message}${fixTag}`);
    }
  }

  if (fixable > 0 && !FIX_MODE) {
    console.log(`\n  ${d(`Run ${b("wire sync --fix")} to apply ${fixable} safe auto-correction${fixable !== 1 ? "s" : ""}`)}`);
  }
  console.log();
}

function applyFixes(): void {
  const fixable = findings.filter(f => f.autofix);
  if (fixable.length === 0) { console.log(d("  Nothing to auto-fix.")); return; }

  console.log(`\n  Applying ${fixable.length} auto-fix${fixable.length !== 1 ? "es" : ""}...`);
  for (const f of fixable) {
    try {
      f.autofix!();
      console.log(`  ${g("✓")} Fixed: ${f.message.slice(0, 70)}`);
    } catch (e) {
      console.log(`  ${r("✗")} Failed: ${f.message.slice(0, 70)} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runSync(_args: string[]): Promise<void> {
  console.log(`\n${SEP}`);
  console.log(`${b("wire sync")}  ${d("—")}  ${d(today())}${FIX_MODE ? y("  [--fix mode]") : ""}`);
  console.log(SEP);

  if (TARGET_PROJECT) {
    // Single project mode
    const projRoot = join(PROJECTS_ROOT, "active", TARGET_PROJECT);
    if (!existsSync(projRoot)) {
      console.error(r(`  Project not found: ${projRoot}`));
      process.exit(1);
    }
    scanProject(projRoot, TARGET_PROJECT, true);
  } else {
    // Default: agent-wire (current project) with test run
    scanProject(PROJECT_ROOT, "agent-wire", true);
  }

  printReport();

  if (FIX_MODE && findings.some(f => f.autofix)) {
    applyFixes();
    // Re-scan after fixes to confirm clean
    findings.length = 0;
    console.log(b("\n  Re-scanning after fixes..."));
    if (TARGET_PROJECT) {
      const projRoot = join(PROJECTS_ROOT, "active", TARGET_PROJECT);
      scanProject(projRoot, TARGET_PROJECT, false);
    } else {
      scanProject(PROJECT_ROOT, "agent-wire", false);
    }
    const remaining = findings.filter(f => !f.autofix);
    if (remaining.length === 0) {
      console.log(g("\n  ✓ All auto-fixable issues resolved. Remaining findings require manual review.\n"));
    } else {
      printReport();
    }
  }
}
