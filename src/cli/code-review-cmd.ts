// wire code-review — local-first file code review via qwen2.5-coder:14b
//
// Usage:
//   wire code-review <file>             review file, print findings
//   wire code-review <file> --escalate  also print online escalation prompt

import { readFileSync, existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL, OLLAMA_DEFAULT_MODEL } from "../config/models.js";
import { appendLedgerEntry } from "./usage-ledger.js";

const SECRET_PATTERNS = [".env", ".env.local", ".env.production", ".keys/", ".wire-state/"];

function isSecretFile(path: string): boolean {
  const name = basename(path);
  return SECRET_PATTERNS.some(p => path.includes(p) || name === p.replace("/", ""));
}

function inferLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "TypeScript", js: "JavaScript", py: "Python", go: "Go",
    rs: "Rust", java: "Java", rb: "Ruby", sh: "Bash", md: "Markdown",
  };
  return map[ext] ?? (ext.toUpperCase() || "unknown");
}

export async function runCodeReview(args: string[]): Promise<void> {
  const escalate = args.includes("--escalate");
  const filePath = args.find(a => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: wire code-review <file> [--escalate]");
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
  const language = inferLanguage(resolved);
  const model = OLLAMA_SKILL_MODEL["local_review"] ?? OLLAMA_DEFAULT_MODEL;

  const prompt = `You are a code reviewer. Review this file for bugs, security issues, and code quality problems.

File: ${basename(resolved)}
Language: ${language}

${contents}

For each issue found, output exactly this format:

SEVERITY: [critical|high|medium|low|info]
LOCATION: [line number or function name]
ISSUE: [one sentence description]
REASONING: [why this is a problem]
FIX: [specific suggested fix]

After all issues, output:
CONFIDENCE: [high|medium|low]
ESCALATE: [yes|no]

If no issues found, output: NO ISSUES FOUND
Then: CONFIDENCE: high
Then: ESCALATE: no`;

  let reviewText = "";
  let resultStatus = "success";

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
    resultStatus = "failed";
    console.error(`[wire] Ollama unreachable: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[wire] To escalate online: wire prep-online <project> "code review ${basename(resolved)}"`);
    appendLedgerEntry({ project: "workspace", taskType: "code_review", localModel: model, onlineModel: "none", escalationReason: "ollama unreachable", resultStatus: "failed" });
    process.exit(1);
  }

  try {
    const data = await res.json() as { response?: string };
    reviewText = data.response?.trim() ?? "";
    if (!reviewText) throw new Error("empty response field");
  } catch (e) {
    resultStatus = "failed";
    console.error(`[wire] Ollama returned unparseable response (model crash?): ${e instanceof Error ? e.message : String(e)}`);
    console.error(`[wire] To escalate online: wire prep-online <project> "code review ${basename(resolved)}"`);
    appendLedgerEntry({ project: "workspace", taskType: "code_review", localModel: model, onlineModel: "none", escalationReason: "ollama bad response", resultStatus: "failed" });
    process.exit(1);
  }

  console.log(`\n=== Code Review: ${basename(resolved)} (${model}) ===\n`);
  console.log(reviewText);

  if (escalate) {
    console.log(`\n=== Online Escalation Prompt ===`);
    console.log(`Task: Security and quality review of ${basename(resolved)}`);
    console.log(`Project: (provide project name and path)`);
    console.log(`File: ${resolved}`);
    console.log(`Local model first-pass (${model}):\n${reviewText.slice(0, 400)}...`);
    console.log(`Reason for escalation: local review flagged ESCALATE: yes or confidence is low`);
    console.log(`Requested output: detailed review with fix patches`);
    resultStatus = "escalated";
  }

  appendLedgerEntry({
    project: "workspace",
    taskType: "code_review",
    localModel: model,
    onlineModel: escalate ? "pending" : "none",
    escalationReason: escalate ? "user requested escalation" : "local sufficient",
    resultStatus,
  });
}
