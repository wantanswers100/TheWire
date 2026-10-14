#!/usr/bin/env bun
// Wire MCP Server — Phase 32 (W-06) + Project Context extension
//
// JSON-RPC 2.0 over stdio. MCP protocol version 2024-11-05.
// Hand-rolled per Wire invariant: Zod is the only permitted external dependency.
// No @modelcontextprotocol/sdk.
//
// Exposes 9 tools:
//   wire_work           — project-aware task dispatch (wire work <project> "<task>")
//   wire_ask            — NL dispatch (wire - "<task>")
//   wire_diagnose       — project health assessment (wire diagnose <project>)
//   wire_memory_search  — persistent memory search (MemoryStore.search directly)
//   project_list        — list all registered projects + status
//   project_context     — structured project state (manifest + git + status summary)
//   project_write       — safe patch-based write to context/, outputs/, profile/, snapshots/, questions/
//   project_search      — grep across project context/docs/profile/snapshots/questions files
//   project_diff        — git + working tree changes since commit/last run
//
// Usage:
//   bun run src/mcp/server.ts
//   wire mcp
//
// Claude Code integration (~/.claude/mcp.json):
//   { "mcpServers": { "wire": { "command": "wire", "args": ["mcp"] } } }

import { join } from "node:path";
import type { MemoryCategory } from "../agents/memory.js";
// ISS-031: sourced from config/paths.ts.
import { PROJECT_ROOT, STATE_DIR } from "../config/paths.js";
import { getRegisteredProjects, getProject } from "../projects/registry.js";
import { readProjectContext } from "../projects/context.js";
import { writeProjectFile } from "../projects/writer.js";
import { searchProject } from "../projects/search.js";
import { projectDiff } from "../projects/diff.js";
import { withEngaged, callerFromClientName } from "../engaged.js";
import { APP_VERSION } from "../version.js";

// Set from the client's initialize clientInfo — shown in host status lines.
let mcpCaller = "mcp";

const WIRE_CLI     = join(PROJECT_ROOT, "src/cli/index.ts");

// ─── JSON-RPC 2.0 types ───────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "wire_work",
    description:
      "Dispatch a task to a specific project using Wire's project-aware context. " +
      "Loads the project context pack (brief, surfaces, risks), classifies the task, " +
      "and either runs it locally via Ollama or generates an online escalation prompt.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name (e.g. agent-wire, deepseek-lab)" },
        task:    { type: "string", description: "Task description in plain English" },
        online:  { type: "boolean", description: "Force online escalation prompt instead of local Ollama" },
      },
      required: ["project", "task"],
    },
  },
  {
    name: "wire_ask",
    description:
      "Natural language task dispatch. qwen3:4b classifies intent and routes to the best " +
      "agent (claude, gemini, codex, ollama). Falls back to keyword classification if Ollama " +
      "is unavailable. At ≥85% confidence dispatches silently; at 60-84% shows plan and " +
      "auto-rejects in non-interactive mode.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task in plain English" },
        to:   {
          type: "string",
          enum: ["claude", "gemini", "codex", "ollama"],
          description: "Override agent selection (skips confidence gate)",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "wire_diagnose",
    description:
      "Multi-angle project health assessment. Runs a security surface scan and local AI " +
      "analysis via qwen2.5-coder:14b. Returns findings and optional escalation prompts " +
      "for Claude, security, and Architect agents.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name to diagnose" },
        local:   { type: "boolean", description: "Local analysis only — no escalation prompts" },
        full:    { type: "boolean", description: "Include all three agent prompts (Security, Engineer, Architect)" },
      },
      required: ["project"],
    },
  },
  {
    name: "wire_memory_search",
    description:
      "Search Wire's persistent memory store. Uses keyword matching plus semantic search " +
      "via nomic-embed-text embeddings (Ollama). Returns entries ranked by relevance score.",
    inputSchema: {
      type: "object",
      properties: {
        query:    { type: "string", description: "Search query" },
        topK:     { type: "number", description: "Max results to return (default: 5)" },
        category: {
          type: "string",
          enum: ["conversation", "task_log", "project_state", "preference", "observation"],
          description: "Filter results by category",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "project_list",
    description:
      "List all registered Wire projects with their path, status, git branch, and version. " +
      "Projects are registered in ~/.wire/projects.json or auto-discovered in ~/projects/active/.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "project_context",
    description:
      "Return structured context for a specific project: manifest metadata, git commit/branch, " +
      "status summary, available context files, and count of uncommitted changes. " +
      "Low-token — returns metadata only; use project_search or read specific files for full content.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID (from project_list)" },
      },
      required: ["project"],
    },
  },
  {
    name: "project_write",
    description:
      "Write or append content to a project context file. Restricted to context/, outputs/, " +
      "profile/, snapshots/, questions/ subdirectories only. Supports optimistic locking via expected_version. " +
      "Bumps MANIFEST.json version on success.",
    inputSchema: {
      type: "object",
      properties: {
        project:          { type: "string", description: "Project ID" },
        path:             { type: "string", description: "Relative path within project (e.g. context/CURRENT_STATE.md)" },
        content:          { type: "string", description: "Content to write" },
        mode:             { type: "string", enum: ["overwrite", "append"], description: "Write mode (default: overwrite)" },
        expected_version: { type: "number", description: "Expected MANIFEST.json version for optimistic locking (optional)" },
      },
      required: ["project", "path", "content"],
    },
  },
  {
    name: "project_search",
    description:
      "Search for a query string across all context/, docs/, profile/, snapshots/, questions/ files in a project. " +
      "Returns up to 20 matches with file, line number, and snippet.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID" },
        query:   { type: "string", description: "Search query (case-insensitive substring match)" },
      },
      required: ["project", "query"],
    },
  },
  {
    name: "project_diff",
    description:
      "Show what changed in a project since a given commit or 'last' (previous commit). " +
      "Returns committed changes (git diff) and working tree (uncommitted) separately.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project ID" },
        since:   { type: "string", description: "Git commit hash, 'last' (HEAD~1), or omit for last commit" },
      },
      required: ["project"],
    },
  },
] as const;

