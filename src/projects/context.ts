// context.ts — structured project context reader
//
// Returns agent-friendly JSON summary of a project's canonical state.
// Reads MANIFEST.json (if present) + STATUS.md + context/ files.
// Does NOT concatenate raw markdown — returns structured metadata first,
// letting agents request full files only when needed.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface ProjectManifest {
  schema?: number;
  project_id?: string;
  name?: string;
  status?: string;
  version?: number;
  updated_at?: string;
  context_files?: string[];
}

export interface ProjectContextResult {
  project: string;
  root: string;
  version: number | null;
  git_commit: string | null;
  git_branch: string | null;
  manifest: ProjectManifest | null;
  status_summary: string | null;
  context_files: string[];
  changed_since_last_run: number | null;
}

export function readProjectContext(id: string, projectRoot: string): ProjectContextResult {
  const manifestPath = join(projectRoot, "context", "MANIFEST.json");
  const statusPath = join(projectRoot, "STATUS.md");

  let manifest: ProjectManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ProjectManifest;
    } catch { /* ignore malformed */ }
  }

  // Git info
  const gitCommit = gitOutput(projectRoot, ["rev-parse", "--short", "HEAD"]);
  const gitBranch = gitOutput(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);

  // Status summary — first 8 lines of STATUS.md
  let statusSummary: string | null = null;
  if (existsSync(statusPath)) {
    const lines = readFileSync(statusPath, "utf8").split("\n").slice(0, 8);
    statusSummary = lines.join("\n").trim();
  }

  // Context files available
  const contextDir = join(projectRoot, "context");
  const contextFiles: string[] = [];
  if (existsSync(contextDir)) {
    for (const f of readdirSync(contextDir)) {
      try {
        if (statSync(join(contextDir, f)).isFile()) contextFiles.push(f);
      } catch { /* skip */ }
    }
  }

  // Changed files since last commit (working tree)
  const changedOutput = gitOutput(projectRoot, ["status", "--porcelain"]);
  const changedCount = changedOutput
    ? changedOutput.split("\n").filter(l => l.trim()).length
    : null;

  return {
    project: id,
    root: projectRoot,
    version: manifest?.version ?? null,
    git_commit: gitCommit,
    git_branch: gitBranch,
    manifest,
    status_summary: statusSummary,
    context_files: contextFiles,
    changed_since_last_run: changedCount,
  };
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || r.error) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
