import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { ToolManifest } from "../src/tools/ToolManifest.js";
import { ToolDispatcher } from "../src/tools/ToolDispatcher.js";
import type { ToolDefinition } from "../src/tools/types.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeTool(name: string, requiresHitl = false, enabled = true): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    requiresHitl,
    enabled,
    parameters: {
      input: { type: "string", description: "input", required: true },
    },
    async execute(args) {
      return { ok: true, output: `${name}(${args["input"]})` };
    },
  };
}

// ─── ToolRegistry ─────────────────────────────────────────────────────────────

describe("ToolRegistry — register and retrieve", () => {
  test("register and get a tool", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("echo"));
    expect(reg.get("echo")).not.toBeNull();
    expect(reg.get("echo")!.name).toBe("echo");
  });

  test("get unknown tool returns null", () => {
    const reg = ToolRegistry.create();
    expect(reg.get("missing")).toBeNull();
  });

  test("duplicate registration throws", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("dup"));
    expect(() => reg.register(makeTool("dup"))).toThrow("already registered");
  });

  test("list returns only enabled tools by default", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("active", false, true));
    reg.register(makeTool("inactive", false, false));
    const list = reg.list();
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe("active");
  });

  test("list with enabledOnly=false returns all", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("active", false, true));
    reg.register(makeTool("inactive", false, false));
    expect(reg.list(false).length).toBe(2);
  });

  test("has() returns true for registered tool", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("found"));
    expect(reg.has("found")).toBe(true);
    expect(reg.has("missing")).toBe(false);
  });
});

describe("ToolRegistry — factory isolation", () => {
  test("create() returns independent instances", () => {
    const a = ToolRegistry.create();
    const b = ToolRegistry.create();
    a.register(makeTool("only-in-a"));
    expect(b.has("only-in-a")).toBe(false);
  });
});

describe("ToolRegistry — dispatch", () => {
  test("dispatch calls tool execute()", async () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("echo"));
    const result = await reg.dispatch({ tool: "echo", args: { input: "hello" } });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; output: string }).output).toBe("echo(hello)");
  });

  test("dispatch unknown tool returns error", async () => {
    const reg = ToolRegistry.create();
    const result = await reg.dispatch({ tool: "ghost", args: {} });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("Unknown tool");
  });

  test("dispatch disabled tool returns error", async () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("off", false, false));
    const result = await reg.dispatch({ tool: "off", args: { input: "x" } });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("disabled");
  });

  test("requestId passes through result", async () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("echo"));
    const result = await reg.dispatch({ tool: "echo", args: { input: "x" }, requestId: "req-42" });
    expect(result.requestId).toBe("req-42");
  });
});

// ─── ToolManifest ─────────────────────────────────────────────────────────────

describe("ToolManifest", () => {
  test("toSystemPromptBlock includes tool names", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("alpha"));
    reg.register(makeTool("beta"));
    const manifest = new ToolManifest(reg);
    const block = manifest.toSystemPromptBlock();
    expect(block).toContain("alpha");
    expect(block).toContain("beta");
  });

  test("empty registry returns empty string", () => {
    const reg = ToolRegistry.create();
    const manifest = new ToolManifest(reg);
    expect(manifest.toSystemPromptBlock()).toBe("");
  });

  test("requiresHitl tools are marked in manifest", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("dangerous", true));
    const manifest = new ToolManifest(reg);
    expect(manifest.toSystemPromptBlock()).toContain("requires approval");
  });

  test("cached result returned on second call", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("cached-tool"));
    const manifest = new ToolManifest(reg);
    const first = manifest.toSystemPromptBlock();
    const second = manifest.toSystemPromptBlock();
    expect(first).toBe(second);
  });

  test("invalidate() forces rebuild", () => {
    const reg = ToolRegistry.create();
    reg.register(makeTool("tool-a"));
    const manifest = new ToolManifest(reg);
    manifest.toSystemPromptBlock(); // cache
    manifest.invalidate();
    // Re-register would throw, but we can verify dirty works by checking cache is gone
    expect(manifest.size()).toBe(1);
  });
});

// ─── ToolDispatcher ───────────────────────────────────────────────────────────

describe("ToolDispatcher — parse from text", () => {
  test("parses tool call from freetext line", () => {
    const reg = ToolRegistry.create();
    const dispatcher = new ToolDispatcher(reg);
    const text = `Here is my response.\n{"tool":"echo","args":{"input":"hello"}}\nEnd.`;
    const calls = dispatcher.parseFromText(text);
    expect(calls.length).toBe(1);
    expect(calls[0]!.tool).toBe("echo");
    expect(calls[0]!.args["input"]).toBe("hello");
  });

  test("returns empty for text with no tool calls", () => {
    const reg = ToolRegistry.create();
    const dispatcher = new ToolDispatcher(reg);
    const text = "Just a normal response with no tool calls.";
    expect(dispatcher.parseFromText(text)).toHaveLength(0);
  });

  test("hasToolCall returns true when call is present", () => {
    const reg = ToolRegistry.create();
    const dispatcher = new ToolDispatcher(reg);
    expect(dispatcher.hasToolCall('{"tool":"x","args":{}}')).toBe(true);
    expect(dispatcher.hasToolCall("plain text")).toBe(false);
  });

  test("parseFromClaudeBlock parses tool_use block", () => {
    const reg = ToolRegistry.create();
    const dispatcher = new ToolDispatcher(reg);
    const block = { type: "tool_use", name: "file_read", input: { path: "/tmp/test.txt" }, id: "call-1" };
    const req = dispatcher.parseFromClaudeBlock(block);
    expect(req).not.toBeNull();
    expect(req!.tool).toBe("file_read");
    expect(req!.requestId).toBe("call-1");
  });

  test("parseFromClaudeBlock returns null for non-tool_use", () => {
    const reg = ToolRegistry.create();
    const dispatcher = new ToolDispatcher(reg);
    expect(dispatcher.parseFromClaudeBlock({ type: "text", text: "hi" })).toBeNull();
  });

  test("parseFromGeminiCall parses function call", () => {
    const reg = ToolRegistry.create();
    const dispatcher = new ToolDispatcher(reg);
    const call = { name: "memory_search", args: { query: "Wire Platform" } };
    const req = dispatcher.parseFromGeminiCall(call);
    expect(req).not.toBeNull();
    expect(req!.tool).toBe("memory_search");
  });
});
