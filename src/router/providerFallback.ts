import { ROUTING_RULES, AGENT_PROFILES } from "./table.js";
import { PROVIDER_POLICIES } from "./providerPolicy.js";
import type { AgentId, RoutingRule } from "./types.js";

export type RuntimeFailureReason =
  | "not_running"
  | "auth_missing"
  | "quota_exhausted"
  | "usage_exhausted"
  | "failed"
  | "policy_blocked"
  | "timeout";

export type RuntimeAgentState = "available" | RuntimeFailureReason;

export type FallbackAction =
  | "run_target"
  | "switch_alternate"
  | "parent_continue"
  | "ask_user";

export interface ProviderFallbackInput {
  skill: string;
  parentAgent: AgentId;
  states?: Partial<Record<AgentId, RuntimeAgentState>>;
}

export interface ProviderFallbackStep {
  agent: AgentId;
  state: RuntimeAgentState;
  decision: "selected" | "skipped" | "parent" | "needs_approval";
  reason: string;
}

export interface ProviderFallbackPlan {
  skill: string;
  parentAgent: AgentId;
  action: FallbackAction;
  selectedAgent: AgentId;
  rule: string;
  steps: ProviderFallbackStep[];
  message: string;
}

const COST_ORDER = { free: 0, low: 1, high: 2 } as const;

function matchingRule(skill: string): RoutingRule {
  return ROUTING_RULES.find(r => r.skill === skill && !r.verbs) ??
    ROUTING_RULES.find(r => r.skill === skill) ??
    ROUTING_RULES[ROUTING_RULES.length - 1]!;
}

function uniqueAgents(agents: AgentId[]): AgentId[] {
  return [...new Set(agents)];
}

function stateFor(agent: AgentId, states: Partial<Record<AgentId, RuntimeAgentState>>): RuntimeAgentState {
  return states[agent] ?? "available";
}

function skipReason(state: RuntimeAgentState): string {
  switch (state) {
    case "not_running": return "target app/provider is not running";
    case "auth_missing": return "auth/key is not configured";
    case "quota_exhausted": return "free or paid quota is exhausted";
    case "usage_exhausted": return "usage allowance is exhausted";
    case "failed": return "last attempt failed";
    case "policy_blocked": return "provider policy blocks this route";
    case "timeout": return "last attempt exceeded its execution timeout (spawnSync ETIMEDOUT)";
    case "available": return "available";
  }
}

function isCheapOrFree(agent: AgentId): boolean {
  const tier = AGENT_PROFILES[agent]?.costTier ?? "high";
  return COST_ORDER[tier] <= COST_ORDER.low;
}

function requiresConsent(agent: AgentId): boolean {
  return PROVIDER_POLICIES.find(p => p.agent === agent)?.consentRequired ?? true;
}

function ruleLabel(rule: RoutingRule): string {
  return rule.notes ?? `${rule.skill ?? "default"}`;
}

export function buildProviderFallbackPlan(input: ProviderFallbackInput): ProviderFallbackPlan {
  const rule = matchingRule(input.skill);
  const candidates = uniqueAgents([rule.preferredAgent, ...rule.fallbackChain]);
  const states = input.states ?? {};
  const steps: ProviderFallbackStep[] = [];

  for (const agent of candidates) {
    const state = stateFor(agent, states);
    if (state !== "available") {
      steps.push({ agent, state, decision: "skipped", reason: skipReason(state) });
      continue;
    }

    if (agent === rule.preferredAgent) {
      steps.push({ agent, state, decision: "selected", reason: "preferred target is available" });
      return {
        skill: input.skill,
        parentAgent: input.parentAgent,
        action: "run_target",
        selectedAgent: agent,
        rule: ruleLabel(rule),
        steps,
        message: `Run ${agent}: preferred target is available.`,
      };
    }

    if (isCheapOrFree(agent) && !requiresConsent(agent)) {
      steps.push({ agent, state, decision: "selected", reason: "safe free/local/low-cost alternate is available" });
      return {
        skill: input.skill,
        parentAgent: input.parentAgent,
        action: "switch_alternate",
        selectedAgent: agent,
        rule: ruleLabel(rule),
        steps,
        message: `Switch to ${agent}: preferred target is unavailable and this alternate is safe under provider policy.`,
      };
    }

    steps.push({ agent, state, decision: "needs_approval", reason: "alternate requires user approval" });
    return {
      skill: input.skill,
      parentAgent: input.parentAgent,
      action: "ask_user",
      selectedAgent: input.parentAgent,
      rule: ruleLabel(rule),
      steps,
      message: `Ask the owner before escalating to ${agent}; parent ${input.parentAgent} should continue or wait for approval.`,
    };
  }

  const parentState = stateFor(input.parentAgent, states);
  if (parentState === "available") {
    steps.push({ agent: input.parentAgent, state: parentState, decision: "parent", reason: "no safe alternate available" });
    return {
      skill: input.skill,
      parentAgent: input.parentAgent,
      action: "parent_continue",
      selectedAgent: input.parentAgent,
      rule: ruleLabel(rule),
      steps,
      message: `No safe alternate is available; parent ${input.parentAgent} keeps ownership and continues if possible.`,
    };
  }

  steps.push({ agent: input.parentAgent, state: parentState, decision: "skipped", reason: skipReason(parentState) });
  return {
    skill: input.skill,
    parentAgent: input.parentAgent,
    action: "ask_user",
    selectedAgent: input.parentAgent,
    rule: ruleLabel(rule),
    steps,
    message: `No available safe alternate and parent ${input.parentAgent} is unavailable; ask the owner for the next path.`,
  };
}

export function formatProviderFallbackPlan(plan: ProviderFallbackPlan): string {
  const lines: string[] = [];
  lines.push("Wire provider fallback plan:");
  lines.push(`  skill:          ${plan.skill}`);
  lines.push(`  parent:         ${plan.parentAgent}`);
  lines.push(`  action:         ${plan.action}`);
  lines.push(`  selected:       ${plan.selectedAgent}`);
  lines.push(`  rule:           ${plan.rule}`);
  lines.push("");
  lines.push("Decision path:");
  for (const step of plan.steps) {
    lines.push(`  ${step.agent.padEnd(10)} ${step.state.padEnd(16)} ${step.decision.padEnd(14)} ${step.reason}`);
  }
  lines.push("");
  lines.push(plan.message);
  return lines.join("\n");
}
