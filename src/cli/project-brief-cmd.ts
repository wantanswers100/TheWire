// wire project-brief — display a project's context pack
//
// Usage:
//   wire project-brief <project-name>
//
// Reads ~/projects/active/<project-name>/context/ and prints each file.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PACK_FILES = ["brief.md", "architecture.md", "surfaces.md", "risks.md", "deliverables.md"];

export function runProjectBrief(args: string[]): void {
  const projectName = args.find(a => !a.startsWith("--"));

  if (!projectName) {
    console.error("Usage: wire project-brief <project-name>");
    process.exit(1);
  }

  const contextDir = join(homedir(), "projects", "active", projectName, "context");

  if (!existsSync(contextDir)) {
    console.error(`[wire] No context pack found for: ${projectName}`);
    console.error(`  Expected: ${contextDir}`);
    console.error(`  Run context pack generation or create it manually.`);
    process.exit(1);
  }

  console.log(`\n=== Project Brief: ${projectName} ===\n`);

  let found = 0;
  for (const file of PACK_FILES) {
    const filePath = join(contextDir, file);
    if (!existsSync(filePath)) continue;
    found++;
    const divider = "─".repeat(60);
    console.log(`${divider}\n### ${file}\n${divider}`);
    console.log(readFileSync(filePath, "utf8").trim());
    console.log();
  }

  if (found === 0) {
    console.error(`[wire] Context directory exists but contains no pack files: ${contextDir}`);
    process.exit(1);
  }
}
