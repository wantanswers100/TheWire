// ToolManifest — cached system-prompt block describing available tools
//
// Dirty-flag invalidation: rebuilt whenever a tool is registered/enabled/disabled.
// toSystemPromptBlock() returns the manifest as a formatted string for injection
// into LLM prompts (buildPrompt in workers.ts).

import type { ToolRegistry } from "./ToolRegistry.js";

export class ToolManifest {
  private registry: ToolRegistry;
  private _cached: string | null = null;
  private _dirty = true;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  invalidate(): void {
    this._dirty = true;
    this._cached = null;
  }

  toSystemPromptBlock(): string {
    if (!this._dirty && this._cached !== null) return this._cached;

    const tools = this.registry.list(true);
    if (tools.length === 0) {
      this._cached = "";
      this._dirty = false;
      return "";
    }

    const lines: string[] = [
      "## Available Tools",
      "To use a tool, respond with a JSON object on its own line:",
      '{"tool": "<name>", "args": {...}}',
      "",
    ];

    for (const t of tools) {
      lines.push(`### ${t.name}${t.requiresHitl ? " [requires approval]" : ""}`);
      lines.push(t.description);
      if (Object.keys(t.parameters).length > 0) {
        lines.push("Parameters:");
        for (const [key, schema] of Object.entries(t.parameters)) {
          const req = schema.required ? " (required)" : " (optional)";
          lines.push(`  ${key}: ${schema.type}${req} — ${schema.description ?? ""}`);
        }
      }
      lines.push("");
    }

    this._cached = lines.join("\n");
    this._dirty = false;
    return this._cached;
  }

  // Number of enabled tools
  size(): number {
    return this.registry.list(true).length;
  }

}
