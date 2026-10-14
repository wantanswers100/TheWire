// wire diagnose <project> [--local] [--write-inbox]
//
// Multi-angle project health assessment. Reads project context and runs:
//   - Local code analysis via qwen2.5-coder:14b
//   - Security surface scan (pattern-based, attacker's-eye)
//   - Generates structured findings + escalation prompts for Claude agents
//
// Flags:
//   --local         Run only local Ollama analysis (no escalation prompt)
//   --write-inbox   Write findings as agent handoff to ~/projects/inbox/
//   --full          Include all three agent prompts (Security + Engineer + Architect)
//
// Usage:
//   wire diagnose agent-wire
//   wire diagnose my-app --full --write-inbox

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL, OLLAMA_DEFAULT_MODEL } from "../config/models.js";
import { appendLedgerEntry } from "./usage-ledger.js";
import { guardPrompt } from "../security/prompt-guard.js";
// ISS-031: sourced from config/paths.ts, not redefined locally — this
// file's own definition skipped the process.env["HOME"] override every
// other canonical copy used, a live divergence risk under sudo/containers.
import { INBOX_DIR } from "../config/paths.js";

const ACTIVE_DIR = join(homedir(), "projects", "active");

interface ProjectContext {
  name: string;
  path: string;
  contextMd:   string;
  claudeMd:    string;
  statusMd:    string;
  issuesMd:    string;
  readmeMd:    string;
}

function loadProject(projectName: string): ProjectContext {
  const projectPath = join(ACTIVE_DIR, projectName);
  const read = (f: string) => existsSync(join(projectPath, f)) ? readFileSync(join(projectPath, f), "utf8") : "";
  // Sanitize file content before it is injected into LLM prompts
  return {
    name:      projectName,
    path:      projectPath,
    contextMd: guardPrompt(read("CONTEXT.md"), `${projectName}/CONTEXT.md`),
    claudeMd:  guardPrompt(read("CLAUDE.md"),  `${projectName}/CLAUDE.md`),
    statusMd:  guardPrompt(read("STATUS.md"),  `${projectName}/STATUS.md`),
    issuesMd:  guardPrompt(read("ISSUES.md"),  `${projectName}/ISSUES.md`),
    readmeMd:  guardPrompt(read("README.md"),  `${projectName}/README.md`),
  };
}

