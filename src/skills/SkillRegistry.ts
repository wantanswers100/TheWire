// SkillRegistry — SQLite-backed outcome store for the skill feedback loop
//
// Records every dispatch outcome. Feeds SkillCompressor for summarization.
// Consulted by SkillRouter to inform routing decisions.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { OutcomeRecord } from "../types.js";
import type { SkillRecord, SkillStats } from "./types.js";

export class SkillRegistry {
  private db: Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "skills.db"));
    this.db.run("PRAGMA journal_mode=WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS skills (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        skill             TEXT NOT NULL,
        subject           TEXT,
        prompt_hash       TEXT NOT NULL,
        outcome           TEXT NOT NULL DEFAULT 'success',
        agent_used        TEXT NOT NULL,
        tokens_used       INTEGER,
        result_summary    TEXT NOT NULL DEFAULT '',
        compressed_summary TEXT,
        compression_model TEXT NOT NULL DEFAULT '',
        created_at        INTEGER NOT NULL,
        compressed_at     INTEGER
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_skills_skill ON skills(skill)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_skills_outcome ON skills(outcome)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_skills_compressed ON skills(compressed_at)`);
  }

  record(outcome: OutcomeRecord): number {
    const promptHash = createHash("sha256")
      .update(`${outcome.skill}:${outcome.subject ?? ""}`)
      .digest("hex")
      .slice(0, 16);

    const result = this.db.run(
      `INSERT INTO skills
        (skill, subject, prompt_hash, outcome, agent_used, tokens_used, result_summary, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        outcome.skill,
        outcome.subject ?? null,
        promptHash,
        outcome.status,
        outcome.agentUsed,
        outcome.tokensUsed ?? null,
        outcome.resultSummary.slice(0, 500),
        outcome.createdAt,
      ]
    );
    return result.lastInsertRowid as number;
  }

  stats(skill: string): SkillStats | null {
    const row = this.db.query(`
      SELECT
        skill,
        COUNT(*) as total,
        SUM(CASE WHEN outcome='success' THEN 1 ELSE 0 END) as successes,
        SUM(CASE WHEN outcome='failed'  THEN 1 ELSE 0 END) as failures,
        AVG(tokens_used) as avg_tokens,
        (SELECT agent_used FROM skills s2 WHERE s2.skill = skills.skill
         GROUP BY agent_used ORDER BY COUNT(*) DESC LIMIT 1) as most_used_agent
      FROM skills
      WHERE skill = ?
      GROUP BY skill
    `).get(skill) as Record<string, unknown> | null;

    if (!row) return null;

    const total = row["total"] as number;
    const successes = row["successes"] as number;

    return {
      skill:            row["skill"] as import("../types.js").SkillType,
      total,
      successes,
      failures:         row["failures"] as number,
      success_rate:     total > 0 ? successes / total : 0,
      avg_tokens:       row["avg_tokens"] as number | null,
      most_used_agent:  row["most_used_agent"] as import("../types.js").AgentId | null,
    };
  }

  list(skill?: string, limit = 50): SkillRecord[] {
    if (skill) {
      return this.db.query(
        "SELECT * FROM skills WHERE skill=? ORDER BY created_at DESC LIMIT ?"
      ).all(skill, limit) as SkillRecord[];
    }
    return this.db.query(
      "SELECT * FROM skills ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as SkillRecord[];
  }

  // Returns records not yet compressed, rated for compression (success outcomes only)
  pendingCompression(skill: string, batchSize = 50): SkillRecord[] {
    return this.db.query(
      `SELECT * FROM skills
       WHERE skill=? AND outcome='success' AND compressed_at IS NULL
       ORDER BY created_at ASC LIMIT ?`
    ).all(skill, batchSize) as SkillRecord[];
  }

  markCompressed(ids: number[], compressedSummary: string, model: string): void {
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE skills SET compressed_summary=?, compression_model=?, compressed_at=? WHERE id IN (${placeholders})`,
      [compressedSummary, model, now, ...ids]
    );
  }
}
