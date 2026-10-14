import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// Dispatch state — tracks every message the loop processes.
// Stored in .wire-state/dispatch.db (SQLite via bun:sqlite, no external deps).

export type DispatchStatus = "pending" | "routing" | "running" | "done" | "failed" | "awaiting_hitl" | "awaiting_review" | "rejected" | "quarantined" | "policy_violation";

export interface DispatchRecord {
  id: string;           // message id (UUIDv4), or a deterministic dedup hash for non-message dispatches (e.g. codex handoffs)
  from: string;
  skill: string;
  routed_to: string;
  status: DispatchStatus;
  created_at: number;
  updated_at: number;
  result_id?: string | null;   // id of the result message sent back
  error?: string | null;
  project?: string;      // optional — populated by callers that track project-scoped work (e.g. codex handoffs)
  source_file?: string;  // optional — populated by callers that track a source file (e.g. codex handoffs)
}

export class DispatchDB {
  private db: Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "dispatch.db"));
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dispatch (
        id          TEXT PRIMARY KEY,
        from_agent  TEXT NOT NULL,
        skill       TEXT NOT NULL,
        routed_to   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        result_id   TEXT,
        error       TEXT
      )
    `);
    this.migrateAddOptionalColumns();
  }

  // Additive, idempotent migration — safe to run on every construction.
  // Existing rows get NULL for the new columns; nothing reads them until a
  // caller opts in by passing project/source_file to insert().
  private migrateAddOptionalColumns(): void {
    const columns = (this.db.query("PRAGMA table_info(dispatch)").all() as { name: string }[]).map(c => c.name);
    if (!columns.includes("project")) {
      this.db.run("ALTER TABLE dispatch ADD COLUMN project TEXT");
    }
    if (!columns.includes("source_file")) {
      this.db.run("ALTER TABLE dispatch ADD COLUMN source_file TEXT");
    }
  }

  // Returns true if this call actually inserted the row (won the race),
  // false if a row with this id already existed (INSERT OR IGNORE no-op).
  // ISS-032: callers that need an atomic claim — e.g. loop.ts's
  // processFile(), guarding against duplicate/concurrent inotify events for
  // the same message — must check this return value before proceeding.
  // Ignoring it (as every caller did before ISS-032) silently drops back to
  // the old race-prone behavior.
  insert(record: Omit<DispatchRecord, "updated_at">): boolean {
    // error/result_id are accepted here (not just via update()) because
    // watch's quarantine path needs to record a reason at insert time, not
    // in a follow-up call — no prior caller needed this until quarantine.
    const result = this.db.run(
      `INSERT OR IGNORE INTO dispatch (id, from_agent, skill, routed_to, status, created_at, updated_at, project, source_file, error, result_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id, record.from, record.skill, record.routed_to, record.status,
        record.created_at, record.created_at,
        record.project ?? null, record.source_file ?? null,
        record.error ?? null, record.result_id ?? null,
      ]
    ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  update(id: string, patch: Partial<Pick<DispatchRecord, "status" | "result_id" | "error" | "routed_to">>): void {
    const sets: string[] = ["updated_at = ?"];
    const vals: (string | number | boolean | null)[] = [Date.now()];
    if (patch.status !== undefined) { sets.push("status = ?"); vals.push(patch.status); }
    if (patch.result_id !== undefined) { sets.push("result_id = ?"); vals.push(patch.result_id); }
    if (patch.error !== undefined) { sets.push("error = ?"); vals.push(patch.error); }
    if (patch.routed_to !== undefined) { sets.push("routed_to = ?"); vals.push(patch.routed_to); }
    vals.push(id);
    this.db.run(`UPDATE dispatch SET ${sets.join(", ")} WHERE id = ?`, vals);
  }

  claimAwaiting(id: string): boolean {
    const result = this.db.run(
      "UPDATE dispatch SET status = 'running', updated_at = ? WHERE id = ? AND status = 'awaiting_hitl'",
      [Date.now(), id],
    ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  get(id: string): DispatchRecord | null {
    const row = this.db.query("SELECT * FROM dispatch WHERE id = ?").get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return rowToRecord(row);
  }

  // Most recent rows for a given routed_to value (e.g. "codex"), newest first.
  listRecentByRoutedTo(routedTo: string, limit = 20): DispatchRecord[] {
    return (this.db.query(
      "SELECT * FROM dispatch WHERE routed_to = ? ORDER BY created_at DESC LIMIT ?"
    ).all(routedTo, limit) as Record<string, unknown>[]).map(rowToRecord);
  }

  // ALL rows for a given routed_to value, no LIMIT — used by prune-stale so
  // an old row never silently falls outside a capped scan. Read-only.
  listAllByRoutedTo(routedTo: string): DispatchRecord[] {
    return (this.db.query(
      "SELECT * FROM dispatch WHERE routed_to = ? ORDER BY created_at DESC"
    ).all(routedTo) as Record<string, unknown>[]).map(rowToRecord);
  }

  // Delete-by-id only — no dynamic WHERE clause. All eligibility logic for
  // what should be deleted lives in application code (codexPruneStale.ts),
  // not here. This is the only delete capability DispatchDB has.
  deleteById(id: string): void {
    this.db.run("DELETE FROM dispatch WHERE id = ?", [id]);
  }

  isProcessed(id: string): boolean {
    const row = this.db.query("SELECT status FROM dispatch WHERE id = ?").get(id) as { status: string } | null;
    return row !== null && row.status !== "pending";
  }

  // Returns message IDs of pending key_rotation records for the given agent.
  // Used to detect concurrent rotation races where multiple attested rotations
  // arrive before the operator has committed any of them.
  pendingKeyRotationsFor(fromAgent: string): string[] {
    const rows = this.db.query(
      "SELECT id FROM dispatch WHERE from_agent = ? AND skill = 'wire' AND status = 'completed' AND routed_to = 'system' ORDER BY created_at DESC LIMIT 5"
    ).all(fromAgent) as { id: string }[];
    return rows.map(r => r.id);
  }

  recentErrors(limit = 10): DispatchRecord[] {
    return (this.db.query(
      "SELECT * FROM dispatch WHERE status = 'failed' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as Record<string, unknown>[]).map(rowToRecord);
  }

  listAwaitingReview(limit = 50): DispatchRecord[] {
    return (this.db.query(
      "SELECT * FROM dispatch WHERE status = 'awaiting_review' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as Record<string, unknown>[]).map(rowToRecord);
  }

  // Operator approves a PhaseGate-escalated task — marks it done so it exits
  // the permanent dead-end state. Returns true if the claim succeeded (was
  // in awaiting_review), false if the record was not found or already moved.
  claimAwaitingReview(id: string): boolean {
    const result = this.db.run(
      "UPDATE dispatch SET status = 'done', updated_at = ? WHERE id = ? AND status = 'awaiting_review'",
      [Date.now(), id],
    ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  // Operator rejects a PhaseGate-escalated task — marks it rejected.
  rejectAwaitingReview(id: string): boolean {
    const result = this.db.run(
      "UPDATE dispatch SET status = 'rejected', updated_at = ? WHERE id = ? AND status = 'awaiting_review'",
      [Date.now(), id],
    ) as { changes?: number };
    return (result.changes ?? 0) === 1;
  }

  close(): void {
    this.db.close();
  }
}

function rowToRecord(row: Record<string, unknown>): DispatchRecord {
  return {
    id: row["id"] as string,
    from: row["from_agent"] as string,
    skill: row["skill"] as string,
    routed_to: row["routed_to"] as string,
    status: row["status"] as DispatchStatus,
    created_at: row["created_at"] as number,
    updated_at: row["updated_at"] as number,
    result_id: row["result_id"] as string | undefined,
    error: row["error"] as string | null | undefined,
    project: (row["project"] ?? undefined) as string | undefined,
    source_file: (row["source_file"] ?? undefined) as string | undefined,
  };
}