function securityScan(ctx: ProjectContext): string[] {
  const findings: string[] = [];
  const all = [ctx.claudeMd, ctx.statusMd, ctx.contextMd].join("\n");

  if (/sk-ant-[a-zA-Z0-9]{10,}|AIza[a-zA-Z0-9_-]{20,}/.test(all))
    findings.push("WARN: Possible API key detected — audit for hardcoded secrets");
  if (/(?:api[_-]?key|password|secret)\s*[:=]\s*['"]?\S{8,}/i.test(all))
    findings.push("WARN: Possible credential assignment detected — audit for hardcoded secrets");
  if (/TODO.*auth|FIXME.*auth|auth.*pending/i.test(all))
    findings.push("WARN: Pending auth work noted — verify before any external exposure");
  if (/sql.*raw|exec.*query|string.*concat.*query/i.test(all))
    findings.push("WARN: Possible raw SQL pattern — check for injection risk");
  if (/no.*validation|skip.*validation|bypass.*check/i.test(all))
    findings.push("WARN: Validation skip language detected — review input handling");
  if (!ctx.claudeMd)
    findings.push("INFO: No CLAUDE.md — project has no agent operating constraints documented");
  if (!ctx.issuesMd)
    findings.push("INFO: No ISSUES.md — no active blocker tracking");

  return findings.length ? findings : ["PASS: No obvious security patterns flagged in project docs"];
}

function buildLocalPrompt(ctx: ProjectContext): string {
  return `You are a senior software engineer doing a project health assessment. Be direct, specific, and prioritize actionable findings.

Project: ${ctx.name}
Path: ${ctx.path}

${ctx.contextMd ? `## Current State (CONTEXT.md)\n${ctx.contextMd.slice(0, 500)}\n` : ""}
${ctx.statusMd  ? `## Status\n${ctx.statusMd.slice(0, 600)}\n`  : ""}
${ctx.issuesMd  ? `## Open Issues\n${ctx.issuesMd.slice(0, 400)}\n`  : ""}
${ctx.claudeMd  ? `## Operating Constraints (CLAUDE.md excerpt)\n${ctx.claudeMd.slice(0, 400)}\n` : ""}

Provide a structured health assessment with:
1. Overall status (1-2 sentences)
2. Top 3 technical risks or gaps
3. Recommended next action (one specific step)

Keep the response under 300 words. No fluff.`;
}

function buildSilasPrompt(ctx: ProjectContext): string {
  return `You are a security reviewer — an offensive-security specialist. Methodical, adversarial mindset.

Project under assessment: ${ctx.name} at ${ctx.path}

${ctx.contextMd ? `Current stage: ${ctx.contextMd.slice(0, 300)}\n` : ""}
${ctx.claudeMd  ? `Operating constraints:\n${ctx.claudeMd.slice(0, 500)}\n` : ""}

Perform a security surface assessment. For each surface identified:
- Name the attack vector
- Estimate exploitability (HIGH/MEDIUM/LOW)
- Recommend a specific mitigation

Focus on: auth gaps, data exposure, injection vectors, privilege escalation, dependency risks.
Report findings as a numbered list. Under 400 words.`;
}

function buildEngineerPrompt(ctx: ProjectContext): string {
  return `You are a principal engineer (Fortune 10 background). Assess this project for code quality and architectural risks.

Project: ${ctx.name}
${ctx.contextMd ? `\nCurrent state: ${ctx.contextMd.slice(0, 500)}` : ""}
${ctx.statusMd  ? `\nStatus: ${ctx.statusMd.slice(0, 500)}` : ""}
${ctx.claudeMd  ? `\nConstraints: ${ctx.claudeMd.slice(0, 400)}` : ""}

Provide:
1. Architecture assessment (is it sound for its stated purpose?)
2. Top 3 code quality risks
3. Missing patterns or abstractions that will hurt at scale
4. Recommended Phase N deliverable to address the biggest gap

Under 400 words. Specific, not generic.`;
}

function buildArchitectPrompt(ctx: ProjectContext): string {
  return `You are a systems architect specializing in distributed systems. Assess this project for long-term scalability and integration readiness.

Project: ${ctx.name}
${ctx.contextMd ? `\nCurrent state: ${ctx.contextMd.slice(0, 500)}` : ""}
${ctx.statusMd  ? `\nStatus: ${ctx.statusMd.slice(0, 400)}` : ""}

Assess:
1. Is the current architecture extensible for multi-user or open-source distribution?
2. What integration points are missing (APIs, plugins, webhooks)?
3. What would break first under 10x load?
4. Recommended architectural investment for production readiness

Under 400 words. Actionable.`;
}

async function runLocalAnalysis(ctx: ProjectContext): Promise<{ ok: boolean; text: string }> {
  const model = OLLAMA_SKILL_MODEL["local_code"] ?? OLLAMA_DEFAULT_MODEL;
  const prompt = buildLocalPrompt(ctx);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, stream: false, think: false }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { response?: string };
    return { ok: true, text: data.response?.trim() ?? "(empty response)" };
  } catch (e) {
    return { ok: false, text: `[wire] Local analysis unavailable: ${e instanceof Error ? e.message : String(e)}\nRun wire status to check Ollama.` };
  }
}

function writeInboxHandoff(ctx: ProjectContext, localAnalysis: string, secFindings: string[]): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const filename = `claude_claude_${ts}_diagnose-${ctx.name}.md`;
  const filepath = join(INBOX_DIR, filename);

  const content = `---
from: claude
to: claude
target: claude
date: ${new Date().toISOString()}
project: ${ctx.name}
status: pending
work_type: diagnose
---

# Wire Diagnose — ${ctx.name}
Generated: ${new Date().toISOString()}

## Local Analysis (qwen2.5-coder:14b)
${localAnalysis}

## Security Surface Scan
${secFindings.map(f => `- ${f}`).join("\n")}

## Current Context
${ctx.contextMd || "(no CONTEXT.md)"}

## Open Issues
${ctx.issuesMd || "(no ISSUES.md)"}

## Escalation Prompts
The following prompts are ready for online agent dispatch:

### Security reviewer
\`\`\`
${buildSilasPrompt(ctx)}
\`\`\`

### Engineer (Code Quality)
\`\`\`
${buildEngineerPrompt(ctx)}
\`\`\`

### Architect (Scale + Integration)
\`\`\`
${buildArchitectPrompt(ctx)}
\`\`\`
`;

  writeFileSync(filepath, content, "utf8");
  return filepath;
}

export async function runDiagnose(args: string[]): Promise<void> {
  const localOnly   = args.includes("--local");
  const writeInbox  = args.includes("--write-inbox");
  const fullMode    = args.includes("--full");
  const nonFlags    = args.filter(a => !a.startsWith("--"));
  const projectName = nonFlags[0];

  if (!projectName) {
    console.error("Usage: wire diagnose <project-name> [--local] [--write-inbox] [--full]");
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    console.error(`[wire] Invalid project name: "${projectName}" — only letters, numbers, hyphens, and underscores are allowed.`);
    process.exit(1);
  }

  const projectPath = join(ACTIVE_DIR, projectName);
  if (!existsSync(projectPath)) {
    console.error(`[wire] Project not found: ${projectName}`);
    console.error(`  Expected: ${projectPath}`);
    process.exit(1);
  }

  console.log(`\n=== wire diagnose: ${projectName} ===\n`);

  const ctx = loadProject(projectName);

  // Security scan (pattern-based, instant)
  const secFindings = securityScan(ctx);
  console.log("── Security Scan ──────────────────────────────");
  secFindings.forEach(f => console.log(f));

  // Local analysis via qwen2.5-coder:14b
  console.log("\n── Local Analysis (qwen2.5-coder:14b) ─────────");
  console.log("[wire] Running local model analysis...");
  const localResult = await runLocalAnalysis(ctx);
  console.log(localResult.text);

  appendLedgerEntry({
    project: projectName,
    taskType: "diagnose",
    localModel: OLLAMA_SKILL_MODEL["local_code"] ?? OLLAMA_DEFAULT_MODEL,
    onlineModel: "none",
    escalationReason: localResult.ok ? "local sufficient" : "ollama unreachable",
    resultStatus: localResult.ok ? "success" : "failed",
  });
  const localAnalysis = localResult.text;

  // Escalation prompts
  if (!localOnly) {
    console.log("\n── Escalation Prompts (online agents) ─────────");

    if (fullMode) {
      console.log("\n[Security Assessment]");
      console.log(buildSilasPrompt(ctx));
      console.log("\n[Engineer — Code Quality]");
      console.log(buildEngineerPrompt(ctx));
      console.log("\n[Architect — Scale + Integration]");
      console.log(buildArchitectPrompt(ctx));
    } else {
      console.log("Use --full to print all three agent prompts (Security, Engineer, Architect).");
      console.log("Use --write-inbox to save findings + prompts to ~/projects/inbox/ for agent pickup.");
    }
  }

  // Write to inbox
  if (writeInbox) {
    try {
      mkdirSync(INBOX_DIR, { recursive: true });
      const inboxPath = writeInboxHandoff(ctx, localAnalysis, secFindings);
      console.log(`\n[wire] Findings written to inbox: ${inboxPath}`);
      console.log("[wire] Run: wire inbox  to review pending handoffs.");
    } catch (e) {
      console.error(`[wire] Could not write inbox handoff: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[wire] Check that ~/projects/inbox/ is writable or run: mkdir -p ~/projects/inbox`);
    }
  }
}
