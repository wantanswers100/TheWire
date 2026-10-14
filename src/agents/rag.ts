// RAG layer — Wire Platform Phase 19 + Sprint 2 hybrid
//
// Document ingest + semantic retrieval.
// Same SQLite + nomic-embed-text stack as memory — no new dependencies.
//
// Ingest:    chunk file → embed each chunk → store in rag_chunks table
// Retrieve:  two parallel paths merged and re-ranked:
//   Path A (vector):      embed query → cosine similarity → top candidates
//   Path B (graph-first): entity mentions in query → triples lookup → project bridge
//                         → pull chunks → cosine score → merge with hybrid score
//
// Hybrid score: ALPHA * cosine + (1-ALPHA) * predicate_weight
//   Chunks appearing in both paths get the full hybrid boost.
//   Per-source cap (PER_SOURCE_CAP) prevents any single project from dominating.
//
// Wire interface: skill=knowledge, verb=retrieve, payload={ query, topK?, sourceFile? }
//
// Security:
//   - Source file path resolved via realpathSync to defeat symlink traversal
//   - .keys/ guard applied both before and after symlink resolution (double check)
//   - KEYS_DIR constant computed once at module load, never per-call
//   - File size capped at MAX_FILE_BYTES before ingest
//   - Chunk count capped at MAX_CHUNKS_PER_FILE
//   - LIKE query patterns capped at MAX_LIKE_QUERY to prevent scan amplification
//   - triples.db opened read-only — no writes from RAG layer

import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { readFileSync, existsSync, mkdirSync, statSync, realpathSync } from "node:fs";

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 2 * 1024 * 1024;  // 2 MB — prevents accidental binary ingest
const MAX_CHUNKS_PER_FILE = 500;
const CHUNK_SIZE = 1800;                  // characters
const CHUNK_OVERLAP = 200;               // must satisfy CHUNK_OVERLAP < CHUNK_SIZE
const EMBED_DIM = 768;
const MIN_SIMILARITY = 0.45;             // vector path minimum threshold
const MIN_GRAPH_COSINE = 0.25;           // graph path: lower bar since entity anchor already scoped
const MAX_LIKE_QUERY = 512;              // caps LIKE pattern to prevent full-table scan amplification

// ─── Hybrid constants ─────────────────────────────────────────────────────────
const ALPHA = 0.6;          // vector weight; (1-ALPHA) = graph bonus weight
const PER_SOURCE_CAP = 2;   // max chunks per source_file in final merged results

// Invariant: CHUNK_OVERLAP must be less than CHUNK_SIZE — enforced at module load
if (CHUNK_OVERLAP >= CHUNK_SIZE) {
  throw new Error(`RAG config error: CHUNK_OVERLAP (${CHUNK_OVERLAP}) must be < CHUNK_SIZE (${CHUNK_SIZE})`);
}

// .keys/ guard directory — computed once at module load to avoid per-call FS overhead
const KEYS_DIR_RAW = join(import.meta.dir, "../../.keys");

// ─── Predicate weights for graph-first scoring ────────────────────────────────
// Higher = stronger structural relationship signal. has_issue is low because
// it indicates a problem relationship, not a stack/integration match.
const PREDICATE_WEIGHTS: Record<string, number> = {
  uses_stack: 1.0,
  stores_in: 1.0,
  integrates_with: 1.0,
  integrates: 0.9,
  depends_on: 0.8,
  built_with: 0.8,
  routes_to: 0.7,
  provides: 0.4,
  has_issue: 0.3,
};

// ─── Curated entity patterns ──────────────────────────────────────────────────
// Two tiers of entities:
//
// PROJECT entities → direct RAG path lookup (bypass triples).
//   When a query names a project explicitly, pull its chunks directly.
//   Going through triples would use the SOURCE field (where triple was extracted
//   FROM), which is often a DIFFERENT project that merely mentions this one.
//
// TECH entities → triples lookup.
//   When a query names a technology, find which projects use it via triples
//   (subject predicate tech-object). The source field correctly points to the
//   project that was processed, so pulling its chunks finds actual users.
//
// Curated list beats generic NER at a small corpus size.

// Maps normalized entity key → actual directory name in ~/projects/active/
// Only for project-name entities. Casing must match the filesystem path.
// Wire itself is built in; your own projects come from
// .wire-state/project-entities.json (not tracked), e.g.
//   [{ "dir": "my-app", "patterns": ["\\bmy[-\\s]?app\\b"] }]
interface ProjectEntity { dir: string; patterns: string[] }

