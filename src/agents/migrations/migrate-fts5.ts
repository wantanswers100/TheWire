#!/usr/bin/env bun
// migrate-fts5 — add FTS5 index + sync triggers to an existing memory.db
//
// Safe to run multiple times (all DDL uses IF NOT EXISTS).
// Run after upgrading Wire from a pre-FTS5 version:
//
//   bun run src/agents/migrations/migrate-fts5.ts [--db <path>]

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const argIdx = process.argv.indexOf("--db");
const dbPath = argIdx !== -1 && process.argv[argIdx + 1]
  ? process.argv[argIdx + 1]!
  : join(
      process.env["HOME"] ?? homedir(),
      "projects", "active", "agent-wire", ".wire-state", "memory.db"
    );

if (!existsSync(dbPath)) {
  console.error(`memory.db not found at: ${dbPath}`);
  console.error("Run: bun run src/agents/migrations/migrate-fts5.ts --db <path>");
  process.exit(1);
}

console.log(`Migrating: ${dbPath}`);
const db = new Database(dbPath);
db.run("PRAGMA journal_mode=WAL");

db.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    key, value, tags,
    content=memory,
    content_rowid=id,
    tokenize='porter unicode61'
  )
`);

db.run(`
  CREATE TRIGGER IF NOT EXISTS memory_fts_ai
  AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, key, value, tags)
    VALUES (new.id, new.key, new.value, new.tags);
  END
`);

db.run(`
  CREATE TRIGGER IF NOT EXISTS memory_fts_ad
  AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
    VALUES ('delete', old.id, old.key, old.value, old.tags);
  END
`);

db.run(`
  CREATE TRIGGER IF NOT EXISTS memory_fts_au
  AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, key, value, tags)
    VALUES ('delete', old.id, old.key, old.value, old.tags);
    INSERT INTO memory_fts(rowid, key, value, tags)
    VALUES (new.id, new.key, new.value, new.tags);
  END
`);

// Rebuild index from existing rows
db.run("INSERT INTO memory_fts(memory_fts) VALUES ('rebuild')");

const count = (db.query("SELECT COUNT(*) as n FROM memory").get() as { n: number }).n;
const triggerCount = (db.query(
  "SELECT COUNT(*) as n FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_fts_%'"
).get() as { n: number }).n;

console.log(`Done. Rows indexed: ${count}  Triggers: ${triggerCount}/3`);
db.close();
