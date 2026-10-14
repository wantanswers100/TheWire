import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { CronEntry, CronRunRecord, CronAddInput } from "./types.js";
import { CRON_FORBIDDEN_SKILLS } from "./types.js";
import { nextRunAfter } from "./CronParser.js";
import type { SkillType } from "../types.js";

export class CronRegistry {
  private db: Database;
  readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "cron.db"));
    this.db.run("PRAGMA journal_mode=WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cron_entries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL UNIQUE,
        schedule     TEXT NOT NULL,
        skill        TEXT NOT NULL,
        subject      TEXT NOT NULL,
        domain       TEXT NOT NULL DEFAULT '["general"]',
        enabled      INTEGER NOT NULL DEFAULT 1,
        last_run     INTEGER,
        next_run     INTEGER NOT NULL,
        run_count    INTEGER NOT NULL DEFAULT 0,
        fail_count   INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cron_runs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        cron_id          INTEGER NOT NULL REFERENCES cron_entries(id),
        started_at       INTEGER NOT NULL,
        finished_at      INTEGER,
        status           TEXT NOT NULL DEFAULT 'running',
        dispatch_task_id TEXT,
        error            TEXT
      )
    `);
  }

  add(input: CronAddInput): CronEntry {
    if (CRON_FORBIDDEN_SKILLS.has(input.skill as SkillType)) {
      throw new Error(
        `Skill '${input.skill}' requires HITL approval and cannot be scheduled as a cron task. ` +
        `Forbidden skills: ${[...CRON_FORBIDDEN_SKILLS].join(", ")}`
      );
    }

    const now = Date.now();
    const next_run = nextRunAfter(input.schedule, now);

    const stmt = this.db.prepare(`
      INSERT INTO cron_entries (name, schedule, skill, subject, domain, enabled, next_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      input.name,
      input.schedule,
      input.skill,
      input.subject,
      JSON.stringify(input.domain ?? ["general"]),
      input.enabled ? 1 : 0,
      next_run,
      now
    );

    return this.get(result.lastInsertRowid as number)!;
  }

  get(id: number): CronEntry | null {
    const row = this.db.query(
      "SELECT * FROM cron_entries WHERE id = ?"
    ).get(id) as Record<string, unknown> | null;
    return row ? this.rowToEntry(row) : null;
  }

  getByName(name: string): CronEntry | null {
    const row = this.db.query(
      "SELECT * FROM cron_entries WHERE name = ?"
    ).get(name) as Record<string, unknown> | null;
    return row ? this.rowToEntry(row) : null;
  }

  list(): CronEntry[] {
    const rows = this.db.query("SELECT * FROM cron_entries ORDER BY id ASC").all();
    return (rows as Record<string, unknown>[]).map(r => this.rowToEntry(r));
  }

  listDue(now: number = Date.now()): CronEntry[] {
    const rows = this.db.query(
      "SELECT * FROM cron_entries WHERE enabled = 1 AND next_run <= ?"
    ).all(now);
    return (rows as Record<string, unknown>[]).map(r => this.rowToEntry(r));
  }

  remove(id: number): boolean {
    const result = this.db.run("DELETE FROM cron_entries WHERE id = ?", [id]);
    return result.changes > 0;
  }

  setEnabled(id: number, enabled: boolean): void {
    this.db.run("UPDATE cron_entries SET enabled = ? WHERE id = ?", [enabled ? 1 : 0, id]);
  }

  recordRunStart(cronId: number): number {
    const result = this.db.run(
      "INSERT INTO cron_runs (cron_id, started_at, status) VALUES (?, ?, 'running')",
      [cronId, Date.now()]
    );
    return result.lastInsertRowid as number;
  }

  recordRunComplete(runId: number, taskId: string | null, error?: string): void {
    const status = error ? "failed" : "done";
    this.db.run(
      "UPDATE cron_runs SET finished_at = ?, status = ?, dispatch_task_id = ?, error = ? WHERE id = ?",
      [Date.now(), status, taskId, error ?? null, runId]
    );
  }

  advanceNextRun(id: number, schedule: string): void {
    const now = Date.now();
    const next_run = nextRunAfter(schedule, now);
    this.db.run(
      "UPDATE cron_entries SET last_run = ?, next_run = ?, run_count = run_count + 1 WHERE id = ?",
      [now, next_run, id]
    );
  }

  // setNextRunNow() — force next_run to past so daemon picks it up immediately
  setNextRunNow(id: number): void {
    this.db.run(
      "UPDATE cron_entries SET next_run = ? WHERE id = ?",
      [Date.now() - 1, id]
    );
  }

  incrementFailCount(id: number): void {
    this.db.run(
      "UPDATE cron_entries SET fail_count = fail_count + 1 WHERE id = ?",
      [id]
    );
  }

  recentRuns(cronId: number, limit = 10): CronRunRecord[] {
    const rows = this.db.query(
      "SELECT * FROM cron_runs WHERE cron_id = ? ORDER BY started_at DESC LIMIT ?"
    ).all(cronId, limit);
    return rows as CronRunRecord[];
  }

  private rowToEntry(row: Record<string, unknown>): CronEntry {
    return {
      id:         row["id"] as number,
      name:       row["name"] as string,
      schedule:   row["schedule"] as string,
      skill:      row["skill"] as SkillType,
      subject:    row["subject"] as string,
      domain:     JSON.parse(row["domain"] as string) as string[],
      enabled:    (row["enabled"] as number) === 1,
      last_run:   row["last_run"] as number | null,
      next_run:   row["next_run"] as number,
      run_count:  row["run_count"] as number,
      fail_count: row["fail_count"] as number,
      created_at: row["created_at"] as number,
    };
  }
}
