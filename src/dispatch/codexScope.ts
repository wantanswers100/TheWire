// codexScope.ts — canonicalize and validate the filesystem scope of a Codex
// handoff request (project_path + allowed_files) before anything is dispatched.
//
// Reuses the two-stage resolve() + realpathSync() path-traversal guard already
// established in src/proactive/monitor.ts and src/agents/rag.ts — same defense
// against symlink escape, applied here to project_path/allowed_files instead of
// STATUS.md/.keys/.
//
// Phase 1-3 scope: normal-mode resolution only (paths must live under
// ~/projects/active/<project>/). Post-run diff verification (comparing what
// Codex actually touched against allowed_files) and the scratch-test mode are
// deliberately not implemented here — see the v2 design spec.

import { resolve, dirname, basename, join, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { CodexHandoffRequest } from "./codexHandoff.js";

export interface ScopeError {
  field: string;
  message: string;
}

export interface ResolvedScope {
  canonicalProjectPath: string;
  canonicalAllowedFiles: string[];
}

export type ScopeResult =
  | { ok: true; scope: ResolvedScope }
  | { ok: false; errors: ScopeError[] };

export interface ResolveScopeOptions {
  /**
   * Test seam only. For resolveScope(), overrides ~/projects/active. For
   * resolveScratchScope(), overrides ~/projects/scratch. Same field name,
   * meaning depends on which function receives it — kept as one field rather
   * than two to avoid churning every existing test call site for a naming
   * nicety.
   */
  activeRootOverride?: string;
}

function defaultActiveRoot(): string {
  return resolve(join(process.env["HOME"] ?? homedir(), "projects", "active"));
}

function defaultScratchRoot(): string {
  return resolve(join(process.env["HOME"] ?? homedir(), "projects", "scratch"));
}

/**
 * Canonicalize a path that may not exist yet (needed for allowed_files that
 * name a file Codex would create). Walks up to the nearest existing ancestor,
 * realpath()s that ancestor to defeat symlink escape, then rejoins the
 * non-existent tail. Mirrors the existing resolve()+realpathSync() pattern
 * used elsewhere for paths that ARE expected to exist, extended for the
 * write-target case.
 */
export function canonicalizeMaybeMissing(absPath: string): string {
  if (existsSync(absPath)) {
    return realpathSync(absPath);
  }

  let dir = dirname(absPath);
  const tail: string[] = [basename(absPath)];
  // Walk up until we find an existing ancestor or hit the filesystem root.
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) {
      // Reached root without finding an existing ancestor — cannot canonicalize.
      throw new Error(`no existing ancestor directory found for path: ${absPath}`);
    }
    tail.unshift(basename(dir));
    dir = parent;
  }

  const realDir = realpathSync(dir);
  return join(realDir, ...tail);
}

function isInside(candidate: string, boundary: string): boolean {
  return candidate === boundary || candidate.startsWith(boundary + sep);
}

/**
 * Shared core: resolve and validate the filesystem scope of a handoff request
 * against a given root directory —
 *  - project_path must canonicalize to inside <root>/<project>/ where
 *    <project> is exactly the request's own `project` field (prevents a
 *    request claiming project: X while pointing at a different project's
 *    directory).
 *  - every allowed_files entry must canonicalize to inside the canonicalized
 *    project_path — symlink escape and `../` traversal are both defeated by
 *    the realpathSync() step, not by string matching on the raw path.
 *
 * rootLabel is used only in error messages (e.g. "normal mode" vs "scratch
 * mode") so refusals are legible about which mode rejected the request.
 */
function resolveScopeAgainstRoot(request: CodexHandoffRequest, root: string, rootLabel: string): ScopeResult {
  const errors: ScopeError[] = [];

  // ── project_path ──────────────────────────────────────────────────────
  const normalizedProjectPath = resolve(request.project_path);
  if (!existsSync(normalizedProjectPath)) {
    return { ok: false, errors: [{ field: "project_path", message: `path does not exist: ${normalizedProjectPath}` }] };
  }

  let canonicalProjectPath: string;
  try {
    canonicalProjectPath = realpathSync(normalizedProjectPath);
  } catch (e) {
    return { ok: false, errors: [{ field: "project_path", message: `cannot resolve path: ${e instanceof Error ? e.message : String(e)}` }] };
  }

  const expectedProjectDir = join(root, request.project);
  let canonicalExpectedProjectDir: string;
  try {
    canonicalExpectedProjectDir = existsSync(expectedProjectDir) ? realpathSync(expectedProjectDir) : resolve(expectedProjectDir);
  } catch {
    canonicalExpectedProjectDir = resolve(expectedProjectDir);
  }

  if (!isInside(canonicalProjectPath, resolve(root))) {
    errors.push({
      field: "project_path",
      message: `must resolve inside ${root} (${rootLabel}) — got ${canonicalProjectPath}.`,
    });
  } else if (canonicalProjectPath !== canonicalExpectedProjectDir) {
    errors.push({
      field: "project_path",
      message: `resolves to ${canonicalProjectPath}, which does not match the declared project "${request.project}" (expected ${canonicalExpectedProjectDir})`,
    });
  }

  // ── allowed_files ─────────────────────────────────────────────────────
  const canonicalAllowedFiles: string[] = [];
  // Only enforce the allowed_files boundary check if project_path itself
  // resolved cleanly — otherwise every file error would just be noise on
  // top of the real problem.
  if (errors.length === 0) {
    for (const rel of request.allowed_files) {
      const absCandidate = resolve(canonicalProjectPath, rel);
      let canonical: string;
      try {
        canonical = canonicalizeMaybeMissing(absCandidate);
      } catch (e) {
        errors.push({ field: "allowed_files", message: `"${rel}": ${e instanceof Error ? e.message : String(e)}` });
        continue;
      }
      if (!isInside(canonical, canonicalProjectPath)) {
        errors.push({ field: "allowed_files", message: `"${rel}" resolves outside project_path (${canonical}) — rejected` });
        continue;
      }
      canonicalAllowedFiles.push(canonical);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    scope: { canonicalProjectPath, canonicalAllowedFiles },
  };
}

/**
 * Normal mode: project_path must resolve inside ~/projects/active/<project>/.
 * Explicitly rejects anything inside ~/projects/scratch/ — that's what
 * resolveScratchScope() is for, and only reachable via the CLI's explicit
 * --test-scratch flag, never this function.
 */
export function resolveScope(request: CodexHandoffRequest, opts: ResolveScopeOptions = {}): ScopeResult {
  const activeRoot = opts.activeRootOverride ?? defaultActiveRoot();
  return resolveScopeAgainstRoot(request, activeRoot, "normal mode — active/ only");
}

/**
 * Scratch mode: project_path must resolve inside ~/projects/scratch/<project>/.
 * Explicitly rejects anything inside ~/projects/active/. Only ever called from
 * codex-cmd.ts's dispatchWriteScratchCore(), which is itself only reachable
 * via the explicit `wire codex dispatch --test-scratch <file>` CLI flag —
 * never from a handoff file's own content, and never from watch mode (which
 * doesn't exist yet, and must not gain an equivalent flag when it's built).
 */
export function resolveScratchScope(request: CodexHandoffRequest, opts: ResolveScopeOptions = {}): ScopeResult {
  const scratchRoot = opts.activeRootOverride ?? defaultScratchRoot();
  return resolveScopeAgainstRoot(request, scratchRoot, "scratch mode — scratch/ only");
}