// ─── Tool execution ───────────────────────────────────────────────────────────

// Env vars that must never appear in child process stderr responses.
// These are scrubbed before any error text is returned to the caller.
const SENSITIVE_ENV_PREFIXES = [
  "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY",
  "OPENAI_SESSION_TOKEN", "GROQ_API_KEY", "WIRE_", "KEYS_",
];

function scrubSensitiveEnv(text: string): string {
  // Replace any line that contains a known-sensitive env key name or looks like
  // a key=value pair where the key matches a sensitive prefix.
  return text
    .split("\n")
    .map(line =>
      SENSITIVE_ENV_PREFIXES.some(p => line.includes(p))
        ? "[env content redacted]"
        : line
    )
    .join("\n");
}

// Reject task/query strings that start with -- to prevent argv flag injection
// into Wire's hand-parsed CLI arg parser.
function assertNotFlag(value: string, field: string): void {
  if (value.startsWith("--") || value.startsWith("-")) {
    throw new Error(
      `${field}: value must not start with '-' (received: ${JSON.stringify(value.slice(0, 40))})`
    );
  }
}

async function execWireCli(args: string[], timeoutMs: number): Promise<string> {
  const proc = Bun.spawn(["bun", "run", WIRE_CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    // stdin pipe + immediate close → promptConfirm() gets EOF → returns false (safe)
    stdin: "pipe",
    env: { ...process.env },
  });

  proc.stdin.end();

  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => { proc.kill(); reject(new Error(`wire ${args[0]} timed out after ${timeoutMs}ms`)); }, timeoutMs)
  );

  const result = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const [stdout, stderr, exitCode] = await Promise.race([result, deadline]);
  const out = stdout.trim();
  // Scrub env vars from stderr before any error message reaches the caller.
  const errText = scrubSensitiveEnv(stderr.trim());

  if (exitCode !== 0 && !out) {
    throw new Error(errText || `wire ${args[0] ?? ""} exited with code ${exitCode}`);
  }
  return out || (errText ? `[wire exited ${exitCode}]\n${errText}` : `[wire exited ${exitCode}]`);
}