function loadProjectEntities(): ProjectEntity[] {
  const file = join(import.meta.dir, "../../.wire-state/project-entities.json");
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("expected an array");
    return parsed.filter((e): e is ProjectEntity =>
      typeof e?.dir === "string" && Array.isArray(e?.patterns) && e.patterns.every((p: unknown) => typeof p === "string"));
  } catch (e) {
    console.warn(`[rag] ignoring .wire-state/project-entities.json: ${(e as Error).message}`);
    return [];
  }
}

const USER_PROJECTS = loadProjectEntities();

const PROJECT_ENTITY_PATHS: Record<string, string> = {
  "agent-wire": "agent-wire",
  ...Object.fromEntries(USER_PROJECTS.map(p => [p.dir, p.dir])),
};

const ENTITY_PATTERNS: Array<{ re: RegExp; key: string }> = [
  // project names (→ PROJECT_ENTITY_PATHS for direct path lookup)
  { re: /\bagent[-\s]?wire\b/i,          key: "agent-wire" },
  ...USER_PROJECTS.flatMap(p => p.patterns.map(src => ({ re: new RegExp(src, "i"), key: p.dir }))),
  // tech stack (→ triples lookup to find which projects use them)
  { re: /\bollama\b/i,                   key: "ollama" },
  { re: /\bgemini\b/i,                   key: "gemini" },
  { re: /\bsqlite\b/i,                   key: "sqlite" },
  { re: /\bfastapi\b/i,                  key: "fastapi" },
  { re: /\bstreamlit\b/i,               key: "streamlit" },
  { re: /\bpinterest\b/i,               key: "pinterest" },
  { re: /\bperplexity\b/i,              key: "perplexity" },
  { re: /\btypescript\b/i,              key: "typescript" },
  { re: /\bpython\b/i,                  key: "python" },
  // wire components (→ triples lookup)
  { re: /\bwire\s*protocol\b/i,         key: "wireprotocol" },
  { re: /\bwire\s*agent\b/i,            key: "wireagent" },
  { re: /\bdispatch\s*loop\b/i,         key: "dispatch" },
  { re: /\bgateway\b/i,                 key: "gateway" },
  { re: /\bclassifier\b/i,              key: "classifier" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RagChunk {
  id: number;
  source_file: string;
  chunk_index: number;
  content: string;
  created_at: number;
}

export interface RagResult {
  id: number;
  source_file: string;
  chunk_index: number;
  content: string;
  score: number;
  fallback: boolean;      // true = keyword-based result; score is synthetic 0.5
  graphMatch?: boolean;   // true = this chunk was found via the graph-first path
  created_at: number;
}

export interface IngestReport {
  sourceFile: string;
  chunks: number;
  embedded: number;    // chunks that got a vector (Ollama available)
  skipped: number;     // chunks that failed embedding (stored without vector)
  replaced: boolean;   // true if prior version was deleted before ingest
}

// ─── Embedding ────────────────────────────────────────────────────────────────

import { OLLAMA_URL, EMBED_MODEL } from "../config/models.js";

async function embed(text: string): Promise<Float32Array | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[rag] embed: Ollama HTTP ${res.status} — falling back to keyword search`);
      return null;
    }
    const data = await res.json() as { embedding?: number[] };
    if (!data.embedding) {
      console.warn(`[rag] embed: Ollama response missing 'embedding' field — falling back to keyword search`);
      return null;
    }
    if (data.embedding.length !== EMBED_DIM) {
      console.warn(`[rag] embed: dimension mismatch (expected ${EMBED_DIM}, got ${data.embedding.length}) — check EMBED_MODEL config`);
      return null;
    }
    return new Float32Array(data.embedding);
  } catch (e) {
    console.warn(`[rag] embed: fetch failed (${(e as Error).message}) — falling back to keyword search`);
    return null;
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

// ─── Chunking ─────────────────────────────────────────────────────────────────

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let pos = 0;

  while (pos < text.length) {
    let end = pos + CHUNK_SIZE;

    if (end < text.length) {
      // Prefer to break at a paragraph boundary within the last 20% of chunk
      const searchFrom = pos + Math.floor(CHUNK_SIZE * 0.8);
      const paraBreak = text.indexOf("\n\n", searchFrom);
      if (paraBreak !== -1 && paraBreak < end) {
        end = paraBreak + 2;
      } else {
        // Fall back to line break
        const lineBreak = text.lastIndexOf("\n", end);
        if (lineBreak > pos + Math.floor(CHUNK_SIZE * 0.5)) end = lineBreak + 1;
      }
    } else {
      end = text.length;
    }

    const chunk = text.slice(pos, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (chunks.length >= MAX_CHUNKS_PER_FILE) break;
    if (end >= text.length) break;

    pos = Math.max(pos + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
}

// ─── Entity extraction ────────────────────────────────────────────────────────

function extractEntities(query: string): string[] {
  const found = new Set<string>();
  for (const { re, key } of ENTITY_PATTERNS) {
    if (re.test(query)) found.add(key);
  }
  return Array.from(found);
}

// ─── RagStore ─────────────────────────────────────────────────────────────────

export class RagStore {
  private db: Database;
  private graphDb: Database | null;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "rag.db"));
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rag_chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file  TEXT NOT NULL,
        chunk_index  INTEGER NOT NULL,
        content      TEXT NOT NULL,
        embedding    BLOB,
        created_at   INTEGER NOT NULL,
        UNIQUE(source_file, chunk_index)
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_rag_source ON rag_chunks(source_file)`);

    // Open triples DB read-only for graph-first path — silently skip if not present
    const triplesPath = join(stateDir, "triples.db");
    if (existsSync(triplesPath)) {
      try {
        this.graphDb = new Database(triplesPath, { readonly: true });
      } catch (e) {
        console.warn(`[rag] triples.db open failed: ${(e as Error).message} — graph path disabled`);
        this.graphDb = null;
      }
    } else {
      this.graphDb = null;
    }
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  async ingest(filePath: string): Promise<IngestReport> {
    // Resolve .keys/ guard path — null when .keys/ doesn't exist (no keys to protect)
    const resolvedKeysDir = existsSync(KEYS_DIR_RAW) ? realpathSync(KEYS_DIR_RAW) : null;

    // Stage 1: string-normalized path for initial .keys/ check (catches non-symlink paths)
    const normalizedPath = resolve(filePath);
    if (resolvedKeysDir) {
      if (normalizedPath === resolvedKeysDir || normalizedPath.startsWith(resolvedKeysDir + "/")) {
        throw new Error(`Refusing to ingest files from .keys/ — private key files must never be stored in the RAG database`);
      }
    }

    if (!existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    // Stage 2: canonical path via realpathSync — resolves all symlinks
    const resolvedPath = realpathSync(normalizedPath);
    if (resolvedKeysDir) {
      if (resolvedPath === resolvedKeysDir || resolvedPath.startsWith(resolvedKeysDir + "/")) {
        throw new Error(`Refusing to ingest files from .keys/ — path resolved via symlink to protected directory`);
      }
    }

    // Secrets and Wire's own state never go into the embedding store, wherever
    // they live and however the path reached them.
    const base = resolvedPath.split("/").pop() ?? "";
    if ((/^\.env(\..+)?$/.test(base) && base !== ".env.example") || /\/\.(wire-state|keys)(\/|$)/.test(resolvedPath)) {
      throw new Error(`Refusing to ingest ${base} — secrets and Wire state must never be stored in the RAG database`);
    }

    const stat = statSync(resolvedPath);
    if (!stat.isFile()) throw new Error(`Not a file: ${resolvedPath}`);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`File too large: ${stat.size} bytes (max ${MAX_FILE_BYTES}). Use a subset or split the file.`);
    }

    const text = readFileSync(resolvedPath, "utf8");
    const chunks = chunkText(text);

    // Remove prior version of this file before re-ingesting
    const existing = this.db.query(
      "SELECT COUNT(*) as n FROM rag_chunks WHERE source_file = ?"
    ).get(resolvedPath) as { n: number };
    const replaced = existing.n > 0;
    if (replaced) {
      this.db.run("DELETE FROM rag_chunks WHERE source_file = ?", [resolvedPath]);
    }

    let embedded = 0;
    let skipped = 0;
    const now = Date.now();

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const vec = await embed(chunk);
      if (vec) embedded++; else skipped++;

      const blob = vec ? Buffer.from(vec.buffer) : null;
      this.db.run(
        "INSERT OR REPLACE INTO rag_chunks (source_file, chunk_index, content, embedding, created_at) VALUES (?,?,?,?,?)",
        [resolvedPath, i, chunk, blob, now]
      );
    }

    return { sourceFile: resolvedPath, chunks: chunks.length, embedded, skipped, replaced };
  }

  // ── retrieve ──────────────────────────────────────────────────────────────

  async retrieve(opts: {
    query: string;
    topK?: number;
    sourceFile?: string;
  }): Promise<RagResult[]> {
    const topK = opts.topK ?? 5;
    const queryVec = await embed(opts.query);

    if (!queryVec) {
      console.warn(`[rag] retrieve: embedding unavailable — using keyword fallback`);
      return this.keywordFallback(opts.query, topK, opts.sourceFile);
    }

    // Run both paths in parallel — graph path silently returns [] if triples.db absent
    const [vectorResults, graphResults] = await Promise.all([
      Promise.resolve(this.vectorPath(queryVec, topK * 2, opts.sourceFile)),
      this.graphFirstPath(opts.query, queryVec, topK * 2),
    ]);

    return this.mergeAndRank(vectorResults, graphResults, topK);
  }

  // ── vector path (Path A) ──────────────────────────────────────────────────

  private vectorPath(queryVec: Float32Array, limit: number, sourceFile?: string): RagResult[] {
    const whereClause = sourceFile
      ? "WHERE source_file = ? AND embedding IS NOT NULL"
      : "WHERE embedding IS NOT NULL";
    const params: (string | number | boolean | null)[] = sourceFile ? [sourceFile] : [];

    const rows = this.db.query(
      `SELECT id, source_file, chunk_index, content, embedding, created_at FROM rag_chunks ${whereClause}`
    ).all(...params) as Record<string, unknown>[];

    const scored: RagResult[] = [];
    for (const r of rows) {
      const blob = r["embedding"] as Buffer | null;
      if (!blob) continue;
      const vec = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      const score = cosineSimilarity(queryVec, vec);
      if (score >= MIN_SIMILARITY) {
        scored.push({
          id: r["id"] as number,
          source_file: r["source_file"] as string,
          chunk_index: r["chunk_index"] as number,
          content: r["content"] as string,
          score,
          fallback: false,
          created_at: r["created_at"] as number,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ── graph-first path (Path B) ─────────────────────────────────────────────

  private async graphFirstPath(
    query: string,
    queryVec: Float32Array,
    limit: number,
  ): Promise<Array<RagResult & { _predicateWeight: number }>> {
    if (!this.graphDb) return [];

    const entities = extractEntities(query);
    if (entities.length === 0) return [];

    // projectDir → best predicate weight
    // "projectDir" is the actual directory name segment in source_file paths
    const projectWeights = new Map<string, number>();

    for (const entity of entities) {
      if (entity in PROJECT_ENTITY_PATHS) {
        // Project-name entity: direct path lookup — bypass triples entirely.
        // Triples that mention a project (e.g. "agent-wire depends_on my-crypto-lib")
        // have source pointing to the MENTIONING project, not the mentioned one.
        // Direct lookup avoids this mismatch.
        const projectDir = PROJECT_ENTITY_PATHS[entity]!;
        const existing = projectWeights.get(projectDir) ?? 0;
        if (existing < 1.0) projectWeights.set(projectDir, 1.0);
      } else {
        // Tech entity: use triples to find which projects use this technology.
        // The source field here correctly points to the project that was processed
        // and whose context pack mentioned this tech in a uses_stack/integrates_with triple.
        const likePattern = `%${entity}%`;
        let rows: Array<{ source: string; predicate: string }>;
        try {
          rows = this.graphDb.query(
            `SELECT source, predicate FROM triples
             WHERE (lower(subject) LIKE ? OR lower(object) LIKE ?)
             LIMIT 50`
          ).all(likePattern, likePattern) as Array<{ source: string; predicate: string }>;
        } catch {
          continue;
        }

        for (const row of rows) {
          // source format: "llm:gemini/agent-wire" or "rules:agent-wire"
          const projectDir = row.source.split("/").pop() ?? "";
          if (!projectDir) continue;
          const weight = PREDICATE_WEIGHTS[row.predicate] ?? 0.2;
          const existing = projectWeights.get(projectDir) ?? 0;
          if (weight > existing) projectWeights.set(projectDir, weight);
        }
      }
    }

    if (projectWeights.size === 0) return [];

    // Pull chunks for each matched project, score with cosine
    const results: Array<RagResult & { _predicateWeight: number }> = [];

    for (const [projectName, predicateWeight] of projectWeights) {
      const likePattern = `%/${projectName}/%`;
      const rows = this.db.query(
        `SELECT id, source_file, chunk_index, content, embedding, created_at
         FROM rag_chunks WHERE source_file LIKE ? AND embedding IS NOT NULL`
      ).all(likePattern) as Record<string, unknown>[];

      for (const r of rows) {
        const blob = r["embedding"] as Buffer | null;
        if (!blob) continue;
        const vec = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
        const cosine = cosineSimilarity(queryVec, vec);
        if (cosine < MIN_GRAPH_COSINE) continue;

        results.push({
          id: r["id"] as number,
          source_file: r["source_file"] as string,
          chunk_index: r["chunk_index"] as number,
          content: r["content"] as string,
          score: cosine,
          fallback: false,
          graphMatch: true,
          created_at: r["created_at"] as number,
          _predicateWeight: predicateWeight,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ── merge and re-rank ─────────────────────────────────────────────────────

  private mergeAndRank(
    vectorResults: RagResult[],
    graphResults: Array<RagResult & { _predicateWeight: number }>,
    topK: number,
  ): RagResult[] {
    // Map chunk id → best hybrid score + merged result
    const merged = new Map<number, RagResult & { _hybridScore: number }>();

    // Seed from vector path: hybridScore = ALPHA * cosine (no graph bonus yet)
    for (const r of vectorResults) {
      merged.set(r.id, { ...r, _hybridScore: ALPHA * r.score });
    }

    // Overlay graph path: boost matching chunks, add new ones
    for (const r of graphResults) {
      const graphHybrid = ALPHA * r.score + (1 - ALPHA) * r._predicateWeight;
      if (merged.has(r.id)) {
        // Chunk in both paths — take higher of the two scores
        const existing = merged.get(r.id)!;
        const boosted = Math.max(existing._hybridScore, graphHybrid);
        merged.set(r.id, { ...existing, _hybridScore: boosted, graphMatch: true });
      } else {
        // Graph-only chunk
        const { _predicateWeight: _, ...base } = r;
        merged.set(r.id, { ...base, _hybridScore: graphHybrid });
      }
    }

    // Sort by hybrid score
    const all = Array.from(merged.values()).sort((a, b) => b._hybridScore - a._hybridScore);

    // Apply per-source cap and emit final results with hybrid score as `.score`
    const sourceCounts = new Map<string, number>();
    const results: RagResult[] = [];

    for (const entry of all) {
      const count = sourceCounts.get(entry.source_file) ?? 0;
      if (count >= PER_SOURCE_CAP) continue;
      sourceCounts.set(entry.source_file, count + 1);

      const { _hybridScore, ...rest } = entry;
      results.push({ ...rest, score: _hybridScore });

      if (results.length >= topK) break;
    }

    return results;
  }

  // ── list ingested files ───────────────────────────────────────────────────

  listFiles(): Array<{ sourceFile: string; chunks: number; ingestedAt: number }> {
    const rows = this.db.query(
      "SELECT source_file, COUNT(*) as chunks, MIN(created_at) as ingested_at FROM rag_chunks GROUP BY source_file ORDER BY ingested_at DESC"
    ).all() as Array<{ source_file: string; chunks: number; ingested_at: number }>;
    return rows.map(r => ({ sourceFile: r.source_file, chunks: r.chunks, ingestedAt: r.ingested_at }));
  }

  // ── remove a file's chunks ────────────────────────────────────────────────

  remove(filePath: string): number {
    const resolvedPath = resolve(filePath);
    const result = this.db.run("DELETE FROM rag_chunks WHERE source_file = ?", [resolvedPath]);
    return result.changes;
  }

  // ── keyword fallback (no embedding) ──────────────────────────────────────

  private keywordFallback(query: string, topK: number, sourceFile?: string): RagResult[] {
    // Cap LIKE pattern length to prevent full-table scan amplification on large payloads
    const likeQuery = query.slice(0, MAX_LIKE_QUERY);
    const whereClause = sourceFile
      ? "WHERE source_file = ? AND content LIKE ?"
      : "WHERE content LIKE ?";
    const params: (string | number | boolean | null)[] = sourceFile
      ? [sourceFile, `%${likeQuery}%`]
      : [`%${likeQuery}%`];

    const rows = this.db.query(
      `SELECT id, source_file, chunk_index, content, created_at FROM rag_chunks ${whereClause} LIMIT ?`
    ).all(...params, topK) as Record<string, unknown>[];

    return rows.map(r => ({
      id: r["id"] as number,
      source_file: r["source_file"] as string,
      chunk_index: r["chunk_index"] as number,
      content: r["content"] as string,
      score: 0.5,      // synthetic value — not semantic similarity; check r.fallback to detect keyword results
      fallback: true,
      created_at: r["created_at"] as number,
    }));
  }
}
