// ToolRouter — resolves tool calls: Wire builtins → MCP clients
//
// Resolution order:
//   1. Wire built-in ToolRegistry (ShellTool, MemorySearchTool, etc.)
//   2. MCP clients via McpClientRegistry
//
// HITL propagation: if tool.requiresHitl=true, caller must gate before execution.

import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { McpClientRegistry } from "../mcp/client/McpClientRegistry.js";
import type { ToolCallResult } from "../tools/types.js";

export interface ResolvedTool {
  name: string;
  requiresHitl: boolean;
  source: "builtin" | "mcp";
  clientName?: string;      // set when source="mcp"
}

export class ToolRouter {
  private registry: ToolRegistry;
  private mcpRegistry: McpClientRegistry | null;

  constructor(registry: ToolRegistry, mcpRegistry: McpClientRegistry | null = null) {
    this.registry = registry;
    this.mcpRegistry = mcpRegistry;
  }

  // Find a tool by name — builtin first, MCP second
  resolve(name: string): ResolvedTool | null {
    const builtin = this.registry.get(name);
    if (builtin) {
      return { name, requiresHitl: builtin.requiresHitl, source: "builtin" };
    }

    if (this.mcpRegistry) {
      const found = this.mcpRegistry.findTool(name);
      if (found) {
        return {
          name,
          requiresHitl: found.tool.requiresHitl,
          source: "mcp",
          clientName: found.client.config.name,
        };
      }
    }

    return null;
  }

  // call() — routes non-HITL tools. HITL tools return error; use callApproved() after consent.
  async call(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const resolved = this.resolve(name);
    if (!resolved) {
      return { ok: false, error: `ToolRouter: no tool found: ${name}` };
    }

    if (resolved.source === "builtin") {
      return this.registry.dispatch({ tool: name, args });
    }

    // MCP path
    if (!this.mcpRegistry) {
      return { ok: false, error: `ToolRouter: MCP registry not available` };
    }
    const found = this.mcpRegistry.findTool(name);
    if (!found) {
      return { ok: false, error: `ToolRouter: MCP tool '${name}' not found` };
    }

    try {
      const output = await found.client.callTool(name, args);
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // callApproved() — execute a HITL tool after explicit user approval.
  async callApproved(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const resolved = this.resolve(name);
    if (!resolved) {
      return { ok: false, error: `ToolRouter: no tool found: ${name}` };
    }
    if (resolved.source === "builtin") {
      return this.registry.dispatchApproved({ tool: name, args });
    }
    // MCP tools go through standard call path (MCP server owns its own approval)
    return this.call(name, args);
  }

  // All available tools (builtin + MCP)
  listAll(): ResolvedTool[] {
    const all: ResolvedTool[] = this.registry.list().map(t => ({
      name: t.name,
      requiresHitl: t.requiresHitl,
      source: "builtin" as const,
    }));

    if (this.mcpRegistry) {
      for (const { clientName, tool } of this.mcpRegistry.allTools()) {
        if (!all.find(t => t.name === tool.name)) {
          all.push({ name: tool.name, requiresHitl: tool.requiresHitl, source: "mcp", clientName });
        }
      }
    }

    return all;
  }
}
