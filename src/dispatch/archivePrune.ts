// archivePrune.ts — age-based cleanup for inbox/.processed/.
//
// ISS-033 stopped inbox files from accumulating forever at the *watch point*
// (loop.ts's readdirSync scanInbox()) by moving fully-handled files into
// inboxDir/.processed/ instead of deleting them. That relocated the same
// unbounded-growth problem one directory downstream rather than solving it —
// nothing ever pruned .processed/ itself. This module closes that gap.
//
// Safety model (deliberately narrower than codexPruneStale.ts's DB-row
// pruning, because this deletes real files, not DB rows):
//   - Scoped to exactly `<inboxDir>/.processed/` — never reads or deletes
//     anything outside that one directory, and never recurses into
//     subdirectories of it (skips anything that isn't a regular file).
//   - Age-based only, via file mtime — never content-based, never tied to
//     dispatch.db state. A file in .processed/ is by construction something
//     loop.ts already fully handled (claimed + dispatched, or permanently
//     invalid); its DB row (if any) is untouched by this module.
//   - Dry-run by default. Only unlinkSync() is ever called, and only when
//     apply=true.

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface ArchivePruneCandidate {
  filename: string;
  ageDays: number;
  mtimeMs: number;
}

export interface ArchivePruneResult {
  scanned: number;
  eligible: ArchivePruneCandidate[];
  deleted: ArchivePruneCandidate[];
  applied: boolean;
  olderThanDays: number;
  processedDir: string;
}

const DEFAULT_OLDER_THAN_DAYS = 30;

/**
 * Scan `<inboxDir>/.processed/` and classify each regular file as prunable
 * (mtime older than `olderThanDays`) or not. When apply=true, deletes the
 * prunable files — the only mutating call this module ever makes.
 */
export function pruneProcessedArchiveCore(
  inboxDir: string,
  apply: boolean,
  olderThanDays: number = DEFAULT_OLDER_THAN_DAYS,
): ArchivePruneResult {
  const processedDir = join(inboxDir, ".processed");

  if (!existsSync(processedDir)) {
    return { scanned: 0, eligible: [], deleted: [], applied: apply, olderThanDays, processedDir };
  }

  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const entries = readdirSync(processedDir, { withFileTypes: true });

  const eligible: ArchivePruneCandidate[] = [];
  let scanned = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue; // never recurse, never touch non-regular-file entries
    scanned++;

    const fullPath = join(processedDir, entry.name);
    const stat = statSync(fullPath);
    if (stat.mtimeMs >= cutoffMs) continue; // not old enough yet

    eligible.push({
      filename: entry.name,
      ageDays: (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000),
      mtimeMs: stat.mtimeMs,
    });
  }

  const deleted: ArchivePruneCandidate[] = [];
  if (apply) {
    for (const c of eligible) {
      unlinkSync(join(processedDir, c.filename));
      deleted.push(c);
    }
  }

  return { scanned, eligible, deleted, applied: apply, olderThanDays, processedDir };
}
