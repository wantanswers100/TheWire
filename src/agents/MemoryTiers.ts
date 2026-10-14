// MemoryTiers — 3-tier memory enrichment for Wire dispatch
//
// Three tiers with different storage/retrieval strategies:
//   Working  — in-flight task state, in-process Map, cleared after task completes
//   Episodic — recent task outcomes, recency-weighted, via MemoryStore.search()
//   Semantic — domain knowledge via existing RAG (RagStore.retrieve())
//
// All functions are tolerant: failure returns "" rather than throwing.
// Callers compose the result; empty strings are filtered before joining.

import type { MemoryStore } from "./memory.js";
import type { RagStore } from "./rag.js";
import { isContextRefusal } from "../dispatch/refusal.js";

// ─── Working memory ───────────────────────────────────────────────────────────
// In-flight task state stored in the caller-provided Map.
// Key: taskId → Map<string, unknown> of key/value pairs for that task.
// No DB — lives only in process memory. Caller clears after task completes.

export function queryWorking(
  taskId: string,
  store: Map<string, Map<string, unknown>>
): string {
  const taskMap = store.get(taskId);
  if (!taskMap || taskMap.size === 0) return "";

  const parts: string[] = [];
  for (const [key, value] of taskMap) {
    const valStr = typeof value === "string"
      ? value
      : JSON.stringify(value);
    parts.push(`${key}=${valStr}`);
  }
  return `Working context: ${parts.join(" ")}`;
}

// ─── Episodic memory ──────────────────────────────────────────────────────────
// Recent task outcomes from MemoryStore (task_log category), recency-weighted
// by the store's own scoring. NOT embedded — keyword/semantic search only.

export async function queryEpisodic(
  query: string,
  memory: MemoryStore
): Promise<string> {
  if (!query.trim()) return "";
  try {
    const results = await memory.search({ query, topK: 5 });
    if (results.length === 0) return "";

    const lines: string[] = [];
    for (const r of results) {
      let subject = r.key;
      let resultExcerpt = "";
      try {
        const raw: unknown = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          const obj = raw as Record<string, unknown>;
          subject = String(obj["skill"] ?? r.key);
          const summary = String(obj["resultSummary"] ?? "");
          // Don't recycle failures or context-refusals as context — they
          // taught later tasks to refuse too (2026-09-22 learning-loop fix).
          if (obj["status"] === "failed" || isContextRefusal(summary)) continue;
          resultExcerpt = summary.slice(0, 100);
        }
      } catch {
        resultExcerpt = String(r.value).slice(0, 100);
      }
      const line = resultExcerpt
        ? `[${subject}] → ${resultExcerpt}`
        : `[${subject}]`;
      lines.push(line);
    }
    if (lines.length === 0) return "";
    return `Previous similar tasks: ${lines.join(", ")}`;
  } catch (e) {
    console.warn(`[memory-tiers] episodic query failed: ${(e as Error).message}`);
    return "";
  }
}

// ─── Semantic memory ──────────────────────────────────────────────────────────
// Domain knowledge via RagStore.retrieve() — same retrieval path used by the
// wire-agent for skill=knowledge, but ungated from skill type.

export async function querySemantic(
  query: string,
  rag: RagStore
): Promise<string> {
  if (!query.trim()) return "";
  try {
    const results = await rag.retrieve({ query });
    if (results.length === 0) return "";

    const lines: string[] = [];
    for (const r of results) {
      const scoreLabel = r.fallback ? "keyword" : `${(r.score * 100).toFixed(0)}%`;
      const filename = r.source_file.split("/").pop() ?? r.source_file;
      lines.push(`[${scoreLabel} — ${filename}] ${r.content.slice(0, 400)}`);
    }
    return lines.join("\n");
  } catch (e) {
    console.warn(`[memory-tiers] semantic query failed: ${(e as Error).message}`);
    return "";
  }
}
