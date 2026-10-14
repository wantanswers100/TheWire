// ToolRegistry — singleton tool store + test factory
//
// Use createToolRegistry() in tests to get isolated instances.
// Use ToolRegistry.instance() in production code (builtins auto-registered on first call).

import type { ToolDefinition, ToolCallRequest, ToolCallResult } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private static _instance: ToolRegistry | null = null;

  // Production singleton — builtins registered once on first call
  static instance(): ToolRegistry {
    if (!ToolRegistry._instance) {
      ToolRegistry._instance = new ToolRegistry();
      registerBuiltins(ToolRegistry._instance);
    }
    return ToolRegistry._instance;
  }

  // Test factory — fresh instance per call, no shared state
  static create(): ToolRegistry {
    return new ToolRegistry();
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  list(enabledOnly = true): ToolDefinition[] {
    const all = [...this.tools.values()];
    return enabledOnly ? all.filter(t => t.enabled) : all;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // dispatch() — executes a tool. Blocks HITL tools; use dispatchApproved() after user consent.
  async dispatch(req: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.tools.get(req.tool);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${req.tool}`, requestId: req.requestId };
    }
    if (!tool.enabled) {
      return { ok: false, error: `Tool disabled: ${req.tool}`, requestId: req.requestId };
    }
    if (tool.requiresHitl) {
      return {
        ok: false,
        error: `Tool '${req.tool}' requires HITL approval before execution. Use dispatchApproved() after obtaining user consent.`,
        requestId: req.requestId,
      };
    }
    return this._execute(tool, req);
  }

  // dispatchApproved() — bypass HITL guard after explicit user approval has been obtained.
  // Callers MUST have shown the command to the user and received confirmation before calling this.
  async dispatchApproved(req: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.tools.get(req.tool);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${req.tool}`, requestId: req.requestId };
    }
    if (!tool.enabled) {
      return { ok: false, error: `Tool disabled: ${req.tool}`, requestId: req.requestId };
    }
    return this._execute(tool, req);
  }

  private async _execute(tool: ToolDefinition, req: ToolCallRequest): Promise<ToolCallResult> {
    try {
      const result = await tool.execute(req.args);
      if (result.ok) {
        return { ok: true, output: result.output, requestId: req.requestId };
      }
      return { ok: false, error: result.error, requestId: req.requestId };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        requestId: req.requestId,
      };
    }
  }
}

// Register all builtin tools onto a registry instance.
// Imported here to avoid circular deps — builtins import types, not ToolRegistry.
function registerBuiltins(registry: ToolRegistry): void {
  // Dynamic imports at call time — avoids module-load-order issues
  Promise.all([
    import("./builtin/ShellTool.js"),
    import("./builtin/MemorySearchTool.js"),
    import("./builtin/FileReadTool.js"),
    import("./builtin/CodeReviewTool.js"),
    import("./builtin/LiveSearchTool.js"),
  ]).then(([{ ShellTool }, { MemorySearchTool }, { FileReadTool }, { CodeReviewTool }, { LiveSearchTool }]) => {
    for (const tool of [ShellTool, MemorySearchTool, FileReadTool, CodeReviewTool, LiveSearchTool]) {
      if (!registry.has(tool.name)) registry.register(tool);
    }
  }).catch(err => {
    console.warn("[ToolRegistry] failed to register builtins:", err instanceof Error ? err.message : String(err));
  });
}
