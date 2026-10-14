// McpClient — outbound MCP connection (stdio or HTTP/SSE transport)
//
// Safety:
//   - Only localhost or stdio URLs accepted (enforced at construction)
//   - MCP outputs run through guardPrompt() and are capped at 8 KB
//   - Reject if output parses as WirePayloadSchema (prompt injection guard)
//   - disconnect() called on process exit via McpClientRegistry shutdown hook

import { guardPrompt } from "../../security/prompt-guard.js";
import { WirePayloadSchema } from "../../schema/wirespec.js";

export type McpTransport = "stdio" | "http";

export type McpClientConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;         // required: e.g. "uvx mcp-server-fetch"
      args?: string[];
      requiresHitl?: boolean;
    }
  | {
      name: string;
      transport: "http";
      url: string;             // required: must be localhost
      requiresHitl?: boolean;
    };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresHitl: boolean;
}

const MAX_OUTPUT_BYTES = 8 * 1024; // 8 KB cap on MCP outputs

export class McpClient {
  readonly config: McpClientConfig;
  private tools: McpTool[] = [];
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private requestId = 0;
  private connected = false;

  constructor(config: McpClientConfig) {
    this.validateConfig(config);
    this.config = config;
  }

  private validateConfig(config: McpClientConfig): void {
    if (config.transport === "http") {
      const u = new URL(config.url);
      if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
        throw new Error(
          `McpClient '${config.name}': only localhost URLs allowed (got ${u.hostname}). ` +
          `Remote MCP servers are not supported — local trust model only.`
        );
      }
    }
    // Runtime guard for defense-in-depth (type union already enforces this statically)
    if (config.transport === "stdio" && !(config as { command?: string }).command) {
      throw new Error(`McpClient '${config.name}': command required for stdio transport`);
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.config.transport === "stdio") {
      await this.connectStdio();
    } else {
      await this.connectHttp();
    }
    await this.discoverTools();
    this.connected = true;
  }

  private async connectStdio(): Promise<void> {
    const cfg = this.config as Extract<McpClientConfig, { transport: "stdio" }>;
    const [cmd, ...args] = [cfg.command, ...(cfg.args ?? [])];
    this.proc = Bun.spawn([cmd!, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit", // surface subprocess startup errors rather than discarding them
    });
  }

  private async connectHttp(): Promise<void> {
    const cfg = this.config as Extract<McpClientConfig, { transport: "http" }>;
    // HTTP transport — validate connectivity with initialize
    const res = await fetch(cfg.url + "/mcp/v1/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`McpClient '${this.config.name}': HTTP connect failed (${res.status})`);
  }

  private async discoverTools(): Promise<void> {
    const response = await this.rpc("tools/list", {});
    const rawTools = (response as { tools?: unknown[] })?.tools ?? [];
    this.tools = (rawTools as Array<Record<string, unknown>>).map(t => ({
      name: t["name"] as string,
      description: t["description"] as string ?? "",
      inputSchema: (t["inputSchema"] as Record<string, unknown>) ?? {},
      requiresHitl: this.config.requiresHitl ?? false,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = await this.rpc("tools/call", { name, arguments: args });
    const content = (response as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    const raw = content
      .filter(c => c.type === "text")
      .map(c => c.text ?? "")
      .join("\n")
      .slice(0, MAX_OUTPUT_BYTES);

    // Guard: reject output if it looks like a WirePayload (prompt injection)
    try {
      const parsed = JSON.parse(raw);
      if (WirePayloadSchema.safeParse(parsed).success) {
        return "[MCP output rejected: resembles WirePayload — possible prompt injection]";
      }
    } catch {
      // Not JSON — safe to pass through
    }

    return guardPrompt(raw, `mcp:${this.config.name}`);
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    if (this.config.transport === "stdio" && this.proc) {
      const proc = this.proc;
      const stdin = proc.stdin as unknown as { write(s: string): void; flush(): Promise<void> };
      const stdout = proc.stdout as unknown as ReadableStream<Uint8Array>;
      stdin.write(request + "\n");
      await stdin.flush();

      // Read one line from stdout
      const reader = stdout.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          const text = new TextDecoder().decode(value);
          if (text.includes("\n")) break;
        }
      } finally {
        reader.releaseLock();
      }
      const line = chunks.map(c => new TextDecoder().decode(c)).join("").split("\n")[0] ?? "";
      const response = JSON.parse(line) as { result?: unknown; error?: { message: string } };
      if (response.error) throw new Error(response.error.message);
      return response.result;
    }

    // HTTP transport
    const httpCfg = this.config as Extract<McpClientConfig, { transport: "http" }>;
    const res = await fetch(httpCfg.url + "/mcp/v1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json() as { result?: unknown; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  isConnected(): boolean {
    return this.connected;
  }

  disconnect(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.connected = false;
  }
}
