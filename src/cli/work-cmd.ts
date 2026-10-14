// wire work <project> "<task>" — project-aware task dispatch
//
// Loads the project context pack, classifies the task, and either:
//   - dispatches to a local Ollama model inline (for quick/explain/review tasks)
//   - generates a compact online escalation prompt (for implement/research/security)
//
// Usage:
//   wire work my-app "why did accuracy drop this week"
//   wire work agent-wire "review the dispatch loop for race conditions"
//   wire work my-app "implement auth guard on the settings route"

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL, OLLAMA_DEFAULT_MODEL } from "../config/models.js";
import { keywordClassify } from "../router/classifier.js";
import { appendLedgerEntry } from "./usage-ledger.js";
import { guardPrompt } from "../security/prompt-guard.js";

const ACTIVE_DIR = join(homedir(), "projects", "active");

// Tier determination from classified skill
const LOCAL_QUICK_SKILLS  = new Set(["quick", "summarize", "classify"]);
const LOCAL_CODE_SKILLS   = new Set(["explain", "code_review", "debug"]);
const ONLINE_SKILLS       = new Set(["implement", "refactor", "scaffold", "research", "audit", "verify", "wire", "architect"]);

type Tier = "local_quick" | "local_code" | "online_code" | "online_research" | "online_security";

function determineTier(skill: string, task: string): Tier {
  const t = task.toLowerCase();
  if (LOCAL_QUICK_SKILLS.has(skill))  return "local_quick";
  if (LOCAL_CODE_SKILLS.has(skill))   return "local_code";
  if (/security|auth|exploit|vulner|inject|xss|csrf|secret|token|cred/.test(t)) return "online_security";
  if (/research|news|latest|current|market|trend|web/.test(t))                   return "online_research";
  return "online_code";
}

function tierToModel(tier: Tier): string {
  if (tier === "local_quick") return OLLAMA_SKILL_MODEL["local_reason"] ?? OLLAMA_DEFAULT_MODEL;
  if (tier === "local_code")  return OLLAMA_SKILL_MODEL["local_code"]   ?? OLLAMA_DEFAULT_MODEL;
  return "";
}

function tierToOnlineModel(tier: Tier): string {
  if (tier === "online_security") return "claude (online_security)";
  if (tier === "online_research") return "gemini (online_research)";
  return "codex (online_code)";
}

function loadContextPack(projectName: string): { brief: string; surfaces: string; risks: string; deliverables: string; contextMd: string } {
  const dir = join(ACTIVE_DIR, projectName, "context");
  const projectDir = join(ACTIVE_DIR, projectName);
  const read = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "";
  const contextMdPath = join(projectDir, "CONTEXT.md");
  return {
    brief:        read("brief.md"),
    surfaces:     read("surfaces.md"),
    risks:        read("risks.md"),
    deliverables: read("deliverables.md"),
    contextMd:    existsSync(contextMdPath) ? readFileSync(contextMdPath, "utf8") : "",
  };
}

async function runLocal(tier: Tier, task: string, projectName: string, pack: ReturnType<typeof loadContextPack>): Promise<void> {
  const model = tierToModel(tier);
  const isCode = tier === "local_code";

  const contextSection = [
    `Project: ${projectName}`,
    pack.contextMd ? `\n## Current Context\n${pack.contextMd.slice(0, 400)}` : "",
    pack.brief ? `\n## Project Brief\n${pack.brief.slice(0, 600)}` : "",
    isCode && pack.surfaces ? `\n## Surfaces\n${pack.surfaces.slice(0, 300)}` : "",
    isCode && pack.risks    ? `\n## Known Risks\n${pack.risks.slice(0, 300)}` : "",
  ].filter(Boolean).join("\n");

  const systemInstruction = isCode
    ? "You are a code assistant. Answer using the project context below. Be specific and concise."
    : "You are a helpful assistant. Answer using the project context below. Be concise.";

  const prompt = `${systemInstruction}

${contextSection}

Task: ${task}`;

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
    console.error(`[wire] Escalate with: wire work ${projectName} "${task}" --online`);
    appendLedgerEntry({ project: projectName, taskType: "work_local", localModel: model, onlineModel: "none", escalationReason: "ollama unreachable", resultStatus: "failed" });
    process.exit(1);
  }

  let text: string;
  try {
    const data = await res.json() as { response?: string };
    text = data.response?.trim() ?? "";
    if (!text) throw new Error("empty response field");
  } catch (e) {
    console.error(`[wire] Ollama bad response (model crash?): ${e instanceof Error ? e.message : String(e)}`);
    appendLedgerEntry({ project: projectName, taskType: "work_local", localModel: model, onlineModel: "none", escalationReason: "ollama bad response", resultStatus: "failed" });
    process.exit(1);
  }

  console.log(`\n=== wire work: ${projectName} (${model}) ===\n`);
  console.log(text);
  appendLedgerEntry({ project: projectName, taskType: "work_local", localModel: model, onlineModel: "none", escalationReason: "local sufficient", resultStatus: "success" });
}

