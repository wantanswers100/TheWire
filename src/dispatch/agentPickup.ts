import { spawnSync } from "node:child_process";
import { spawnAsync } from "./spawnAsync.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { buildProviderFallbackPlan, formatProviderFallbackPlan } from "../router/providerFallback.js";
import { AGENT_IDS, type AgentId } from "../types.js";
import { guardPrompt, scanForSecrets } from "../security/prompt-guard.js";
import { runCodex, runLlama4, runOllama, commandInvocationForAgent, runGemini, runAgy } from "./workers.js";
import { parseAgentHandoffFile } from "./agentHandoff.js";
import type { MarkdownAgentToken } from "./agentHandoff.js";
import { defaultAgentInboxDir, getAgentStatusGroups } from "./agentWatchLoop.js";
import { DispatchDB } from "./db.js";
import type { DispatchRecord } from "./db.js";

export interface AgentRunResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface AgentPickupDeps {
  runAgent?: (agent: MarkdownAgentToken, prompt: string) => AgentRunResult | Promise<AgentRunResult>;
  runFallback?: (agent: AgentId, skill: string, sourceContent: string) => AgentRunResult | Promise<AgentRunResult>;
  now?: () => Date;
  beforeClaim?: (record: DispatchRecord) => void;
}

export interface AgentPickupResult {
  ok: boolean;
  lines: string[];
  resultFile?: string;
  dispatchId?: string;
}

// Re-exported for backward compatibility — canonical definition + implementation
// now live in workers.ts (single source of truth, see 2026-08-12 DEVLOG entry).
export type { AgentCommandInvocation } from "./workers.js";
export { commandInvocationForAgent } from "./workers.js";

const EXECUTABLE_AGENT_SET = new Set<MarkdownAgentToken>(["claude", "codex", "gemini", "ollama", "antigravity"]);
const PROVIDER_AGENT_SET = new Set<string>(AGENT_IDS);

function commandForAgent(agent: MarkdownAgentToken): string | null {
  if (agent === "claude") return "claude";
  // gemini CLI removed — IneligibleTierError (exit 46); gemini pickup now routes via REST API
  if (agent === "ollama") return "ollama";
  return null;
}

