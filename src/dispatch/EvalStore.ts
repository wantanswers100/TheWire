// EvalStore — synchronous per-step quality logging
// Records one row per step per task. Non-blocking insert.
//
// SQLite table `eval_scores` in .wire-state/dispatch.db
// Shares the same database file as DispatchDB — uses CREATE TABLE IF NOT EXISTS,
// so no migration conflicts. Each Database instance uses its own connection
// (safe with WAL mode, and tests use isolated tempdirs).

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvalStep = "memory_enrich" | "route" | "worker" | "judge" | "end_to_end";
export type EvalVerdict = "pass" | "warn" | "fail" | "skip" | "skipped_cooldown";

export interface EvalScore {
  task_id: string;
  step: string;
  score: number | null;
  agent: string | null;
  skill: string | null;
  latency_ms: number | null;
  verdict: string | null;
  created_at: number;
}

export interface RecentStats {
  completionRate: number;
  judgePassRate: number;
  retryRate: number;
  escalationRate: number;
}

// ─── EvalStore ────────────────────────────────────────────────────────────────

export class EvalStore {
  private db: Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "dispatch.db"));
    this.db.run(`
      CREATE TABLE IF NOT EXISTS eval_scores (
        task_id    TEXT NOT NULL,
        step       TEXT NOT NULL,
        score      REAL,
        agent      TEXT,
        skill      TEXT,
        latency_ms INTEGER,
        verdict    TEXT,
        created_at INTEGER NOT NULL
      )
    `);
  }

  // Synchronous insert — intentionally not async (non-blocking by virtue of
  // SQLite's fast local write; caller never awaits). If the insert fails,
  // log a warning and continue — eval loss must never block task delivery.
  record(
    taskId: string,
    step: string,
    score: number,
    meta: {
      agent?: string;
      skill?: string;
      latency_ms?: number;
      verdict?: string;
    } = {}
  ): void {
    try {
      this.db.run(
        `INSERT INTO eval_scores (task_id, step, score, agent, skill, latency_ms, verdict, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          taskId,
          step,
          score,
          meta.agent ?? null,
          meta.skill ?? null,
          meta.latency_ms ?? null,
          meta.verdict ?? null,
          Date.now(),
        ]
      );
    } catch (e) {
      console.warn(`[eval-store] record failed for task ${taskId.slice(0, 8)}: ${(e as Error).message}`);
    }
  }

  // SELECT all rows for taskId, ordered by created_at ascending.
  summary(taskId: string): EvalScore[] {
    try {
      return this.db.query(
        `SELECT task_id, step, score, agent, skill, latency_ms, verdict, created_at
         FROM eval_scores WHERE task_id = ? ORDER BY created_at ASC`
      ).all(taskId) as EvalScore[];
    } catch (e) {
      console.warn(`[eval-store] summary query failed for task ${taskId.slice(0, 8)}: ${(e as Error).message}`);
      return [];
    }
  }

  // Aggregate last N end_to_end rows into summary stats.
  recentStats(limit = 100): RecentStats {
    const empty: RecentStats = { completionRate: 0, judgePassRate: 0, retryRate: 0, escalationRate: 0 };
    let rows: { verdict: string | null; score: number | null }[];
    try {
      rows = this.db.query(
        `SELECT verdict, score FROM eval_scores
         WHERE step = 'end_to_end' ORDER BY created_at DESC LIMIT ?`
      ).all(limit) as { verdict: string | null; score: number | null }[];
    } catch (e) {
      console.warn(`[eval-store] recentStats query failed: ${(e as Error).message}`);
      return empty;
    }

    if (rows.length === 0) return empty;

    const total = rows.length;
    const passed   = rows.filter(r => r.verdict === "pass").length;
    const failed   = rows.filter(r => r.verdict === "fail").length;
    const warned   = rows.filter(r => r.verdict === "warn").length;

    const completionRate = (total - failed) / total;
    const judgePassRate  = passed / total;
    const retryRate      = warned / total;
    const escalationRate = failed / total;

    return {
      completionRate: Math.round(completionRate * 1000) / 1000,
      judgePassRate:  Math.round(judgePassRate  * 1000) / 1000,
      retryRate:      Math.round(retryRate       * 1000) / 1000,
      escalationRate: Math.round(escalationRate  * 1000) / 1000,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch (e) {
      console.warn(`[eval-store] close failed: ${(e as Error).message}`);
    }
  }
}
