// Memory agent — Wire Platform Phase 18
//
// SQLite-backed persistent memory store.
// Search: keyword (LIKE) + semantic (cosine via nomic-embed-text embeddings).
//
// Categories:
//   conversation   — chat turns, summaries
//   task_log       — dispatch records: what was asked, what ran, what came back
//   project_state  — per-project status snapshots
//   preference     — user preferences learned over time
//   observation    — wire agent observations about patterns, behavior
//
// Wire interface:
//   skill=memory, verb=set|get|search
//   set:    { key, value, category?, tags? }
//   get:    { key, category? }
//   search: { query, topK?, category? }

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { FtsIndex } from "./FtsIndex.js";
import { mergeResults } from "./MemoryRouter.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryCategory =
  | "conversation"
  | "task_log"
  | "project_state"
  | "preference"
  | "observation";

export interface MemoryEntry {
  id: number;
  agent_id: string;
  session_id: string;
  category: MemoryCategory;
  key: string;
  value: string;
  tags: string;        // JSON array string
  embedding?: Float32Array;
  created_at: number;
  updated_at: number;
}

export interface SearchResult {
  id: number;
  key: string;
  value: string;
  category: MemoryCategory;
  tags: string[];
  score: number;       // 0.0–1.0; keyword=1.0 exact, semantic=cosine similarity
  created_at: number;
}

// ─── Embedding ────────────────────────────────────────────────────────────────

import { OLLAMA_URL, EMBED_MODEL } from "../config/models.js";
const EMBED_DIM = 768;

