// codexPreflight.ts — git-only preflight checks for write-mode Codex dispatch.
//
// v1 scope: git-backed active projects only. No non-git fallback exists in
// this build — a non-git project, or a project_path that is a subdirectory
// of a larger repo, structurally cannot pass this preflight. See Write-Mode
// Design Revision 2.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { CodexHandoffRequest } from "./codexHandoff.js";

export interface PreflightError {
  field: string;
  message: string;
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; errors: PreflightError[] };

export interface WritePreflightSuccess {
  ok: true;
  preRemotes: string;
}
export type WritePreflightResult = WritePreflightSuccess | { ok: false; errors: PreflightError[] };

function runGit(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    // trimEnd only, not trim — porcelain status lines carry a semantically
    // significant LEADING space (e.g. " M file"); see codexPostRunVerify.ts's
    // matching comment for the real bug this avoids. checkGitRepoRoot's
    // rev-parse/remote output isn't leading-whitespace-sensitive either way.
    stdout: (result.stdout ?? "").trimEnd(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status,
  };
}

/**
 * action_type write|modify requires task_type EXECUTE. A THINK/RESEARCH
 * request carrying write access is a scope-abuse smell — refused regardless
 * of what else is true about the request.
 */
export function checkTaskActionCoupling(request: CodexHandoffRequest): PreflightResult {
  const isWrite = request.action_type === "write" || request.action_type === "modify";
  if (isWrite && request.task_type.trim().toUpperCase() !== "EXECUTE") {
    return {
      ok: false,
      errors: [{ field: "task_type", message: `action_type "${request.action_type}" requires task_type EXECUTE — got "${request.task_type}"` }],
    };
  }
  return { ok: true };
}

export function checkNonEmptyAllowedFiles(request: CodexHandoffRequest): PreflightResult {
  if (request.allowed_files.length === 0) {
    return { ok: false, errors: [{ field: "allowed_files", message: "write-mode dispatch requires a non-empty allowed_files list" }] };
  }
  return { ok: true };
}

/**
 * Confirm canonicalProjectPath IS a git repo root — not merely "a .git dir
 * exists somewhere at or above this path" (existsSync(.git) can't distinguish
 * a project directory from a subdirectory of a larger repo). Uses
 * `git rev-parse --show-toplevel` and requires exact equality after
 * canonicalizing both sides the same way.
 */
export function checkGitRepoRoot(canonicalProjectPath: string): PreflightResult {
  const result = runGit(["rev-parse", "--show-toplevel"], canonicalProjectPath);
  if (result.status !== 0 || !result.stdout) {
    return {
      ok: false,
      errors: [{ field: "git", message: `not a git repository — write-mode dispatch is git-only in this build (git rev-parse --show-toplevel: ${result.stderr || "failed"})` }],
    };
  }

  let canonicalToplevel: string;
  try {
    canonicalToplevel = realpathSync(result.stdout);
  } catch (e) {
    return { ok: false, errors: [{ field: "git", message: `could not resolve git repo toplevel: ${e instanceof Error ? e.message : String(e)}` }] };
  }

  if (canonicalToplevel !== canonicalProjectPath) {
    return {
      ok: false,
      errors: [{
        field: "git",
        message: `project_path is a subdirectory of a larger git repo (repo root: ${canonicalToplevel}) — refused for v1. project_path must equal the repo root exactly.`,
      }],
    };
  }

  return { ok: true };
}

/**
 * Refuse a dirty working tree, no override. --untracked-files=all so a new
 * untracked directory's contents are enumerated, not collapsed to one line
 * (git's default porcelain output collapses untracked directories, which
 * would hide files inside a new directory from this check).
 */
export function checkCleanTree(canonicalProjectPath: string): PreflightResult {
  const result = runGit(["status", "--porcelain", "--untracked-files=all"], canonicalProjectPath);
  if (result.status !== 0) {
    return { ok: false, errors: [{ field: "git", message: `git status failed: ${result.stderr || "unknown error"}` }] };
  }
  if (result.stdout.length > 0) {
    return {
      ok: false,
      errors: [{ field: "git", message: `working tree is not clean — refusing (no override). git status --porcelain output:\n${result.stdout}` }],
    };
  }
  return { ok: true };
}

/**
 * `git remote -v` output, captured pre-run for later comparison. This is
 * NOT a push-detection mechanism — it only detects a change to remote
 * *configuration* (a new/removed/retargeted remote). Actual push prevention
 * rests on sandbox network behavior (verified empirically — see Design
 * Revision 2 §5), the guarded prompt, and never passing --full-auto. See
 * codexPostRunVerify.ts for the comparison side of this.
 */
export function captureGitRemotes(canonicalProjectPath: string): string {
  return runGit(["remote", "-v"], canonicalProjectPath).stdout;
}

/**
 * Runs every write-mode-specific preflight check in order, first failure
 * wins. Does NOT duplicate active-session or scope-resolution checks —
 * those are existing, reused, unchanged (checkActiveSessionClear,
 * resolveScope) and are called at the dispatchCore call site, not here.
 */
export function runWritePreflight(request: CodexHandoffRequest, canonicalProjectPath: string): WritePreflightResult {
  const coupling = checkTaskActionCoupling(request);
  if (!coupling.ok) return coupling;

  const nonEmpty = checkNonEmptyAllowedFiles(request);
  if (!nonEmpty.ok) return nonEmpty;

  const repoRoot = checkGitRepoRoot(canonicalProjectPath);
  if (!repoRoot.ok) return repoRoot;

  const clean = checkCleanTree(canonicalProjectPath);
  if (!clean.ok) return clean;

  const preRemotes = captureGitRemotes(canonicalProjectPath);
  return { ok: true, preRemotes };
}
