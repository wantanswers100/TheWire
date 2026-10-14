// wire explain-file — explain a source file using local Ollama model
//
// Usage:
//   wire explain-file <file>

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL, OLLAMA_DEFAULT_MODEL } from "../config/models.js";
import { appendLedgerEntry } from "./usage-ledger.js";

const SECRET_PATTERNS = [".env", ".env.local", ".env.production", ".keys/", ".wire-state/"];

function isSecretFile(path: string): boolean {
  const name = basename(path);
  return SECRET_PATTERNS.some(p => path.includes(p) || name === p.replace("/", ""));
}

export async function runExplainFile(args: string[]): Promise<void> {
  const filePath = args.find(a => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: wire explain-file <file>");
    process.exit(1);
  }

  const resolved = resolve(process.cwd(), filePath);

  if (isSecretFile(resolved)) {
    console.error(`[wire] Refusing to process secret file: ${resolved}`);
    process.exit(1);
  }

  if (!existsSync(resolved)) {
    console.error(`[wire] File not found: ${resolved}`);
    process.exit(1);
  }

  const contents = readFileSync(resolved, "utf8");
  const model = OLLAMA_SKILL_MODEL["explain"] ?? OLLAMA_DEFAULT_MODEL;

  const prompt = `Explain what this file does, its key functions or classes, its inputs and outputs, and how it fits into the surrounding system. Be specific and concise. Reference actual function names and line numbers where helpful.

File: ${basename(resolved)}

${contents}`;

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, think: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } catch (e) {
    console.error(`[wire] Ollama unreachable: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[wire] To escalate online: wire prep-online <project> "explain ${basename(resolved)}"`);
    appendLedgerEntry({ project: "workspace", taskType: "explain_file", localModel: model, onlineModel: "none", escalationReason: "ollama unreachable", resultStatus: "failed" });
    process.exit(1);
  }

  try {
    const data = await res.json() as { response?: string };
    const explanation = data.response?.trim() ?? "";
    if (!explanation) throw new Error("empty response field");

    console.log(`\n=== Explanation: ${basename(resolved)} (${model}) ===\n`);
    console.log(explanation);

    appendLedgerEntry({
      project: "workspace",
      taskType: "explain_file",
      localModel: model,
      onlineModel: "none",
      escalationReason: "local sufficient",
      resultStatus: "success",
    });
  } catch (e) {
    console.error(`[wire] Ollama returned unparseable response (model crash?): ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[wire] To escalate online: wire prep-online <project> "explain ${basename(resolved)}"`);
    appendLedgerEntry({ project: "workspace", taskType: "explain_file", localModel: model, onlineModel: "none", escalationReason: "ollama bad response", resultStatus: "failed" });
    process.exit(1);
  }
}
