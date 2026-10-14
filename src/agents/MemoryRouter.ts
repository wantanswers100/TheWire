// MemoryRouter — hybrid search: FTS5 + semantic cosine, merged and ranked
//
// Combines FTS5 (BM25) and embedding-based cosine similarity.
// Deduplicates by id. Result carries source tag for caller transparency.

import type { MemoryCategory, SearchResult } from "./memory.js";

export type SearchSource = "fts" | "semantic" | "both" | "keyword";

export interface RoutedResult extends SearchResult {
  source: SearchSource;
}

// Merge FTS5 results with semantic results into a unified ranked list.
// - Both score fields are already normalized to [0,1].
// - Combined score = max(fts_score, semantic_score) with "both" bonus.
export function mergeResults(
  ftsResults: Array<{ id: number; key: string; value: string; category: MemoryCategory; tags: string | string[]; score: number }>,
  semanticResults: SearchResult[],
  keywordResults: SearchResult[],
  topK: number,
): RoutedResult[] {
  const map = new Map<number, RoutedResult>();

  // Keyword results — lowest priority, score=1.0 literal
  for (const r of keywordResults) {
    map.set(r.id, { ...r, tags: Array.isArray(r.tags) ? r.tags : parseTags(r.tags as unknown as string), source: "keyword" });
  }

  // FTS5 results
  for (const r of ftsResults) {
    const tags = Array.isArray(r.tags) ? r.tags : parseTags(r.tags);
    const existing = map.get(r.id);
    if (existing) {
      existing.score = Math.min(1.0, Math.max(existing.score, r.score) + 0.05);
      existing.source = "both";
    } else {
      map.set(r.id, { id: r.id, key: r.key, value: r.value, category: r.category, tags, score: r.score, created_at: 0, source: "fts" });
    }
  }

  // Semantic results
  for (const r of semanticResults) {
    const existing = map.get(r.id);
    if (existing) {
      const combined = Math.min(1.0, Math.max(existing.score, r.score) + 0.05);
      existing.score = combined;
      existing.source = existing.source === "fts" || existing.source === "both" ? "both" : "semantic";
    } else {
      map.set(r.id, { ...r, source: "semantic" });
    }
  }

  return [...map.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
