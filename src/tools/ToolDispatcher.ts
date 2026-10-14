// ToolDispatcher — parse LLM tool-use output and route to ToolRegistry
//
// Providers emit tool calls differently:
//   Claude API  — structured JSON (tool_use content block)
//   Ollama/qwen — free-text JSON object on its own line: {"tool":"...","args":{...}}
//   Gemini      — functionCall field in response
//
// ToolDispatcher unifies all three into ToolCallRequest[].

import type { ToolRegistry } from "./ToolRegistry.js";
import type { ToolCallRequest, ToolCallResult } from "./types.js";

export class ToolDispatcher {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  // Parse free-text LLM output and extract tool calls (Ollama / qwen pattern)
  parseFromText(text: string): ToolCallRequest[] {
    const requests: ToolCallRequest[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof obj["tool"] === "string" && typeof obj["args"] === "object") {
          requests.push({
            tool: obj["tool"],
            args: (obj["args"] as Record<string, unknown>) ?? {},
            requestId: obj["requestId"] as string | undefined,
          });
        }
      } catch {
        // Not valid JSON — skip
      }
    }
    return requests;
  }

  // Parse structured Claude API tool_use block
  parseFromClaudeBlock(block: Record<string, unknown>): ToolCallRequest | null {
    if (block["type"] !== "tool_use") return null;
    const name = block["name"] as string | undefined;
    const input = block["input"] as Record<string, unknown> | undefined;
    if (!name || !input) return null;
    return { tool: name, args: input, requestId: block["id"] as string | undefined };
  }

  // Parse Gemini functionCall field
  parseFromGeminiCall(call: Record<string, unknown>): ToolCallRequest | null {
    const name = call["name"] as string | undefined;
    const args = call["args"] as Record<string, unknown> | undefined;
    if (!name || !args) return null;
    return { tool: name, args };
  }

  // Execute all parsed requests, returning results in order
  async executeAll(requests: ToolCallRequest[]): Promise<ToolCallResult[]> {
    return Promise.all(requests.map(req => this.registry.dispatch(req)));
  }

  // Check if text contains any tool call
  hasToolCall(text: string): boolean {
    return this.parseFromText(text).length > 0;
  }
}
