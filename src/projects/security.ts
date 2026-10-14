// security.ts — path validation for project_write
//
// Writes are restricted to a fixed allowlist of top-level subdirectories.
// Canonical path resolution prevents traversal escapes.
//
// profile/, snapshots/, questions/ added 2026-09-29 (owner explicit) so a
// project's agent crew can read/write its own profile documents —
// this list is global across every Wire-served project, not project-scoped,
// so any other project with a top-level dir matching one of these names also
// gains write access. Accepted tradeoff per AUD-C2's guard mechanism (the
// canonical-path validation itself, not the specific dir list) — see
// ~/.claude/rules/agent-wire-security.md and DEVLOG.md 2026-09-29.

import { resolve, dirname } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

const ALLOWED_WRITE_DIRS = ["context", "outputs", "profile", "snapshots", "questions"];

// Stage 2: the lexical check above can't see symlinks. Resolve the deepest
// existing ancestor of the target with realpath and require it to sit inside
// the canonical project root; refuse an existing target that is itself a link.
function assertNoSymlinkEscape(root: string, target: string): void {
  const realRoot = realpathSync(root);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`project_write: refusing to write through a symlink (${target})`);
  }
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  const realProbe = realpathSync(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + "/")) {
    throw new Error(`project_write: path escapes project root via symlink (resolved: ${realProbe})`);
  }
  const topDir = realProbe.slice(realRoot.length + 1).split("/")[0] ?? "";
  if (realProbe !== realRoot && !ALLOWED_WRITE_DIRS.includes(topDir)) {
    throw new Error(`project_write: path escapes allowed dirs via symlink (resolved: ${realProbe})`);
  }
}

export function validateWritePath(projectRoot: string, relativePath: string): string {
  if (!relativePath || relativePath.trim() === "") {
    throw new Error("project_write: path is required");
  }

  // Canonicalize both root and target
  const root = resolve(projectRoot);
  const target = resolve(root, relativePath);

  // Must stay inside project root
  if (!target.startsWith(root + "/") && target !== root) {
    throw new Error(
      `project_write: path escapes project root (resolved: ${target})`
    );
  }

  // Must be inside an allowed write directory
  const rel = target.slice(root.length + 1);
  const topDir = rel.split("/")[0] ?? "";
  if (!ALLOWED_WRITE_DIRS.includes(topDir)) {
    throw new Error(
      `project_write: writes only allowed in ${ALLOWED_WRITE_DIRS.join(", ")} (got top dir: '${topDir}')`
    );
  }

  assertNoSymlinkEscape(root, target);
  return target;
}
