// codexDispatchId.ts — deterministic dedup id for a codex handoff file.
//
// Shared by `wire codex status <file>` (lookup) and, in a future phase,
// `wire codex dispatch <file>` (insert) — both must compute the exact same
// id from the exact same inputs, or dedup silently breaks. Splitting this
// into its own tiny module now, before dispatch exists, avoids the two
// diverging later.
//
// Deterministic by (project, canonical absolute path) — not basename alone.
// Revised 2026-08-11: basename-only dedup collided for any two files sharing
// a generic name from different directories (a real risk — ad-hoc /tmp test
// files, template defaults) and did nothing to defeat symlink aliasing.
// Canonicalizing reuses the same resolve()+realpathSync() pattern already
// established in codexScope.ts — no new path-resolution logic, one more
// caller of it. Content hashing was considered and rejected as the primary
// key: it would incorrectly treat a legitimate unchanged resend (new
// timestamped filename per the handoff naming convention, same body) as a duplicate.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { canonicalizeMaybeMissing } from "./codexScope.js";

export function computeDispatchId(project: string, sourceFile: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizeMaybeMissing(resolve(sourceFile));
  } catch {
    // No existing ancestor directory could be found to canonicalize against
    // (e.g. a path under a filesystem root that doesn't exist at all) — fall
    // back to the resolved-but-uncanonicalized path rather than throwing.
    // This only affects id stability for a pathologically broken path; real
    // handoff files always have an existing parent directory.
    canonicalPath = resolve(sourceFile);
  }
  const key = `${project}:${canonicalPath}`;
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Dedup id for quarantined files — used when a handoff fails to parse badly
 * enough that there's no valid `project` field to key computeDispatchId() on
 * (e.g. missing/malformed frontmatter entirely). Deterministic by canonical
 * path alone, with a fixed sentinel prefix so a quarantine id can never
 * collide with a real computeDispatchId() id even if the canonical path
 * happens to match (different hash input, different digest).
 */
export function computeQuarantineId(sourceFile: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizeMaybeMissing(resolve(sourceFile));
  } catch {
    canonicalPath = resolve(sourceFile);
  }
  const key = `__quarantine__:${canonicalPath}`;
  return createHash("sha256").update(key).digest("hex");
}