async function embed(text: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[memory] embed: Ollama HTTP ${res.status} — falling back to keyword search`);
      return null;
    }
    const data = await res.json() as { embedding?: number[] };
    if (!data.embedding) {
      console.warn(`[memory] embed: Ollama response missing 'embedding' field — falling back to keyword search`);
      return null;
    }
    if (data.embedding.length !== EMBED_DIM) {
      console.warn(`[memory] embed: dimension mismatch (expected ${EMBED_DIM}, got ${data.embedding.length}) — check EMBED_MODEL config`);
      return null;
    }
    return new Float32Array(data.embedding);
  } catch (e) {
    console.warn(`[memory] embed: fetch failed (${(e as Error).message}) — falling back to keyword search`);
    return null;
  }
}

// Defensive tags parser — a corrupted row must not poison an entire search call (SF9)
function parseTags(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ─── MemoryStore ──────────────────────────────────────────────────────────────

export interface SearchWithSummaryResult {
  results: SearchResult[];
  summary: string | null;
  source: "fts" | "semantic" | "hybrid" | "keyword";
}

export class MemoryStore {
  private db: Database;
  private fts: FtsIndex;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "memory.db"));
    // WAL must come before any DDL — required for FTS5 consistency
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL DEFAULT 'system',
        session_id  TEXT NOT NULL DEFAULT '',
        category    TEXT NOT NULL DEFAULT 'observation',
        key         TEXT NOT NULL,
        value       TEXT NOT NULL,
        tags        TEXT NOT NULL DEFAULT '[]',
        embedding   BLOB,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_key ON memory(key)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_category ON memory(category)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory(agent_id)`);
    this.fts = new FtsIndex(this.db);
  }

  // ── set ─────────────────────────────────────────────────────────────────────

  async set(opts: {
    key: string;
    value: string;
    category?: MemoryCategory;
    tags?: string[];
    agentId?: string;
    sessionId?: string;
  }): Promise<number> {
    const now = Date.now();
    const category = opts.category ?? "observation";
    const tags = JSON.stringify(opts.tags ?? []);
    const agentId = opts.agentId ?? "system";
    const sessionId = opts.sessionId ?? "";

    // Generate embedding (best-effort — store without if Ollama unavailable)
    const vec = await embed(`${opts.key} ${opts.value}`);
    const embeddingBlob = vec ? Buffer.from(vec.buffer) : null;

    // Upsert: update if key+category+agent_id already exists
    const existing = this.db.query(
      "SELECT id FROM memory WHERE key = ? AND category = ? AND agent_id = ? LIMIT 1"
    ).get(opts.key, category, agentId) as { id: number } | null;

    if (existing) {
      this.db.run(
        "UPDATE memory SET value=?, tags=?, embedding=?, updated_at=? WHERE id=?",
        [opts.value, tags, embeddingBlob, now, existing.id]
      );
      return existing.id;
    }

    const result = this.db.run(
      "INSERT INTO memory (agent_id, session_id, category, key, value, tags, embedding, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      [agentId, sessionId, category, opts.key, opts.value, tags, embeddingBlob, now, now]
    );
    return result.lastInsertRowid as number;
  }

  // ── get ─────────────────────────────────────────────────────────────────────

  get(key: string, category?: MemoryCategory, agentId?: string): MemoryEntry | null {
    const clauses = ["key = ?"];
    const params: (string | number | boolean | null)[] = [key];
    if (category) { clauses.push("category = ?"); params.push(category); }
    if (agentId) { clauses.push("agent_id = ?"); params.push(agentId); }

    const row = this.db.query(
      `SELECT * FROM memory WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`
    ).get(...params) as Record<string, unknown> | null;

    return row ? rowToEntry(row) : null;
  }

  // ── search ───────────────────────────────────────────────────────────────────

  async search(opts: {
    query: string;
    topK?: number;
    category?: MemoryCategory;
    agentId?: string;
  }): Promise<SearchResult[]> {
    const topK = opts.topK ?? 5;

    // Step 1: keyword match (fast, no embedding)
    // Split query into words (≥3 chars) and OR them — avoids false negatives when
    // the full phrase isn't a substring of stored values.
    const words = opts.query.split(/\s+/).filter(w => w.length >= 3);
    const wordClauses = words.length > 0
      ? words.map(() => "(key LIKE ? OR value LIKE ?)").join(" OR ")
      : "(key LIKE ? OR value LIKE ?)";
    const wordParams: (string | number | boolean | null)[] = words.length > 0
      ? words.flatMap(w => [`%${w}%`, `%${w}%`])
      : [`%${opts.query}%`, `%${opts.query}%`];

    const filterClauses: string[] = [`(${wordClauses})`];
    if (opts.category) { filterClauses.push("category = ?"); wordParams.push(opts.category); }
    if (opts.agentId) { filterClauses.push("agent_id = ?"); wordParams.push(opts.agentId); }

    const keywordRows = this.db.query(
      `SELECT * FROM memory WHERE ${filterClauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(...wordParams, topK * 2) as Record<string, unknown>[];

    const keywordResults: SearchResult[] = keywordRows.map(r => ({
      id: r["id"] as number,
      key: r["key"] as string,
      value: r["value"] as string,
      category: r["category"] as MemoryCategory,
      tags: parseTags(r["tags"]),
      score: 1.0,
      created_at: r["created_at"] as number,
    }));

    // Step 2: semantic search (if embedding available)
    const queryVec = await embed(opts.query);
    if (!queryVec) {
      return keywordResults.slice(0, topK);
    }

    // Load all rows with embeddings for cosine comparison
    const allClauses = ["embedding IS NOT NULL"];
    const allParams: (string | number | boolean | null)[] = [];
    if (opts.category) { allClauses.push("category = ?"); allParams.push(opts.category); }
    if (opts.agentId) { allClauses.push("agent_id = ?"); allParams.push(opts.agentId); }

    const allRows = this.db.query(
      `SELECT id, key, value, category, tags, embedding, created_at FROM memory WHERE ${allClauses.join(" AND ")}`
    ).all(...allParams) as Record<string, unknown>[];

    const semantic: SearchResult[] = [];
    for (const r of allRows) {
      const blob = r["embedding"] as Buffer | null;
      if (!blob) continue;
      const vec = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      const score = cosineSimilarity(queryVec, vec);
      if (score > 0.5) {
        semantic.push({
          id: r["id"] as number,
          key: r["key"] as string,
          value: r["value"] as string,
          category: r["category"] as MemoryCategory,
          tags: parseTags(r["tags"]),
          score,
          created_at: r["created_at"] as number,
        });
      }
    }
    semantic.sort((a, b) => b.score - a.score);

    // FTS5 search — faster and more accurate than LIKE for full-text
    const ftsResults = this.fts.search(opts.query, topK * 2, opts.category);

    // Merge all three sources with hybrid ranking
    return mergeResults(ftsResults, semantic, keywordResults, topK);
  }

  // ── searchWithSummary ────────────────────────────────────────────────────────
  // Returns search results + an LLM-generated summary via qwen3:4b.
  // Uses /no_think to prevent qwen3 from stalling (ISS-021).

  async searchWithSummary(opts: {
    query: string;
    topK?: number;
    category?: MemoryCategory;
    agentId?: string;
  }): Promise<SearchWithSummaryResult> {
    const results = await this.search(opts);
    if (results.length === 0) {
      return { results: [], summary: null, source: "keyword" };
    }

    // Determine dominant source for caller
    const sources = (results as Array<{ source?: string }>).map(r => r.source ?? "keyword");
    const hasFts = sources.some(s => s === "fts" || s === "both");
    const hasSemantic = sources.some(s => s === "semantic" || s === "both");
    const source = hasFts && hasSemantic ? "hybrid" : hasFts ? "fts" : hasSemantic ? "semantic" : "keyword";

    // Build context snippet for the LLM
    const snippets = results.slice(0, 5).map((r, i) =>
      `[${i + 1}] ${r.key}: ${r.value.slice(0, 300)}`
    ).join("\n");

    const prompt =
      `You are a memory assistant. The user searched for: "${opts.query}"\n\n` +
      `Relevant memory entries:\n${snippets}\n\n` +
      `Write a 2-3 sentence summary of what these entries tell us about "${opts.query}". ` +
      `Base your summary only on the entries above. If the entries don't clearly answer the query, say so. ` +
      `Do not guess or infer beyond what is written. Be concise and factual. /no_think`;

    const summary = await callOllama(prompt);
    return { results, summary, source };
  }

  // ── log task (called by dispatch loop) ────────────────────────────────────

  async logTask(opts: {
    taskId: string;
    from: string;
    skill: string;
    subject?: string;
    routedTo: string;
    status: string;
    resultSummary?: string;
    sessionId?: string;
  }): Promise<void> {
    const value = JSON.stringify({
      taskId: opts.taskId,
      from: opts.from,
      skill: opts.skill,
      subject: opts.subject,
      routedTo: opts.routedTo,
      status: opts.status,
      resultSummary: opts.resultSummary?.slice(0, 500),
    });
    await this.set({
      key: `task:${opts.taskId}`,
      value,
      category: "task_log",
      tags: [opts.skill, opts.routedTo, opts.status],
      agentId: opts.from,
      sessionId: opts.sessionId,
    });
  }

  // ── recent ────────────────────────────────────────────────────────────────

  recent(category?: MemoryCategory, limit = 10): SearchResult[] {
    const where = category ? "WHERE category = ?" : "";
    const params: (string | number | boolean | null)[] = category ? [category, limit] : [limit];
    const rows = this.db.query(
      `SELECT id, key, value, category, tags, created_at FROM memory ${where} ORDER BY updated_at DESC, id DESC LIMIT ?`
    ).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r["id"] as number,
      key: r["key"] as string,
      value: r["value"] as string,
      category: r["category"] as MemoryCategory,
      tags: parseTags(r["tags"]),
      score: 1.0,
      created_at: r["created_at"] as number,
    }));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function callOllama(prompt: string): Promise<string | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3:4b", prompt, stream: false, think: false, options: { num_predict: 256 } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { response?: string };
    return data.response?.trim() ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("abort") && !msg.includes("AbortError")) {
      console.warn(`[memory] callOllama failed: ${msg.slice(0, 120)}`);
    }
    return null;
  }
}

function rowToEntry(r: Record<string, unknown>): MemoryEntry {
  const blob = r["embedding"] as Buffer | null;
  return {
    id: r["id"] as number,
    agent_id: r["agent_id"] as string,
    session_id: r["session_id"] as string,
    category: r["category"] as MemoryCategory,
    key: r["key"] as string,
    value: r["value"] as string,
    tags: r["tags"] as string,
    embedding: blob ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4) : undefined,
    created_at: r["created_at"] as number,
    updated_at: r["updated_at"] as number,
  };
}
