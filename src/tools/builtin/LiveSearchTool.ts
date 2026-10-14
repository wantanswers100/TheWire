// LiveSearchTool — web search via Gemini (gemini-live.ts adapter)
// Falls back gracefully when GEMINI_API_KEY is absent.

import type { ToolDefinition, ToolCallResult } from "../types.js";

export const LiveSearchTool: ToolDefinition = {
  name: "live_search",
  description: "Search the web for current information. Requires GEMINI_API_KEY.",
  requiresHitl: false,
  enabled: true,
  parameters: {
    query: {
      type: "string",
      description: "Search query",
      required: true,
    },
  },
  async execute(args): Promise<ToolCallResult> {
    const query = args["query"];
    if (typeof query !== "string" || !query.trim()) {
      return { ok: false, error: "live_search: query must be a non-empty string" };
    }

    const { callGeminiLive } = await import("../../agents/gemini-live.js");
    try {
      const { text } = await callGeminiLive(query, process.cwd());
      return { ok: true, output: text.slice(0, 4000) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
