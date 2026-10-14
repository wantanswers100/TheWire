// ResultMerger — synthesize parallel subtask results into a coherent answer
//
// Uses qwen3:4b with /no_think (ISS-021) to avoid stalling.
// Always fire-and-forget safe: called inside an awaited block with try/catch.

import { OLLAMA_URL } from "../config/models.js";
import type { SubtaskResult } from "./parallel-types.js";

const MERGE_MODEL = "qwen3:4b";
const TIMEOUT_MS = 30_000;

export class ResultMerger {
  async merge(results: SubtaskResult[]): Promise<string> {
    if (results.length === 0) return "";
    if (results.length === 1) return results[0]!.output ?? "";

    const snippets = results
      .filter(r => r.output)
      .map((r, i) => `[Task ${i + 1}: ${r.subject}]\n${r.output!.slice(0, 600)}`)
      .join("\n\n---\n\n");

    const prompt =
      `You received ${results.length} parallel task results. Synthesize them into one coherent answer.\n\n` +
      `${snippets}\n\n` +
      `Write a unified response that captures all key points without redundancy. /no_think`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MERGE_MODEL, prompt, stream: false, think: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return snippets; // fall back to raw concatenation
      const data = await res.json() as { response?: string };
      return data.response?.trim() ?? snippets;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("abort") && !msg.includes("AbortError")) {
        console.warn(`[parallel] ResultMerger failed: ${msg.slice(0, 120)}`);
      }
      return snippets;
    }
  }
}
