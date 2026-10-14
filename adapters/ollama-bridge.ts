#!/usr/bin/env bun
// Ollama Bridge — calls Ollama HTTP API and submits the response as a signed
// WireProtocol v1 wire message via the gateway.
//
// Ollama cannot run shell commands or the wire CLI. This bridge runs on Claude's side:
//   1. Receives an incoming wire message from an agent addressed to ollama
//   2. Extracts the WireSpec task
//   3. Converts it to an Ollama prompt
//   4. Calls Ollama API
//   5. Wraps the response in a ResultSpec and sends it back via the gateway as ollama
//
// Usage:
//   bun run adapters/ollama-bridge.ts --task <messageId> --from <agentId> --as ollama
//   Or run with no args to process ALL pending inbox messages addressed to ollama.

import { join } from "node:path";

const GATEWAY = process.env["WIRE_GATEWAY"] ?? "http://localhost:31338";
const OLLAMA = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
const TOKEN = process.env["WIRE_TOKEN"] ?? "";

// Model selection based on skill type
const SKILL_TO_MODEL: Record<string, string> = {
  quick: "phi3:mini",
  summarize: "phi3:mini",
  explain: "phi3.5",
  classify: "phi3.5",
  code_review: "codegemma:2b",
  debug: "codegemma:2b",
};
const DEFAULT_MODEL = "phi3:mini";

// ─── Convert WireSpec TaskSpec to an Ollama prompt ────────────────────────────

function taskToPrompt(payload: Record<string, unknown>): string {
  const verb = payload["verb"] as string;
  const domain = (payload["domain"] as string[])?.join(", ");
  const subject = payload["subject"] as string | undefined;
  const constraints = payload["constraints"] as Record<string, string> | undefined;
  const output = payload["output"] as Record<string, unknown> | undefined;
  const outputFormat = output?.["format"] as string;
  const include = output?.["include"] as string[] | undefined;
  const maxItems = output?.["maxItems"] as number | undefined;
  const maxTokens = output?.["maxTokens"] as number | undefined;

  const parts: string[] = [];

  // Task directive
  parts.push(`Task: ${verb} — domain: ${domain}${subject ? ` — ${subject}` : ""}`);

  // Constraints
  if (constraints && Object.keys(constraints).length > 0) {
    parts.push("Constraints:");
    for (const [k, v] of Object.entries(constraints)) {
      parts.push(`  ${k}: ${v}`);
    }
  }

  // Output spec
  parts.push(`Output format: ${outputFormat ?? "prose"}`);
  if (maxItems) parts.push(`Max items: ${maxItems}`);
  if (include?.length) parts.push(`Include per item: ${include.join(", ")}`);
  if (maxTokens) parts.push(`Response length: under ${maxTokens} tokens`);

  parts.push("\nProvide a direct, structured response. No preamble.");

  return parts.join("\n");
}

// ─── Call Ollama API ──────────────────────────────────────────────────────────

interface OllamaResponse {
  response: string;
  eval_count?: number;
  prompt_eval_count?: number;
}

async function callOllama(model: string, prompt: string): Promise<OllamaResponse> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<OllamaResponse>;
}

// ─── Fetch pending messages for ollama from gateway ───────────────────────────

async function fetchOllamaInbox(): Promise<unknown[]> {
  const res = await fetch(`${GATEWAY}/inbox/ollama?token=${TOKEN}`);
  if (!res.ok) throw new Error(`Gateway error: ${res.status}`);
  const data = await res.json() as { messages: unknown[] };
  return data.messages ?? [];
}

// ─── Send result back via gateway ─────────────────────────────────────────────

async function sendResult(
  to: string,
  taskId: string,
  skill: string,
  response: string,
  tokensUsed: number
): Promise<void> {
  const payload = {
    format: "result",
    taskId,
    status: "success",
    confidence: 0.75,
    data: response,
    tokensUsed,
    uncertainty: ["confidence estimate is approximate for local Ollama models"],
  };

  const body = JSON.stringify({ to, type: "result", skill, payload });
  const res = await fetch(`${GATEWAY}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Id": "ollama",
      "X-Agent-Token": TOKEN,
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gateway send failed: ${res.status} ${errText}`);
  }
}

// Send an ErrorSpec back to the requesting agent — preserves protocol guarantee
// that every task message gets a response (success or error).
async function sendError(to: string, taskId: string, skill: string, message: string): Promise<void> {
  const payload = {
    format: "result",
    taskId,
    status: "failed",
    confidence: 0,
    data: null,
    uncertainty: [message],
  };
  const body = JSON.stringify({ to, type: "result", skill, payload });
  try {
    await fetch(`${GATEWAY}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Id": "ollama", "X-Agent-Token": TOKEN },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Best-effort — if gateway is down we can't send the error either
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

if (!TOKEN) {
  console.error("WIRE_TOKEN not set. Export the ollama gateway token from bootstrap output.");
  process.exit(1);
}

// Check Ollama is running
let ollamaOk = false;
try {
  const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
  ollamaOk = r.ok;
} catch { /* not running */ }

if (!ollamaOk) {
  console.error(`Ollama not running at ${OLLAMA}. Start with: ollama serve`);
  process.exit(1);
}

// Fetch pending inbox messages for ollama
console.log("Fetching pending messages for ollama...");
let messages: unknown[];
try {
  messages = await fetchOllamaInbox();
} catch (e) {
  console.error(`Gateway unreachable at ${GATEWAY}: ${e}`);
  console.error("Start the gateway first: bun run wire-gateway");
  process.exit(1);
}

if (messages.length === 0) {
  console.log("No pending messages for ollama.");
  process.exit(0);
}

console.log(`Found ${messages.length} message(s) for ollama.\n`);

for (const msg of messages) {
  const m = msg as Record<string, unknown>;
  const messageId = m["messageId"] as string;
  const from = m["from"] as string;
  const skill = m["skill"] as string;
  const payload = m["payload"] as Record<string, unknown>;

  console.log(`Processing: ${messageId.slice(0, 8)}... (from=${from} skill=${skill})`);

  if (payload["format"] !== "task") {
    console.log("  Skipping non-task payload.");
    continue;
  }

  const model = SKILL_TO_MODEL[skill] ?? DEFAULT_MODEL;
  const prompt = taskToPrompt(payload);

  console.log(`  Model: ${model}`);
  console.log(`  Prompt preview: ${prompt.slice(0, 80)}...`);

  try {
    const result = await callOllama(model, prompt);
    const tokensUsed = (result.eval_count ?? 0) + (result.prompt_eval_count ?? 0);
    await sendResult(from, messageId, skill, result.response, tokensUsed);
    console.log(`  Done. Tokens used: ${tokensUsed}. Result sent to ${from}.`);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`  Failed: ${errMsg}`);
    // Send ErrorSpec back — every task must get a response (success or error)
    await sendError(from, messageId, skill, `ollama-bridge error: ${errMsg}`);
    console.log(`  Error response sent to ${from}.`);
  }
  console.log("");
}
