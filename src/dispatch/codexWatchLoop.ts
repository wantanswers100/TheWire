// codexWatchLoop.ts — the testable scan/classify/park core of `wire codex watch`.
//
// v1 (Design Revision 2): classifier/recorder ONLY. This file does not import
// runCodex() or runCodexWrite() — structurally incapable of dispatching
// anything, the same "absence, not a check" pattern used throughout this
// build for other hard boundaries. Every valid codex-targeted handoff (read-
// only or write-mode alike) is parked as "awaiting_hitl" for a human to pick
// up via the existing, unmodified `wire codex dispatch <file>` command.
// Auto-dispatch (--auto-read) is deliberately deferred to a future,
// separately-approved phase — no flag for it exists anywhere in this file.
//
// Never touches the scanned files themselves — no move, no delete, no edit.
// Only ever writes DispatchDB rows.

import { readdirSync, statSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseHandoffFile, splitFrontmatter } from "./codexHandoff.js";
import { computeDispatchId, computeQuarantineId } from "./codexDispatchId.js";
import { DispatchDB } from "./db.js";
import type { DispatchRecord } from "./db.js";
// ISS-031: sourced from config/paths.ts.
import { INBOX_DIR } from "../config/paths.js";

export function defaultInboxDir(): string {
  return INBOX_DIR;
}

export interface WatchCycleResult {
  scanned: number;
  ignored: number;      // not codex-targeted at all (or unparseable AND doesn't look codex-intended)
  skipped: number;       // already had a DispatchDB row from a prior cycle
  quarantined: number;   // newly quarantined this cycle
  parked: number;        // newly inserted as awaiting_hitl this cycle
  lines: string[];       // human-readable log lines for this cycle
}

function listCandidateFiles(inboxDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(inboxDir);
  } catch {
    return [];
  }
  return entries
    .filter(name => !name.endsWith(":Zone.Identifier")) // Windows zone-id junk, same exclusion as inbox-cmd.ts
    .map(name => join(inboxDir, name))
    .filter(full => {
      try { return statSync(full).isFile(); } catch { return false; }
    });
}

/**
 * Lightweight heuristic for whether an unparseable file was at least intended
 * for codex — checked via a raw frontmatter substring match, not full
 * parsing (parsing already failed, that's why we're here). Prevents watch
 * from quarantining every unrelated file that happens to sit in inbox/ (a
 * Gemini handoff, a random dropped document) just because it isn't a valid
 * codex handoff — those are correctly "ignored", not "quarantined".
 */
function looksIntendedForCodex(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, "utf8");
    const split = splitFrontmatter(content);
    if (!split) return false;
    return /^target:\s*codex\s*$/mi.test(split.frontmatter) || /^to:\s*codex\s*$/mi.test(split.frontmatter);
  } catch {
    return false;
  }
}

/**
 * Run one scan-and-classify cycle. No timers, no loop — a single bounded
 * pass over whatever is in inboxDir right now. The caller (CLI `watch start`)
 * wraps this in a setInterval; kept out of this function so it stays testable
 * without fighting real timers.
 */
export function runWatchCycle(stateDir: string, inboxDir: string = defaultInboxDir()): WatchCycleResult {
  const db = new DispatchDB(stateDir);
  const files = listCandidateFiles(inboxDir);

  const result: WatchCycleResult = { scanned: files.length, ignored: 0, skipped: 0, quarantined: 0, parked: 0, lines: [] };

  for (const filePath of files) {
    const parsed = parseHandoffFile(filePath);

    if (!parsed.ok) {
      if (!looksIntendedForCodex(filePath)) {
        result.ignored++;
        continue;
      }
      const qid = computeQuarantineId(filePath);
      if (db.get(qid)) {
        result.skipped++;
        continue;
      }
      const errorSummary = parsed.errors.map(e => `[${e.field}] ${e.message}`).join("; ");
      db.insert({
        id: qid,
        from: "unknown",
        skill: "quarantine",
        routed_to: "codex",
        status: "quarantined",
        created_at: Date.now(),
        source_file: basename(filePath),
        error: errorSummary,
      });
      result.quarantined++;
      result.lines.push(`[quarantine] ${filePath} — ${errorSummary}`);
      continue;
    }

    const { request } = parsed;
    if (request.target !== "codex" || request.to !== "codex") {
      result.ignored++;
      continue;
    }

    const dispatchId = computeDispatchId(request.project, filePath);
    if (db.get(dispatchId)) {
      result.skipped++;
      continue;
    }

    // Valid, codex-targeted, never seen before. Read-only and write-mode are
    // parked identically here — v1 never auto-dispatches either, so there is
    // no execution branch to choose between. `skill` carries request.task_type
    // (THINK/RESEARCH/EXECUTE), which is what `status`'s grouping reads later
    // to distinguish "ready read-only" from "write-mode awaiting" without
    // needing a second DispatchStatus value.
    db.insert({
      id: dispatchId,
      from: request.from,
      skill: request.task_type,
      routed_to: "codex",
      status: "awaiting_hitl",
      created_at: Date.now(),
      project: request.project,
      source_file: basename(filePath),
    });
    result.parked++;
    result.lines.push(`[parked] ${filePath} — task_type=${request.task_type} action_type=${request.action_type}`);
  }

  return result;
}

export interface WatchStatusGroups {
  readyReadOnly: DispatchRecord[];
  writeAwaiting: DispatchRecord[];
  quarantined: DispatchRecord[];
  recentCompleted: DispatchRecord[];
}

const READ_ONLY_SKILLS = new Set(["THINK", "RESEARCH"]);

/**
 * Groups codex-routed DispatchDB rows for `wire codex watch status`'s four
 * sections. Pure query + filter — no writes, reuses the existing
 * listRecentByRoutedTo() rather than adding new SQL.
 */
export function getWatchStatusGroups(stateDir: string, limit = 50): WatchStatusGroups {
  const db = new DispatchDB(stateDir);
  const rows = db.listRecentByRoutedTo("codex", limit);

  return {
    readyReadOnly: rows.filter(r => r.status === "awaiting_hitl" && READ_ONLY_SKILLS.has(r.skill)),
    writeAwaiting: rows.filter(r => r.status === "awaiting_hitl" && r.skill === "EXECUTE"),
    quarantined: rows.filter(r => r.status === "quarantined"),
    recentCompleted: rows.filter(r => r.status === "done" || r.status === "failed" || r.status === "policy_violation"),
  };
}
