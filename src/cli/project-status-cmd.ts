// wire project-status — show project STATUS.md + context deliverables and risks
//
// Usage:
//   wire project-status <project-name>

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ACTIVE_DIR = join(homedir(), "projects", "active");

function ok(s: string): string   { return `\x1b[32m${s}\x1b[0m`; }
function warn(s: string): string  { return `\x1b[33m${s}\x1b[0m`; }
function dim(s: string): string   { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string): string  { return `\x1b[1m${s}\x1b[0m`; }

function printSection(title: string, content: string, maxLines = 40): void {
  const lines = content.trim().split("\n");
  const shown = lines.slice(0, maxLines);
  const clipped = lines.length > maxLines;

  console.log(bold(`\n${title}`));
  console.log(dim("─".repeat(50)));
  for (const line of shown) console.log(line);
  if (clipped) console.log(dim(`  ... (${lines.length - maxLines} more lines)`));
}

function tryRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

export function runProjectStatus(args: string[]): void {
  const projectName = args.find(a => !a.startsWith("--"));

  if (!projectName) {
    console.error("Usage: wire project-status <project-name>");
    process.exit(1);
  }

  const projectDir  = join(ACTIVE_DIR, projectName);
  const contextDir  = join(projectDir, "context");
  const statusPath  = join(projectDir, "STATUS.md");
  const delivPath   = join(contextDir, "deliverables.md");
  const risksPath   = join(contextDir, "risks.md");
  const briefPath   = join(contextDir, "brief.md");

  if (!existsSync(projectDir)) {
    console.error(`[wire] Project not found: ${projectName}`);
    console.error(`  Expected: ${projectDir}`);
    process.exit(1);
  }

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${bold("Project Status")}  ${dim(ts)}`);
  console.log(dim(`${projectDir}`));
  console.log(dim("─".repeat(60)));

  // Brief (first 3 lines — one-liner summary)
  const brief = tryRead(briefPath);
  if (brief) {
    const headline = brief.split("\n").find(l => l.trim() && !l.startsWith("#")) ?? "";
    if (headline) console.log(`\n${headline.trim()}`);
  }

  // STATUS.md — primary delivery status
  const status = tryRead(statusPath);
  if (status) {
    printSection("Status", status, 50);
  } else {
    console.log(`\n${warn("No STATUS.md")}  ${dim(statusPath)}`);
    console.log(dim("  Create STATUS.md to track phase + blockers."));
  }

  // Deliverables from context pack
  const deliverables = tryRead(delivPath);
  if (deliverables) {
    printSection("Deliverables (context pack)", deliverables, 30);
  } else {
    console.log(`\n${warn("No deliverables.md")}  ${dim(delivPath)}`);
  }

  // Risks from context pack
  const risks = tryRead(risksPath);
  if (risks) {
    printSection("Known Risks (context pack)", risks, 20);
  } else {
    console.log(`\n${warn("No risks.md")}  ${dim(risksPath)}`);
  }

  console.log();
}
