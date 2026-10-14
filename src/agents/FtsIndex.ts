// FtsIndex — FTS5 full-text search over the memory table
//
// Strategy: content table (content=memory, content_rowid=id)
// Three sync triggers keep the index in step with every INSERT/UPDATE/DELETE.
// WAL mode must be set before this class is instantiated.

import type { Database } from "bun:sqlite";
import type { MemoryCategory } from "./memory.js";

export interface FtsResult {
  id: number;
  key: string;
  value: string;
  category: MemoryCategory;
  tags: string[];     // normalized from JSON string stored in DB
  bm25: number;       // raw BM25 from SQLite (negative — lower = better)
  score: number;      // normalized 0.0–1.0
  source: "fts";
}

const REQUIRED_TRIGGER_COUNT = 3;

export class FtsIndex {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.setup();
  }

  private setup(): void {
    // FTS5 virtual table — mirrors key, value, tags columns of memory
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        key, value, tags,
        content=memory,
        content_rowid=id,
        tokenize='porter unicode61'
      )
    `);

    // Sync trigger: INSERT
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_ai
      AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, key, value, tags)
        VALUES (new.id, new.key, new.value, new.tags);
      END
    `);

    // Sync trigger: DELETE
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_ad
      AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
        VALUES ('delete', old.id, old.key, old.value, old.tags);
      END
    `);

    // Sync trigger: UPDATE
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_au
      AFTER UPDATE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
        VALUES ('delete', old.id, old.key, old.value, old.tags);
        INSERT INTO memory_fts(rowid, key, value, tags)
        VALUES (new.id, new.key, new.value, new.tags);
      END
    `);

    // Guard: verify all 3 triggers are present
    const count = (this.db.query(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_fts_%'"
    ).get() as { n: number }).n;

    if (count < REQUIRED_TRIGGER_COUNT) {
      throw new Error(
        `FtsIndex: expected ${REQUIRED_TRIGGER_COUNT} sync triggers, found ${count}. ` +
        `Run migrate-fts5.ts to repair.`
      );
    }
  }

  // Rebuild the FTS5 index from the content table (needed after migration)
  rebuild(): void {
    this.db.run("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");
  }

  search(query: string, limit = 10, category?: MemoryCategory): FtsResult[] {
    // Escape FTS5 special characters to avoid query parse errors
    const safeQuery = query.replace(/["*^()]/g, " ").trim();
    if (!safeQuery) return [];

    const sql = category
      ? `SELECT m.id, m.key, m.value, m.category, m.tags,
                bm25(memory_fts) AS bm25
         FROM memory_fts
         JOIN memory m ON m.id = memory_fts.rowid
         WHERE memory_fts MATCH ? AND m.category = ?
         ORDER BY bm25
         LIMIT ?`
      : `SELECT m.id, m.key, m.value, m.category, m.tags,
                bm25(memory_fts) AS bm25
         FROM memory_fts
         JOIN memory m ON m.id = memory_fts.rowid
         WHERE memory_fts MATCH ?
         ORDER BY bm25
         LIMIT ?`;

    const params = category ? [safeQuery, category, limit] : [safeQuery, limit];

    let rows: Record<string, unknown>[];
    try {
      rows = this.db.query(sql).all(...params) as Record<string, unknown>[];
    } catch (err) {
      // Suppress FTS5 query errors (syntax, unknown columns, malformed) — re-throw others
      const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
      const isFtsQueryError = msg.includes("fts5") || msg.includes("syntax error") ||
        msg.includes("malformed") || msg.includes("no such column");
      if (isFtsQueryError) return [];
      throw err;
    }

    return rows.map(r => {
      const bm25 = r["bm25"] as number;
      const rawTags = r["tags"] as string;
      let tags: string[];
      try { tags = JSON.parse(rawTags); } catch { tags = []; }
      if (!Array.isArray(tags)) tags = [];
      return {
        id:       r["id"] as number,
        key:      r["key"] as string,
        value:    r["value"] as string,
        category: r["category"] as MemoryCategory,
        tags,
        bm25,
        score:    normalizeBm25(bm25),
        source:   "fts" as const,
      };
    });
  }
}

// BM25 from SQLite FTS5 is negative (lower = more relevant).
// Map to [0, 1] where 1 = perfect match.
function normalizeBm25(bm25: number): number {
  return 1.0 / (1.0 + Math.abs(bm25));
}
