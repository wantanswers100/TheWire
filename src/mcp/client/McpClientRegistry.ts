// McpClientRegistry — loads MCP client configs, manages connections + PID files
//
// Config source: wire.config.json → mcpClients[]
// PID tracking: .wire-state/mcp/<name>.pid
// Shutdown: disconnect() all clients on SIGTERM/SIGINT

import { readFileSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpClient } from "./McpClient.js";
import type { McpClientConfig, McpTool } from "./McpClient.js";

export class McpClientRegistry {
  private clients = new Map<string, McpClient>();
  private stateDir: string;
  private mcpStateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.mcpStateDir = join(stateDir, "mcp");
    mkdirSync(this.mcpStateDir, { recursive: true });
  }

  // Load from wire.config.json in the project root
  static loadFromConfig(projectRoot: string, stateDir: string): McpClientRegistry {
    const registry = new McpClientRegistry(stateDir);
    const configPath = join(projectRoot, "wire.config.json");
    if (!existsSync(configPath)) return registry;

    let config: { mcpClients?: McpClientConfig[] };
    try {
      config = JSON.parse(readFileSync(configPath, "utf8")) as { mcpClients?: McpClientConfig[] };
    } catch {
      console.warn("[mcp] wire.config.json parse error — skipping MCP clients");
      return registry;
    }

    for (const clientConfig of config.mcpClients ?? []) {
      try {
        registry.register(clientConfig);
      } catch (e) {
        console.warn(`[mcp] skipping client '${clientConfig.name}': ${(e as Error).message}`);
      }
    }

    return registry;
  }

  register(config: McpClientConfig): void {
    if (this.clients.has(config.name)) {
      throw new Error(`McpClientRegistry: client '${config.name}' already registered`);
    }
    const client = new McpClient(config);
    this.clients.set(config.name, client);
  }

  async connectAll(): Promise<void> {
    const errors: string[] = [];
    for (const [name, client] of this.clients) {
      try {
        await client.connect();
        this.writePid(name);
        console.log(`[mcp] connected: ${name} (${client.config.transport})`);
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`);
        console.warn(`[mcp] failed to connect '${name}': ${(e as Error).message}`);
      }
    }
    if (errors.length > 0) {
      console.warn(`[mcp] ${errors.length} client(s) failed to connect — continuing without them`);
    }
  }

  // Find which client exposes a given tool
  findTool(toolName: string): { client: McpClient; tool: McpTool } | null {
    for (const client of this.clients.values()) {
      if (!client.isConnected()) continue;
      const tool = client.getTools().find(t => t.name === toolName);
      if (tool) return { client, tool };
    }
    return null;
  }

  // All tools from all connected clients
  allTools(): Array<{ clientName: string; tool: McpTool }> {
    const result: Array<{ clientName: string; tool: McpTool }> = [];
    for (const [name, client] of this.clients) {
      if (!client.isConnected()) continue;
      for (const tool of client.getTools()) {
        result.push({ clientName: name, tool });
      }
    }
    return result;
  }

  disconnectAll(): void {
    for (const [name, client] of this.clients) {
      client.disconnect();
      this.removePid(name);
    }
    console.log("[mcp] all clients disconnected");
  }

  getClient(name: string): McpClient | null {
    return this.clients.get(name) ?? null;
  }

  clientNames(): string[] {
    return [...this.clients.keys()];
  }

  private writePid(name: string): void {
    writeFileSync(join(this.mcpStateDir, `${name}.pid`), String(process.pid), { mode: 0o600 });
  }

  private removePid(name: string): void {
    const path = join(this.mcpStateDir, `${name}.pid`);
    if (existsSync(path)) unlinkSync(path);
  }
}