async function execMemorySearch(
  query: string,
  topK: number,
  category: MemoryCategory | undefined,
): Promise<string> {
  // Import lazily so startup is fast if the DB doesn't exist yet
  const { MemoryStore } = await import("../agents/memory.js");
  const store = new MemoryStore(STATE_DIR);
  const results = await store.search({ query, topK, category });
  if (results.length === 0) return "No memory entries found.";
  return results
    .map((r, i) =>
      `[${i + 1}] ${r.key} (${r.category}, score: ${r.score.toFixed(2)})\n${r.value}`
    )
    .join("\n\n");
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "wire_work": {
      const project = String(args["project"] ?? "").trim();
      const task    = String(args["task"] ?? "").trim();
      if (!project) throw new Error("wire_work: 'project' is required");
      if (!task)    throw new Error("wire_work: 'task' is required");
      assertNotFlag(project, "wire_work.project");
      assertNotFlag(task, "wire_work.task");
      if (task.length > 8192) throw new Error("wire_work: task exceeds 8192 character limit");
      const extra = args["online"] === true ? ["--online"] : [];
      return execWireCli(["work", project, task, ...extra], 180_000);
    }

    case "wire_ask": {
      const task = String(args["task"] ?? "").trim();
      if (!task) throw new Error("wire_ask: 'task' is required");
      assertNotFlag(task, "wire_ask.task");
      if (task.length > 8192) throw new Error("wire_ask: task exceeds 8192 character limit");
      const extra: string[] = [];
      if (typeof args["to"] === "string") extra.push("--to", args["to"]);
      return execWireCli(["-", task, ...extra], 120_000);
    }

    case "wire_diagnose": {
      const project = String(args["project"] ?? "").trim();
      if (!project) throw new Error("wire_diagnose: 'project' is required");
      assertNotFlag(project, "wire_diagnose.project");
      const extra: string[] = [];
      if (args["local"] === true) extra.push("--local");
      if (args["full"] === true)  extra.push("--full");
      return execWireCli(["diagnose", project, ...extra], 180_000);
    }

    case "wire_memory_search": {
      const query    = String(args["query"] ?? "").trim();
      if (!query) throw new Error("wire_memory_search: 'query' is required");
      const topK     = typeof args["topK"] === "number" && args["topK"] > 0 ? Math.floor(args["topK"]) : 5;
      const category = typeof args["category"] === "string"
        ? (args["category"] as MemoryCategory)
        : undefined;
      return execMemorySearch(query, topK, category);
    }

    case "project_list": {
      const projects = getRegisteredProjects();
      if (projects.length === 0) return "No projects registered. Add projects to ~/.wire/projects.json";
      return JSON.stringify(projects, null, 2);
    }

    case "project_context": {
      const projectId = String(args["project"] ?? "").trim();
      if (!projectId) throw new Error("project_context: 'project' is required");
      const entry = getProject(projectId);
      if (!entry) throw new Error(`project_context: project '${projectId}' not found. Use project_list to see registered projects.`);
      const result = readProjectContext(entry.id, entry.path);
      return JSON.stringify(result, null, 2);
    }

    case "project_write": {
      const projectId = String(args["project"] ?? "").trim();
      const path      = String(args["path"] ?? "").trim();
      const content   = String(args["content"] ?? "");
      const mode      = args["mode"] === "append" ? "append" : "overwrite";
      const expectedVersion = typeof args["expected_version"] === "number"
        ? args["expected_version"]
        : undefined;
      if (!projectId) throw new Error("project_write: 'project' is required");
      if (!path)      throw new Error("project_write: 'path' is required");
      const entry = getProject(projectId);
      if (!entry) throw new Error(`project_write: project '${projectId}' not found. Use project_list to see registered projects.`);
      const result = writeProjectFile(entry.id, entry.path, path, content, mode, expectedVersion);
      return JSON.stringify(result, null, 2);
    }

    case "project_search": {
      const projectId = String(args["project"] ?? "").trim();
      const query     = String(args["query"] ?? "").trim();
      if (!projectId) throw new Error("project_search: 'project' is required");
      if (!query)     throw new Error("project_search: 'query' is required");
      const entry = getProject(projectId);
      if (!entry) throw new Error(`project_search: project '${projectId}' not found. Use project_list to see registered projects.`);
      const result = searchProject(entry.id, entry.path, query);
      return JSON.stringify(result, null, 2);
    }

    case "project_diff": {
      const projectId = String(args["project"] ?? "").trim();
      if (!projectId) throw new Error("project_diff: 'project' is required");
      const since = typeof args["since"] === "string" ? args["since"] : undefined;
      const entry = getProject(projectId);
      if (!entry) throw new Error(`project_diff: project '${projectId}' not found. Use project_list to see registered projects.`);
      const result = projectDiff(entry.id, entry.path, since);
      return JSON.stringify(result, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC 2.0 I/O ─────────────────────────────────────────────────────────

function send(msg: RpcResponse): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ─── Request dispatch ─────────────────────────────────────────────────────────

async function dispatch(msg: RpcRequest): Promise<void> {
  // id is undefined for notifications — do not reply
  const id = Object.prototype.hasOwnProperty.call(msg, "id") ? (msg.id ?? null) : undefined;

  switch (msg.method) {
    case "initialize": {
      const info = (msg.params as { clientInfo?: { name?: unknown } } | undefined)?.clientInfo;
      mcpCaller = callerFromClientName(typeof info?.name === "string" ? info.name : undefined);
      send({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "Wire MCP Server", version: APP_VERSION },
        },
      });
      return;
    }

    case "initialized":
      // Notification — no response
      return;

    case "tools/list": {
      send({
        jsonrpc: "2.0",
        id: id ?? null,
        result: { tools: TOOLS },
      });
      return;
    }

    case "tools/call": {
      if (id === undefined) return; // notification without id — shouldn't happen, ignore
      const params = msg.params as { name?: unknown; arguments?: unknown } | undefined;
      const toolName = params?.name;
      const toolArgs = (typeof params?.arguments === "object" && params.arguments !== null)
        ? (params.arguments as Record<string, unknown>)
        : {};

      if (typeof toolName !== "string") {
        sendError(id ?? null, -32602, "tools/call: params.name must be a string");
        return;
      }

      if (!TOOLS.some(t => t.name === toolName)) {
        sendError(id ?? null, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      let text: string;
      let isError = false;
      try {
        text = await withEngaged(mcpCaller, toolName, () => callTool(toolName, toolArgs));
      } catch (e) {
        text = `Error: ${e instanceof Error ? e.message : String(e)}`;
        isError = true;
      }

      send({
        jsonrpc: "2.0",
        id: id ?? null,
        result: {
          content: [{ type: "text", text }],
          ...(isError && { isError: true }),
        },
      });
      return;
    }

    default:
      // Notification methods have no id — don't reply
      if (id !== undefined) {
        sendError(id ?? null, -32601, `Method not found: ${msg.method}`);
      }
  }
}

// ─── Stdin reader ─────────────────────────────────────────────────────────────

process.stderr.write("[wire-mcp] Wire MCP Server v1.0.0 started (stdio)\n");

let buf = "";
let inFlight = 0;
let stdinEnded = false;

function checkExit(): void {
  if (stdinEnded && inFlight === 0) {
    process.stderr.write("[wire-mcp] stdin closed — exiting\n");
    process.exit(0);
  }
}

process.stdin.setEncoding("utf8");

const MAX_LINE_BYTES = 256 * 1024; // 256KB — reject runaway single-line input

process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  // Guard against unbounded memory growth from a single line with no newline.
  if (buf.length > MAX_LINE_BYTES && !buf.includes("\n")) {
    sendError(null, -32700, "Parse error: request line exceeds 256KB limit");
    buf = "";
    return;
  }
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";       // retain incomplete last line across chunks
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: RpcRequest;
    try {
      msg = JSON.parse(trimmed) as RpcRequest;
    } catch {
      sendError(null, -32700, "Parse error: invalid JSON");
      continue;
    }

    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
      sendError(id, -32600, "Invalid request: jsonrpc must be '2.0' and method must be a string");
      continue;
    }

    inFlight++;
    dispatch(msg)
      .catch(e => {
        process.stderr.write(
          `[wire-mcp] Unhandled dispatch error: ${e instanceof Error ? e.message : String(e)}\n`
        );
      })
      .finally(() => { inFlight--; checkExit(); });
  }
});

process.stdin.on("end", () => {
  stdinEnded = true;
  checkExit();
});
