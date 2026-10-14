import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpClient } from "../src/mcp/client/McpClient.js";
import { McpClientRegistry } from "../src/mcp/client/McpClientRegistry.js";
import { ToolRouter } from "../src/dispatch/ToolRouter.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import type { ToolDefinition } from "../src/tools/types.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `wire-mcp-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ─── McpClient — safety validation ───────────────────────────────────────────

describe("McpClient — URL validation", () => {
  test("localhost URL accepted", () => {
    expect(() => new McpClient({ name: "local", transport: "http", url: "http://localhost:8080" })).not.toThrow();
  });

  test("127.0.0.1 URL accepted", () => {
    expect(() => new McpClient({ name: "local2", transport: "http", url: "http://127.0.0.1:9000" })).not.toThrow();
  });

  test("remote URL rejected", () => {
    expect(() =>
      new McpClient({ name: "remote", transport: "http", url: "http://example.com/mcp" })
    ).toThrow("only localhost URLs allowed");
  });

  test("stdio without command throws", () => {
    expect(() => new McpClient({ name: "bad-stdio", transport: "stdio" } as any)).toThrow("command required");
  });

  test("stdio with command accepted", () => {
    expect(() =>
      new McpClient({ name: "stdio-ok", transport: "stdio", command: "uvx", args: ["mcp-server"] })
    ).not.toThrow();
  });
});

// ─── McpClientRegistry ────────────────────────────────────────────────────────

describe("McpClientRegistry — register", () => {
  test("register and retrieve client by name", () => {
    const reg = new McpClientRegistry(testDir);
    reg.register({ name: "test-mcp", transport: "stdio", command: "echo" });
    expect(reg.getClient("test-mcp")).not.toBeNull();
    expect(reg.clientNames()).toContain("test-mcp");
  });

  test("duplicate registration throws", () => {
    const reg = new McpClientRegistry(testDir);
    reg.register({ name: "dup", transport: "stdio", command: "echo" });
    expect(() => reg.register({ name: "dup", transport: "stdio", command: "echo" })).toThrow("already registered");
  });

  test("remote URL rejected during register", () => {
    const reg = new McpClientRegistry(testDir);
    expect(() =>
      reg.register({ name: "bad", transport: "http", url: "http://evil.com/mcp" })
    ).toThrow("only localhost URLs allowed");
  });

  test("findTool returns null when no clients connected", () => {
    const reg = new McpClientRegistry(testDir);
    reg.register({ name: "nc", transport: "stdio", command: "echo" });
    expect(reg.findTool("some_tool")).toBeNull();
  });
});

describe("McpClientRegistry — loadFromConfig", () => {
  test("returns empty registry when wire.config.json missing", () => {
    const reg = McpClientRegistry.loadFromConfig(testDir, testDir);
    expect(reg.clientNames()).toHaveLength(0);
  });

  test("loads mcpClients from wire.config.json", () => {
    const config = {
      mcpClients: [
        { name: "fetcher", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
      ],
    };
    writeFileSync(join(testDir, "wire.config.json"), JSON.stringify(config));
    const reg = McpClientRegistry.loadFromConfig(testDir, testDir);
    expect(reg.clientNames()).toContain("fetcher");
  });

  test("remote URL in config is skipped with warning (not throw)", () => {
    const config = {
      mcpClients: [
        { name: "bad", transport: "http", url: "http://remote.example.com/mcp" },
        { name: "good", transport: "stdio", command: "echo" },
      ],
    };
    writeFileSync(join(testDir, "wire.config.json"), JSON.stringify(config));
    const reg = McpClientRegistry.loadFromConfig(testDir, testDir);
    // "bad" skipped, "good" registered
    expect(reg.clientNames()).not.toContain("bad");
    expect(reg.clientNames()).toContain("good");
  });
});

// ─── ToolRouter ───────────────────────────────────────────────────────────────

function makeBuiltinTool(name: string, hitl = false): ToolDefinition {
  return {
    name,
    description: `Builtin: ${name}`,
    requiresHitl: hitl,
    enabled: true,
    parameters: {},
    async execute() { return { ok: true, output: `${name} output` }; },
  };
}

describe("ToolRouter — resolution order", () => {
  test("builtin resolved before MCP", () => {
    const toolReg = ToolRegistry.create();
    toolReg.register(makeBuiltinTool("echo"));
    const mcpReg = new McpClientRegistry(testDir);
    const router = new ToolRouter(toolReg, mcpReg);

    const resolved = router.resolve("echo");
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("builtin");
  });

  test("unknown tool returns null", () => {
    const toolReg = ToolRegistry.create();
    const router = new ToolRouter(toolReg);
    expect(router.resolve("ghost")).toBeNull();
  });

  test("requiresHitl propagated from builtin", () => {
    const toolReg = ToolRegistry.create();
    toolReg.register(makeBuiltinTool("shell", true));
    const router = new ToolRouter(toolReg);
    const resolved = router.resolve("shell");
    expect(resolved!.requiresHitl).toBe(true);
  });

  test("listAll includes builtin tools", () => {
    const toolReg = ToolRegistry.create();
    toolReg.register(makeBuiltinTool("alpha"));
    toolReg.register(makeBuiltinTool("beta"));
    const router = new ToolRouter(toolReg);
    const list = router.listAll();
    const names = list.map(t => t.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  test("call dispatches builtin tool", async () => {
    const toolReg = ToolRegistry.create();
    toolReg.register(makeBuiltinTool("greet"));
    const router = new ToolRouter(toolReg);
    const result = await router.call("greet", {});
    expect(result.ok).toBe(true);
    expect((result as { ok: true; output: string }).output).toBe("greet output");
  });

  test("call unknown tool returns error", async () => {
    const toolReg = ToolRegistry.create();
    const router = new ToolRouter(toolReg);
    const result = await router.call("missing", {});
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("no tool found");
  });
});