function yyyymmddHhmmss(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeBasename(value: string): string | null {
  const b = basename(value);
  return b === value && b.length > 0 ? b : null;
}

function selectNextReady(stateDir: string, agent: MarkdownAgentToken): DispatchRecord | null {
  return getAgentStatusGroups(stateDir, 50, agent).ready[0] ?? null;
}

function buildPrompt(sourceFile: string, sourceContent: string): string {
  return [
    "You are responding to a Wire Markdown handoff.",
    "",
    "Rules:",
    "- Provide a concise answer or review.",
    "- Do not modify files.",
    "- Do not run shell commands.",
    "- If you cannot complete the request, say why and suggest the safest fallback.",
    "",
    `Source handoff: ${sourceFile}`,
    "",
    sourceContent,
  ].join("\n");
}

async function runAgentCli(agent: MarkdownAgentToken, prompt: string, skill = "research"): Promise<AgentRunResult> {
  if (agent === "codex") {
    try {
      const result = await runCodex("review", {
        verb: "review",
        domain: ["wire", "handoff"],
        subject: "Respond to this Wire Markdown handoff.",
        output: { format: "prose", maxTokens: 1024 },
      }, prompt);
      return { ok: true, output: result.text };
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Gemini CLI (exit 46 IneligibleTierError) — route via REST API instead (ISS-054)
  if (agent === "gemini") {
    try {
      const result = await runGemini("research", {
        verb: "review",
        domain: ["wire", "handoff"],
        subject: "Respond to this Wire Markdown handoff.",
        output: { format: "prose", maxTokens: 1024 },
      }, prompt);
      return { ok: true, output: result.text };
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  if (agent === "antigravity") {
    try {
      const result = await runAgy(skill, {
        verb: "review",
        domain: ["wire", "handoff"],
        subject: "Respond to this Wire Markdown handoff.",
        output: { format: "prose", maxTokens: 1024 },
      }, prompt);
      return { ok: true, output: result.text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[pickup] antigravity: runAgy failed — ${msg}`);
      return { ok: false, output: "", error: msg };
    }
  }

const _whichCache: Record<string, boolean> = {};
  const cmd = commandForAgent(agent);
  if (!cmd) return { ok: false, output: "", error: `${agent} has no pickup adapter configured` };

  if (_whichCache[cmd] === undefined) {
    const which = spawnSync("which", [cmd], { encoding: "utf8" });
    _whichCache[cmd] = which.status === 0;
  }

  if (!_whichCache[cmd]) {
    return { ok: false, output: "", error: `${cmd} command not found; ${agent} app/CLI is not available` };
  }

  const invocation = commandInvocationForAgent(agent, prompt);
  if (!invocation) return { ok: false, output: "", error: `${agent} has no pickup adapter configured` };

  const run = await spawnAsync(cmd, invocation.args, {
    input: invocation.input,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  } as any);

  const output = [run.stdout, run.stderr].filter(Boolean).join("\n").trim();
  if (run.error) return { ok: false, output, error: run.error.message };
  if (run.status !== 0) return { ok: false, output, error: `${cmd} exited ${run.status ?? "null"}` };
  if (!output) return { ok: false, output, error: `${cmd} returned no output` };
  return { ok: true, output };
}

function asProviderAgent(agent: string): AgentId | null {
  return PROVIDER_AGENT_SET.has(agent) ? agent as AgentId : null;
}

function fallbackPlan(record: DispatchRecord, parent: MarkdownAgentToken) {
  const agentId = asProviderAgent(parent);
  const targetId = asProviderAgent(record.routed_to);
  if (!agentId || !targetId) return null;
  return buildProviderFallbackPlan({
    skill: record.skill,
    parentAgent: agentId,
    states: { [targetId]: "failed" } as Partial<Record<AgentId, "failed">>,
  });
}

function fallbackLines(record: DispatchRecord, parent: MarkdownAgentToken): string[] {
  const plan = fallbackPlan(record, parent);
  if (!plan) return [`No provider fallback plan is available for parent '${parent}' and target '${record.routed_to}'.`];
  return formatProviderFallbackPlan(plan).split("\n");
}

function quarantineSelectedRecord(db: DispatchDB, record: DispatchRecord, reason: string): void {
  db.update(record.id, { status: "quarantined", error: reason });
}

async function runFreeFallback(agent: AgentId, skill: string, sourceContent: string): Promise<AgentRunResult> {
  const payload = {
    verb: "review",
    domain: ["wire", "handoff"],
    subject: "Respond to this Wire Markdown handoff.",
    output: { format: "prose", maxTokens: 1024 },
  };

  try {
    if (agent === "llama4") {
      const r = await runLlama4(skill, payload, sourceContent);
      return { ok: true, output: `[fallback: llama4/${r.model ?? "unknown"}]\n\n${r.text}` };
    }
    if (agent === "ollama") {
      const r = await runOllama(skill, payload, sourceContent);
      return { ok: true, output: `[fallback: ollama/${r.model ?? "unknown"}]\n\n${r.text}` };
    }
    return { ok: false, output: "", error: `${agent} is not an automatic free fallback adapter` };
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
}

function resultSenderFor(agent: AgentId | MarkdownAgentToken): MarkdownAgentToken {
  return agent === "llama4" || agent === "deepseek" || agent === "system" ? "ollama" : agent as MarkdownAgentToken;
}

function writeResultHandoff(inboxDir: string, record: DispatchRecord, to: string, from: MarkdownAgentToken, output: string, now: Date, provider?: string): string {
  const project = record.project ?? "unknown";
  const stamp = yyyymmddHhmmss(now);
  const file = `${from}_${to}_${stamp}_${project}_${record.id.slice(0, 12)}.md`.replace(/[^A-Za-z0-9_.-]/g, "-");
  const path = join(inboxDir, file);
  const content = [
    "---",
    `from: ${from}`,
    `to: ${to}`,
    `target: ${to}`,
    `date: ${now.toISOString()}`,
    `project: ${project}`,
    "status: actioned",
    `work_type: ${record.skill}`,
    ...(provider ? [`provider: ${provider}`] : []),
    `source_handoff: ${record.source_file ?? ""}`,
    `dispatch_id: ${record.id}`,
    "---",
    "",
    output.trim(),
    "",
  ].join("\n");
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  return path;
}

export async function pickupCore(
  stateDir: string,
  agent: MarkdownAgentToken,
  inboxDir: string = defaultAgentInboxDir(),
  deps: AgentPickupDeps = {},
): Promise<AgentPickupResult> {
  if (!EXECUTABLE_AGENT_SET.has(agent)) {
    return {
      ok: false,
      lines: [
        `Refused: ${agent} has no pickup adapter configured.`,
        `Use: wire agent status ${agent}`,
      ],
    };
  }

  const record = selectNextReady(stateDir, agent);
  if (!record) {
    return { ok: true, lines: [`No awaiting handoff for ${agent}.`] };
  }

  const sourceFile = record.source_file ? safeBasename(record.source_file) : null;
  if (!sourceFile) {
    const reason = `unsafe or missing source_file: ${record.source_file ?? "(missing)"}`;
    quarantineSelectedRecord(new DispatchDB(stateDir), record, reason);
    return { ok: false, dispatchId: record.id, lines: [`Refused: dispatch row ${record.id} has no safe source_file; row quarantined.`] };
  }

  const sourcePath = join(inboxDir, sourceFile);
  if (!existsSync(sourcePath)) {
    const reason = `source handoff missing: ${sourcePath}`;
    quarantineSelectedRecord(new DispatchDB(stateDir), record, reason);
    return { ok: false, dispatchId: record.id, lines: [`Refused: source handoff missing: ${sourcePath}; row quarantined.`] };
  }

  const parsed = parseAgentHandoffFile(sourcePath);
  if (!parsed.ok) {
    const reason = `source handoff no longer validates: ${parsed.errors.map(e => `[${e.field}] ${e.message}`).join("; ")}`;
    quarantineSelectedRecord(new DispatchDB(stateDir), record, reason);
    return {
      ok: false,
      dispatchId: record.id,
      lines: [`Refused: source handoff no longer validates; row quarantined.`, ...parsed.errors.map(e => `  [${e.field}] ${e.message}`)],
    };
  }

  const sourceContent = readFileSync(sourcePath, "utf8");
  const secretScan = scanForSecrets(sourceContent, sourcePath);
  if (secretScan.secretsFound) {
    const reason = `secret pattern(s) detected in source handoff: ${secretScan.findings.join(", ")}`;
    quarantineSelectedRecord(new DispatchDB(stateDir), record, reason);
    return {
      ok: false,
      dispatchId: record.id,
      lines: [
        `Refused: source handoff contains secret-like material; row quarantined.`,
        `  dispatch_id: ${record.id}`,
        `  findings: ${secretScan.findings.join(", ")}`,
        `  no agent invoked, no fallback invoked, no result handoff written`,
      ],
    };
  }
  const guardedSourceContent = guardPrompt(sourceContent, sourcePath);
  const prompt = buildPrompt(sourceFile, guardedSourceContent);
  const db = new DispatchDB(stateDir);
  deps.beforeClaim?.(record);
  if (!db.claimAwaiting(record.id)) {
    return {
      ok: false,
      dispatchId: record.id,
      lines: [
        `Refused: dispatch row ${record.id} was already claimed or is no longer awaiting human approval.`,
        `  no agent invoked, no fallback invoked, no result handoff written`,
      ],
    };
  }

  const run = await (deps.runAgent ?? ((a: MarkdownAgentToken, p: string) => runAgentCli(a, p, record.skill)))(agent, prompt);
  if (!run.ok) {
    const err = [run.error, run.output].filter(Boolean).join(" — ");
    const plan = fallbackPlan(record, parsed.request.from);
    if (plan?.action === "switch_alternate" && (plan.selectedAgent === "llama4" || plan.selectedAgent === "ollama")) {
      if (plan.selectedAgent === "llama4" && parsed.request.allow_online_fallback !== true) {
        db.update(record.id, { status: "failed", error: `${err}; online fallback llama4 blocked because allow_online_fallback is not true` });
        return {
          ok: false,
          dispatchId: record.id,
          lines: [
            `${agent} pickup FAILED — ${sourceFile}`,
            `  dispatch_id: ${record.id}`,
            `  error: ${err}`,
            `  online fallback blocked: add allow_online_fallback: true to the handoff only when online provider egress is approved`,
            "",
            "Fallback guidance:",
            ...formatProviderFallbackPlan(plan).split("\n"),
          ],
        };
      }
      const fallback = await (deps.runFallback ?? runFreeFallback)(plan.selectedAgent, record.skill, guardedSourceContent);
      if (fallback.ok) {
        const resultPath = writeResultHandoff(inboxDir, record, parsed.request.from, resultSenderFor(plan.selectedAgent), fallback.output, deps.now?.() ?? new Date(), plan.selectedAgent);
        db.update(record.id, { status: "done", result_id: basename(resultPath), error: `${agent} failed; fallback ${plan.selectedAgent} succeeded: ${err}` });
        return {
          ok: true,
          dispatchId: record.id,
          resultFile: resultPath,
          lines: [
            `${agent} pickup failed, fallback ${plan.selectedAgent} completed — ${sourceFile}`,
            `  dispatch_id: ${record.id}`,
            `  primary_error: ${err}`,
            `  result handoff: ${resultPath}`,
          ],
        };
      }

      const fallbackErr = [fallback.error, fallback.output].filter(Boolean).join(" — ");
      db.update(record.id, { status: "failed", error: `${err}; fallback ${plan.selectedAgent} failed: ${fallbackErr}` });
      return {
        ok: false,
        dispatchId: record.id,
        lines: [
          `${agent} pickup FAILED — ${sourceFile}`,
          `  dispatch_id: ${record.id}`,
          `  error: ${err}`,
          `  fallback ${plan.selectedAgent} also failed: ${fallbackErr}`,
          "",
          "Fallback guidance:",
          ...formatProviderFallbackPlan(plan).split("\n"),
        ],
      };
    }

    db.update(record.id, { status: "failed", error: err });
    return {
      ok: false,
      dispatchId: record.id,
      lines: [
        `${agent} pickup FAILED — ${sourceFile}`,
        `  dispatch_id: ${record.id}`,
        `  error: ${err}`,
        "",
        "Fallback guidance:",
        ...fallbackLines(record, parsed.request.from),
      ],
    };
  }

  const resultPath = writeResultHandoff(inboxDir, record, parsed.request.from, agent, run.output, deps.now?.() ?? new Date());
  db.update(record.id, { status: "done", result_id: basename(resultPath), error: null });
  return {
    ok: true,
    dispatchId: record.id,
    resultFile: resultPath,
    lines: [
      `${agent} pickup complete — ${sourceFile}`,
      `  dispatch_id: ${record.id}`,
      `  result handoff: ${resultPath}`,
    ],
  };
}
