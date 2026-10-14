// codexPruneStale.ts — safe cleanup for stale DispatchDB rows.
//
// Originally codex-only; generalized (2026-08-12) so `wire agent prune-stale`
// can sweep claude/gemini/ollama's own awaiting_hitl/quarantined backlog too —
// the underlying DispatchDB.listAllByRoutedTo() was never codex-specific, only
// this module's one hardcoded call site was. `agent` defaults to "codex" so
// the existing `wire codex prune-stale` caller (codex-cmd.ts) is unaffected.
//
// A row is "stale" when its source_file no longer exists in ~/projects/inbox/.
// Only two statuses are ever eligible: awaiting_hitl, quarantined — hardcoded,
// not configurable. done/failed/policy_violation/running/pending/routing/
// anything else is NEVER touched, even if its source_file is also missing
// (a real, current example: the two "done" rows from the 2026-08-11 write-mode
// validation both had their original /tmp handoff files deleted afterward —
// they must never be pruned, which is exactly why eligibility is a hardcoded
// status allowlist, not "any row with a missing file").
//
// Dry-run by default. Only DispatchDB.deleteById() is ever called, and only
// when apply=true. No file is ever deleted, moved, or edited by this module.

import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { DispatchDB } from "./db.js";
import type { DispatchRecord, DispatchStatus } from "./db.js";
// ISS-031: sourced from config/paths.ts. Function form preserved (public
// API other callers depend on) but the value now comes from the single
// shared definition.
import { INBOX_DIR } from "../config/paths.js";

const ELIGIBLE_STATUSES: DispatchStatus[] = ["awaiting_hitl", "quarantined"];

export function defaultInboxDir(): string {
  return INBOX_DIR;
}

export interface PruneCandidate {
  id: string;
  status: DispatchStatus;
  skill: string;
  project?: string;
  source_file?: string;
  created_at: number;
}

export interface PruneStaleResult {
  scanned: number;                  // total codex rows examined (unlimited scan — see db.listAllByRoutedTo)
  eligible: PruneCandidate[];       // stale awaiting_hitl/quarantined rows with a safe, missing source_file
  unsafeSkipped: PruneCandidate[];  // eligible-status rows whose source_file failed the safety check — never deleted
  noSourceSkipped: number;          // eligible-status rows with no source_file at all — can't verify staleness, skipped
  deleted: PruneCandidate[];        // populated only when apply=true — mirrors eligible, post-deletion
  applied: boolean;
}

function toCandidate(r: DispatchRecord): PruneCandidate {
  const c: PruneCandidate = { id: r.id, status: r.status, skill: r.skill, created_at: r.created_at };
  if (r.project !== undefined) c.project = r.project;
  if (r.source_file !== undefined) c.source_file = r.source_file;
  return c;
}

/**
 * A source_file value is only ever treated as `<inboxDir>/<source_file>` —
 * never reasoned about as a path outside inbox. Anything that looks like it
 * could point elsewhere (absolute path, any path separator, "..") is
 * rejected outright rather than resolved. This is a stricter check than
 * "does the resolved path stay inside inboxDir" — it never even attempts
 * resolution for a value that isn't already a bare filename.
 */
function isSafeBasename(sourceFile: string): boolean {
  if (isAbsolute(sourceFile)) return false;
  if (sourceFile.includes("/") || sourceFile.includes("\\")) return false;
  if (sourceFile.includes("..")) return false;
  return true;
}

/**
 * Scan all `agent`-routed DispatchDB rows (unlimited — see
 * DispatchDB.listAllByRoutedTo, never a capped query) and classify each
 * eligible-status row as prunable, unsafe, or unverifiable. When apply=true,
 * actually deletes the prunable rows via DispatchDB.deleteById() — the only
 * mutating call this module ever makes. `agent` defaults to "codex" for
 * backward compatibility with the original `wire codex prune-stale` caller.
 */
export function pruneStaleCore(stateDir: string, apply: boolean, inboxDir: string = defaultInboxDir(), agent: string = "codex"): PruneStaleResult {
  const db = new DispatchDB(stateDir);
  const rows = db.listAllByRoutedTo(agent);

  const eligible: PruneCandidate[] = [];
  const unsafeSkipped: PruneCandidate[] = [];
  let noSourceSkipped = 0;

  for (const r of rows) {
    // Hard rule: only these two statuses are ever considered, regardless of
    // file state. done/failed/policy_violation/running/pending/routing/
    // anything else is skipped before source_file is even inspected.
    if (!ELIGIBLE_STATUSES.includes(r.status)) continue;

    if (!r.source_file || r.source_file.trim().length === 0) {
      noSourceSkipped++;
      continue;
    }

    if (!isSafeBasename(r.source_file)) {
      unsafeSkipped.push(toCandidate(r));
      continue;
    }

    const resolvedPath = join(inboxDir, r.source_file);
    if (existsSync(resolvedPath)) continue; // file still present — not stale

    eligible.push(toCandidate(r));
  }

  const deleted: PruneCandidate[] = [];
  if (apply) {
    for (const c of eligible) {
      db.deleteById(c.id);
      deleted.push(c);
    }
  }

  return { scanned: rows.length, eligible, unsafeSkipped, noSourceSkipped, deleted, applied: apply };
}