function runOnline(tier: Tier, task: string, projectName: string, pack: ReturnType<typeof loadContextPack>): void {
  const projectPath = join(ACTIVE_DIR, projectName);
  const onlineModel = tierToOnlineModel(tier);

  const prompt = [
    `Task: ${task}`,
    ``,
    `Project: ${projectName}`,
    `Path: ${projectPath}`,
    ``,
    `## Brief`,
    pack.contextMd ? `\n## Current Context\n${pack.contextMd.slice(0, 400)}` : "",
    pack.brief ? `\n## Brief\n${pack.brief.slice(0, 700)}` : "",
    pack.surfaces ? `\n## Surfaces\n${pack.surfaces.slice(0, 400)}` : "",
    pack.risks    ? `\n## Known Risks\n${pack.risks.slice(0, 350)}` : "",
    pack.deliverables ? `\n## Current Deliverables\n${pack.deliverables.slice(0, 300)}` : "",
    ``,
    `Reason for escalation: task requires ${tier.replace("_", " ")} capability beyond local model tier.`,
    `Requested output: complete the task above.`,
  ].filter(s => s !== undefined).join("\n");

  console.log(`\n=== wire work: ${projectName} → online escalation ===`);
  console.log(`Recommended model: ${onlineModel}\n`);
  console.log(prompt);
  appendLedgerEntry({ project: projectName, taskType: "work_online", localModel: "none", onlineModel, escalationReason: `task tier: ${tier}`, resultStatus: "escalated" });
}

export async function runWork(args: string[]): Promise<void> {
  const forceOnline = args.includes("--online");
  const nonFlags = args.filter(a => !a.startsWith("--"));
  const projectName = nonFlags[0];
  const task = nonFlags.slice(1).join(" ").trim();

  if (!projectName || !task) {
    console.error('Usage: wire work <project-name> "<task description>" [--online]');
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    console.error(`[wire] Invalid project name: "${projectName}" — only letters, numbers, hyphens, and underscores are allowed.`);
    process.exit(1);
  }

  const projectDir = join(ACTIVE_DIR, projectName);
  const briefPath = join(projectDir, "context", "brief.md");
  const contextMdPath = join(projectDir, "CONTEXT.md");
  if (!existsSync(projectDir)) {
    console.error(`[wire] Project not found: ${projectName}`);
    console.error(`  Expected: ${projectDir}`);
    process.exit(1);
  }
  if (!existsSync(briefPath) && !existsSync(contextMdPath)) {
    console.error(`[wire] No context for: ${projectName}`);
    console.error(`  Add either: ${contextMdPath}  (lightweight, 8 lines)`);
    console.error(`          or: ${briefPath}  (full context pack)`);
    process.exit(1);
  }
  if (existsSync(contextMdPath) && !existsSync(briefPath)) {
    console.log(`[wire] Using CONTEXT.md (no full pack). For richer context run: wire project-brief ${projectName}`);
  }

  const pack = loadContextPack(projectName);

  // Sanitize user task input and file content before injecting into LLM prompts
  const safeTask = guardPrompt(task, "task input");
  pack.contextMd   = guardPrompt(pack.contextMd, `${projectName}/CONTEXT.md`);
  pack.brief       = guardPrompt(pack.brief, `${projectName}/context/brief.md`);
  pack.surfaces    = guardPrompt(pack.surfaces, `${projectName}/context/surfaces.md`);
  pack.risks       = guardPrompt(pack.risks, `${projectName}/context/risks.md`);

  // Classify task to determine tier
  const classified = keywordClassify(safeTask);
  const tier = forceOnline ? "online_code" : determineTier(classified.skill, safeTask);

  const isLocal = tier === "local_quick" || tier === "local_code";

  if (isLocal && !forceOnline) {
    await runLocal(tier, safeTask, projectName, pack);
  } else {
    runOnline(tier, safeTask, projectName, pack);
  }
}
