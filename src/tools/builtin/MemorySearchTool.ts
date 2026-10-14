// MemorySearchTool — search the Wire memory store from within a tool call

import { MemoryStore } from "../../agents/memory.js";
import type { ToolDefinition, ToolCallResult } from "../types.js";
// ISS-031: sourced from config/paths.ts.
import { STATE_DIR } from "../../config/paths.js";

export const MemorySearchTool: ToolDefinition = {
  name: "memory_search",
  description: "Search the Wire memory store for relevant past context, task logs, or observations.",
  requiresHitl: false,
  enabled: true,
  parameters: {
    query: {
      type: "string",
      description: "Search query",
      required: true,
    },
    topK: {
      type: "number",
      description: "Maximum results to return (default: 5)",
      required: false,
    },
    category: {
      type: "string",
      description: "Filter by category: conversation|task_log|project_state|preference|observation",
      required: false,
    },
  },
  async execute(args): Promise<ToolCallResult> {
    const query = args["query"];
    if (typeof query !== "string" || !query.trim()) {
      return { ok: false, error: "memory_search: query must be a non-empty string" };
    }

    const topK = typeof args["topK"] === "number" ? Math.min(args["topK"], 20) : 5;

    try {
      const store = new MemoryStore(STATE_DIR);
      const results = await store.search({ query, topK, category: args["category"] as never });
      if (results.length === 0) {
        return { ok: true, output: "No matching memory entries found." };
      }
      const output = results
        .map((r, i) => `[${i + 1}] ${r.key} (${r.category}, score=${r.score.toFixed(2)}): ${r.value.slice(0, 300)}`)
        .join("\n\n");
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
