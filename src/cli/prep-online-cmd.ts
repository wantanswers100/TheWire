// wire prep-online — generate a compact escalation prompt for an online model
//
// Usage:
//   wire prep-online <project-name> "<task description>"

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL, OLLAMA_DEFAULT_MODEL } from "../config/models.js";
import { appendLedgerEntry } from "./usage-ledger.js";
import { scanForSecrets } from "../security/prompt-guard.js";

function pickOnlineModel(task: string): string {
  const t = task.toLowerCase();
  if (/security|auth|exploit|vulnerability|xss|inject|csrf|token|secret/.test(t)) return "claude (online_security)";
  if (/research|news|current|latest|today|web|url/.test(t)) return "gemini (online_research)";
  return "codex (online_code)";
}

export async function runPrepOnline(args: string[]): Promise<void> {
  const nonFlags = args.filter(a => !a.startsWith("--"));
  const projectName = nonFlags[0];
  const task = nonFlags.slice(1).join(" ").trim();

  if (!projectName || !task) {
    console.error('Usage: wire prep-online <project-name> "<task description>"');
    process.exit(1);
  }

  const contextDir = join(homedir(), "projects", "active", projectName, "context");
  const briefPath = join(contextDir, "brief.md");

  if (!existsSync(briefPath)) {
    console.error(`[wire] No context pack found for: ${projectName}`);
    console.error(`  Expected: ${briefPath}`);
    console.error(`  Run: wire project-brief ${projectName} to verify the pack exists`);
    process.exit(1);
  }

  const brief = readFileSync(briefPath, "utf8");
  const surfaces = existsSync(join(contextDir, "surfaces.md"))
    ? readFileSync(join(contextDir, "surfaces.md"), "utf8")
    : "";
  const risks = existsSync(join(contextDir, "risks.md"))
    ? readFileSync(join(contextDir, "risks.md"), "utf8")
    : "";

  // Scan context pack for secrets before passing to any model (local or online).
  const secretChecks: Array<[string, string]> = [
    [brief, "brief.md"],
    [surfaces, "surfaces.md"],
    [risks, "risks.md"],
  ];
  for (const [content, filename] of secretChecks) {
    if (!content) continue;
    const { secretsFound, findings } = scanForSecrets(content, filename);
    if (secretsFound) {
      console.error(`[wire] Aborting: secret pattern(s) detected in context pack (${filename}): ${findings.join(", ")}`);
      console.error(`  Scrub the file before escalating online: ${join(contextDir, filename)}`);
      process.exit(1);
    }
  }

  const model = OLLAMA_SKILL_MODEL["local_reason"] ?? OLLAMA_DEFAULT_MODEL;
  const projectPath = join(homedir(), "projects", "active", projectName);

  const ollamaPrompt = `Generate a compact escalation prompt for an online AI model. Keep it under 400 words. Output the escalation prompt only — no preamble, no explanation.

The prompt must include:
1. Task (one sentence)
2. Project name and path
3. Relevant context excerpts from the brief below
4. Estimated files in scope (if determinable)
5. Reason for escalation

Project: ${projectName}
Path: ${projectPath}
Task: ${task}

Brief:
${brief.slice(0, 800)}

${surfaces ? `Surfaces (excerpt):\n${surfaces.slice(0, 400)}` : ""}
${risks ? `Risks (excerpt):\n${risks.slice(0, 300)}` : ""}`;

  const recommendedModel = pickOnlineModel(task);
  let escalationPrompt = "";
  let resultStatus = "success";

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: ollamaPrompt, stream: false, think: false }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status} ${res.statusText}`);
    const data = await res.json() as { response?: string };
    escalationPrompt = data.response?.trim() ?? "";
    if (!escalationPrompt) throw new Error("Ollama returned empty or non-JSON response (model crash?)");
  } catch (e) {
    // Fall back to a template-based prompt — Ollama unreachable or response unparseable
    resultStatus = "fallback";
    console.warn(`[wire] Ollama unavailable (${e instanceof Error ? e.message : String(e)}) — generating template prompt`);
    escalationPrompt = `Task: ${task}

Project: ${projectName}
Path: ${projectPath}

Context:
${brief.slice(0, 600)}

Reason for escalation: local model unavailable; task requires online model capability.

Requested output: Please complete the task above.`;
  }

  console.log(`\n=== Online Escalation Prompt ===`);
  console.log(`Recommended model: ${recommendedModel}\n`);
  console.log(escalationPrompt);

  appendLedgerEntry({
    project: projectName,
    taskType: "prep_online",
    localModel: resultStatus === "fallback" ? "none" : model,
    onlineModel: recommendedModel,
    escalationReason: "user requested online escalation",
    resultStatus,
  });
}
