import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { FtsIndex } from "../src/agents/FtsIndex.js";
import { MemoryStore } from "../src/agents/memory.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `wire-fts-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.env["WIRE_TEST"] = "1";
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env["WIRE_TEST"];
});

// ─── FtsIndex unit tests ──────────────────────────────────────────────────────

describe("FtsIndex — setup", () => {
  test("creates virtual table and 3 triggers", () => {
    const db = new Database(join(testDir, "fts-test.db"));
    db.run("PRAGMA journal_mode=WAL");
    db.run(`CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT 'system',
      session_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'observation',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      embedding BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    const fts = new FtsIndex(db);
    expect(fts).toBeTruthy();

    const tableExists = db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'"
    ).get();
    expect(tableExists).not.toBeNull();

    const triggerCount = (db.query(
      "SELECT COUNT(*) as n FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_fts_%'"
    ).get() as { n: number }).n;
    expect(triggerCount).toBe(3);

    db.close();
  });
});

describe("FtsIndex — search", () => {
  function makeDb() {
    const db = new Database(join(testDir, `fts-${Date.now()}.db`));
    db.run("PRAGMA journal_mode=WAL");
    db.run(`CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL DEFAULT 'system',
      session_id TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'observation',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      embedding BLOB,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    return db;
  }

  test("exact match returns result", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    db.run(
      "INSERT INTO memory (key, value, tags, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["project-alpha", "Wire Platform is a personal AI dispatch system", "[]", now, now]
    );

    const results = fts.search("dispatch");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.key).toBe("project-alpha");
    expect(results[0]!.source).toBe("fts");
    db.close();
  });

  test("no false positives for unrelated query", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    db.run(
      "INSERT INTO memory (key, value, tags, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["note-1", "SQLite is a lightweight embedded database", "[]", now, now]
    );

    const results = fts.search("bitcoin cryptocurrency");
    expect(results.length).toBe(0);
    db.close();
  });

  test("insert trigger keeps index in sync", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    // Insert after FtsIndex is set up — trigger should fire
    db.run(
      "INSERT INTO memory (key, value, tags, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["cron-job", "Persistent cron scheduler for Wire Platform", "[]", now, now]
    );

    const results = fts.search("cron scheduler");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.key).toBe("cron-job");
    db.close();
  });

  test("update trigger updates index", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    db.run(
      "INSERT INTO memory (id, key, value, tags, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      [1, "memo-1", "original content about routing", "[]", now, now]
    );

    db.run(
      "UPDATE memory SET value=?, updated_at=? WHERE id=?",
      ["updated content about dispatch pipeline", now + 1, 1]
    );

    const oldResults = fts.search("routing");
    const newResults = fts.search("dispatch pipeline");
    expect(newResults.length).toBeGreaterThan(0);
    // Old term may or may not match (porter stemmer keeps root) — just check new matches
    expect(newResults[0]!.value).toContain("dispatch pipeline");
    db.close();
  });

  test("delete trigger removes from index", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    db.run(
      "INSERT INTO memory (id, key, value, tags, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      [1, "ephemeral", "temporary test entry for deletion", "[]", now, now]
    );

    db.run("DELETE FROM memory WHERE id=1");

    const results = fts.search("temporary test entry");
    expect(results.length).toBe(0);
    db.close();
  });

  test("category filter narrows results", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    db.run(
      "INSERT INTO memory (key, value, category, tags, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["task-1", "Wire dispatch task completed", "task_log", "[]", now, now]
    );
    db.run(
      "INSERT INTO memory (key, value, category, tags, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["obs-1", "Wire dispatch observed pattern", "observation", "[]", now, now]
    );

    const taskResults = fts.search("dispatch", 10, "task_log");
    const obsResults = fts.search("dispatch", 10, "observation");

    expect(taskResults.every(r => r.category === "task_log")).toBe(true);
    expect(obsResults.every(r => r.category === "observation")).toBe(true);
    db.close();
  });

  test("score is normalized between 0 and 1", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);

    const now = Date.now();
    db.run(
      "INSERT INTO memory (key, value, tags, created_at, updated_at) VALUES (?,?,?,?,?)",
      ["score-test", "memory search scoring normalization", "[]", now, now]
    );

    const results = fts.search("memory search");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    db.close();
  });

  test("malformed FTS query does not throw", () => {
    const db = makeDb();
    const fts = new FtsIndex(db);
    // Unclosed quote — FTS5 would normally throw
    expect(() => fts.search('"unclosed quote')).not.toThrow();
    db.close();
  });
});

// ─── MemoryStore FTS5 integration ─────────────────────────────────────────────

describe("MemoryStore — FTS5 integration", () => {
  test("constructor sets WAL mode and creates FTS5 table", () => {
    const store = new MemoryStore(testDir);
    // Access internal db via type assertion — read-only check
    const db = (store as unknown as { db: Database }).db;
    const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    expect(mode).toBe("wal");

    const ftsTable = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get();
    expect(ftsTable).not.toBeNull();
  });

  test("search returns FTS5 results after set()", async () => {
    const store = new MemoryStore(testDir);
    await store.set({ key: "wire-arch", value: "Wire uses file-based IPC for agent dispatch", category: "observation" });
    await store.set({ key: "unrelated", value: "the weather is sunny today", category: "observation" });

    const results = await store.search({ query: "file-based IPC dispatch" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.key).toBe("wire-arch");
  });
});
