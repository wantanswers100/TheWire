// codexPostRunVerify.ts — git-only post-run verification for write-mode
// Codex dispatch. Classifies what actually happened as clean / scope_violation
// / deletion / remote_changed. All four map to the single "policy_violation"
// DispatchDB status except "clean" — the specific verdict/detail is preserved
// in the result handoff and DB error field for human diagnosis, not lost.
//
// IMPORTANT (Design Revision 2 §5): "remote_changed" detects a change to
// `git remote -v` output ONLY. It does NOT and cannot reliably prove whether
// a push occurred — that claim is deliberately not made anywhere in this
// module. Push prevention rests on sandbox network behavior (verified
// empirically, not assumed — see design doc), the guarded prompt, and never
// passing --full-auto to codex exec. This check is defense-in-depth on top
// of that, not a replacement for it.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export type PostRunVerdict = "clean" | "scope_violation" | "deletion" | "remote_changed";

export interface PostRunVerifyResult {
  verdict: PostRunVerdict;
  changedPaths: string[];
  deletedPaths: string[];
  outOfScopePaths: string[];
  detail: string;
}

function runGit(args: string[], cwd: string): { stdout: string; status: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  // trimEnd only — porcelain status lines carry a semantically significant
  // LEADING space (e.g. " M file" = unstaged modification). A blanket .trim()
  // strips that leading space off the first line, corrupting the parse. This
  // was a real bug caught by testing, not theoretical — see codex-write-dispatch
  // test suite's happy-path failure during implementation.
  return { stdout: (result.stdout ?? "").trimEnd(), status: result.status };
}

interface PorcelainEntry {
  path: string;
  statusCode: string;
}

/**
 * Parse `git status --porcelain --untracked-files=all` output. Handles the
 * XY-status-code + path format, rename arrows ("old -> new"), and git's
 * quoting of paths containing special characters.
 */
function parsePorcelainStatus(porcelain: string): PorcelainEntry[] {
  if (!porcelain) return [];
  return porcelain.split("\n").filter(Boolean).map(line => {
    const statusCode = line.slice(0, 2);
    let pathPart = line.slice(3);
    const renameIdx = pathPart.indexOf(" -> ");
    if (renameIdx !== -1) pathPart = pathPart.slice(renameIdx + 4);
    if (pathPart.startsWith('"') && pathPart.endsWith('"')) pathPart = pathPart.slice(1, -1);
    return { path: pathPart, statusCode };
  });
}

/**
 * Compare current repo state against the pre-run baseline. canonicalAllowedFiles
 * must already be canonicalized (resolveScope's output) — this function does
 * the same resolve() against canonicalProjectPath for each changed path found
 * by git, so both sides compare on equal footing.
 */
export function verifyWriteRun(
  canonicalProjectPath: string,
  canonicalAllowedFiles: string[],
  preRemotes: string,
): PostRunVerifyResult {
  const statusResult = runGit(["status", "--porcelain", "--untracked-files=all"], canonicalProjectPath);
  const entries = parsePorcelainStatus(statusResult.stdout);

  const allowedSet = new Set(canonicalAllowedFiles);
  const changedPaths: string[] = [];
  const deletedPaths: string[] = [];
  const outOfScopePaths: string[] = [];

  for (const entry of entries) {
    const abs = resolve(canonicalProjectPath, entry.path);
    changedPaths.push(abs);
    // Porcelain v1: 'D' in either the index (X) or worktree (Y) column means deleted.
    if (entry.statusCode.includes("D")) {
      deletedPaths.push(abs);
    }
    if (!allowedSet.has(abs)) {
      outOfScopePaths.push(abs);
    }
  }

  const postRemotes = runGit(["remote", "-v"], canonicalProjectPath).stdout;
  const remoteChanged = postRemotes !== preRemotes;

  if (deletedPaths.length > 0) {
    return {
      verdict: "deletion",
      changedPaths, deletedPaths, outOfScopePaths,
      detail: `Deletion detected (never acceptable, even within allowed_files): ${deletedPaths.join(", ")}`,
    };
  }

  if (outOfScopePaths.length > 0) {
    return {
      verdict: "scope_violation",
      changedPaths, deletedPaths, outOfScopePaths,
      detail: `Changes outside allowed_files: ${outOfScopePaths.join(", ")}`,
    };
  }

  if (remoteChanged) {
    return {
      verdict: "remote_changed",
      changedPaths, deletedPaths, outOfScopePaths,
      detail: `git remote -v output changed during this run (remote configuration modified). This does NOT prove a push occurred — treat as a hard stop and investigate manually. Before: "${preRemotes}" / After: "${postRemotes}"`,
    };
  }

  return {
    verdict: "clean",
    changedPaths, deletedPaths, outOfScopePaths,
    detail: changedPaths.length > 0
      ? `Changes within allowed_files only: ${changedPaths.join(", ")}`
      : "No changes detected.",
  };
}
