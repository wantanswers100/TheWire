import { AGENT_PROFILES, ROUTING_RULES } from "./table.js";
import type { AgentId, CostTier, RoutingRule } from "./types.js";

export type ProviderCostClass = "local-free" | "free-tier" | "low-cost-or-free-tier" | "paid-high";

export interface ProviderPolicy {
  agent: AgentId;
  provider: string;
  costClass: ProviderCostClass;
  defaultUse: string;
  consentRequired: boolean;
  notes: string;
}

export interface ProviderPolicyFinding {
  severity: "error" | "warn";
  code: string;
  message: string;
}

export const PROVIDER_POLICIES: ProviderPolicy[] = [
  {
    agent: "ollama",
    provider: "Ollama local open-source models",
    costClass: "local-free",
    defaultUse: "quick, summarize, explain, code_review, local fallback",
    consentRequired: false,
    notes: "Runs locally; no API token spend. Preferred whenever quality is sufficient.",
  },
  {
    agent: "system",
    provider: "Local Linux/system worker",
    costClass: "local-free",
    defaultUse: "Linux/system commands with HITL shell gate",
    consentRequired: false,
    notes: "No model call by itself; execution still requires command confirmation.",
  },
  {
    agent: "llama4",
    provider: "Groq free tier",
    costClass: "free-tier",
    defaultUse: "plan, explicit llama4, free fallback for quick/summarize/explain/research",
    consentRequired: false,
    notes: "Requires GROQ_API_KEY, but policy treats it as free-tier only. Do not document it as paid.",
  },
  {
    agent: "deepseek",
    provider: "Groq free tier / Ollama local fallback",
    costClass: "free-tier",
    defaultUse: "explicit deepseek skill for code/math/logic reasoning only",
    consentRequired: false,
    notes: "Never route research, explain, summarize, or general factual work to DeepSeek.",
  },
  {
    agent: "gemini",
    provider: "Gemini free API / Gemini CLI",
    costClass: "low-cost-or-free-tier",
    defaultUse: "research, synthesis, large-context review",
    consentRequired: true,
    notes: "Use free API/key or Gemini CLI paths where available. Explicit pickup requires foreground consent — CLI/API quota may be limited.",
  },
  {
    agent: "antigravity",
    provider: "Antigravity (agy) — Gemini Flash/Pro via Google account OAuth",
    costClass: "free-tier",
    defaultUse: "research, plan, synthesis — Gemini fallback when REST API quota-hit or GEMINI_API_KEY absent",
    consentRequired: false,
    notes: "CLI subprocess only. No token counts. Tiers: flash-low/medium/high (speed), pro-low/pro-high (frontier). Default: gemini-3.7-flash-medium. Flex via AGY_RESEARCH/AGY_SYNTHESIZE env vars. Fallback position: after gemini REST, before claude.",
  },
  {
    agent: "codex",
    provider: "Codex / OpenAI (ChatGPT account auth, WebSocket Responses API)",
    costClass: "free-tier",
    defaultUse: "implement, scaffold, refactor (non-stack domains); preferred over claude for general code-class tasks",
    consentRequired: true,
    notes: "Codex dispatch requires real-TTY HITL approval; watch/status never auto-invoke. Claude remains preferred for Wire's own stack (TypeScript/Bun/Node/security/crypto). Codex CLI v0.149.1+; auth via ~/.codex/auth.json (ChatGPT session).",
  },
  {
    agent: "claude",
    provider: "Claude",
    costClass: "paid-high",
    defaultUse: "final arbitration, complex implementation, security/governance review",
    consentRequired: true,
    notes: "Use as quality/final-review fallback, not as silent first choice when free/local fits.",
  },
];

const COST_ORDER: Record<CostTier, number> = {
  free: 0,
  low: 1,
  high: 2,
};

const FREE_FIRST_SKILLS = new Set(["quick", "summarize", "explain", "code_review", "plan"]);
const DEEPSEEK_ALLOWED_SKILLS = new Set(["deepseek"]);

function profileCost(agent: AgentId): CostTier {
  return AGENT_PROFILES[agent]?.costTier ?? "high";
}

function ruleName(rule: RoutingRule): string {
  return rule.skill ?? "default";
}

function hasFreeOrLowFallback(rule: RoutingRule): boolean {
  return rule.fallbackChain.some(agent => COST_ORDER[profileCost(agent)] <= COST_ORDER.low);
}

export function auditProviderPolicy(rules: RoutingRule[] = ROUTING_RULES): ProviderPolicyFinding[] {
  const findings: ProviderPolicyFinding[] = [];

  for (const rule of rules) {
    const preferred = rule.preferredAgent;
    const preferredCost = profileCost(preferred);
    const name = ruleName(rule);

    if (preferred === "deepseek" && !DEEPSEEK_ALLOWED_SKILLS.has(name)) {
      findings.push({
        severity: "error",
        code: "deepseek-scope",
        message: `DeepSeek is restricted to code/math/logic opt-in routes; rule '${name}' must not prefer deepseek.`,
      });
    }

    if (FREE_FIRST_SKILLS.has(name) && preferredCost !== "free") {
      findings.push({
        severity: "error",
        code: "free-first-skill",
        message: `Skill '${name}' must prefer a free/local/free-tier agent, got '${preferred}' (${preferredCost}).`,
      });
    }

    if (preferredCost === "high" && name !== "wire" && !hasFreeOrLowFallback(rule)) {
      findings.push({
        severity: "warn",
        code: "high-cost-no-cheap-fallback",
        message: `Rule '${name}' prefers high-cost '${preferred}' without a free/low fallback.`,
      });
    }
  }

  const research = rules.find(r => r.skill === "research" && !r.verbs);
  if (!research) {
    findings.push({ severity: "error", code: "missing-research-rule", message: "Research route must exist and use Gemini/free-tier fallback." });
  } else {
    if (research.preferredAgent !== "gemini") {
      findings.push({ severity: "error", code: "research-not-gemini", message: `Research must prefer Gemini free/API path, got '${research.preferredAgent}'.` });
    }
    if (research.fallbackChain[0] !== "llama4") {
      findings.push({ severity: "warn", code: "research-fallback-order", message: "Research should fall back to Groq free-tier llama4 before Claude." });
    }
  }

  return findings;
}

export function formatProviderPolicy(): string {
  const lines: string[] = [];
  lines.push("Wire provider policy:");
  lines.push("  default: free/local/open-source first; paid/high-cost only by explicit gate or final fallback");
  lines.push("  secrets: presence-only checks; never print API keys or token values");
  lines.push("");
  for (const p of PROVIDER_POLICIES) {
    const consent = p.consentRequired ? "explicit consent required" : "no paid consent needed";
    lines.push(`  ${p.agent.padEnd(10)} ${p.costClass.padEnd(22)} ${consent}`);
    lines.push(`    provider: ${p.provider}`);
    lines.push(`    use:      ${p.defaultUse}`);
    lines.push(`    notes:    ${p.notes}`);
  }
  lines.push("");

  const findings = auditProviderPolicy();
  if (findings.length === 0) {
    lines.push("Policy audit: PASS — routing table preserves free-first/provider boundaries.");
  } else {
    const errors = findings.filter(f => f.severity === "error").length;
    const warns = findings.filter(f => f.severity === "warn").length;
    lines.push(`Policy audit: ${errors > 0 ? "FAIL" : "WARN"} — ${errors} error(s), ${warns} warning(s).`);
    for (const f of findings) {
      lines.push(`  [${f.severity.toUpperCase()} ${f.code}] ${f.message}`);
    }
  }

  return lines.join("\n");
}
