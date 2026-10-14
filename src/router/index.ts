// Wire Platform Router — decides which agent handles a task
//
// Strategy: hybrid rule-based + learned weights
//   1. Match routing rules (skill, verb, domain overlap)
//   2. Apply learned weight bonuses from history (EMA on success rate)
//   3. Check agent availability (gateway up? ollama running?)
//   4. Return decision with fallback chain
//
// Cost preference: "free-first" skips paid agents when a free one can do the job.
// Default: "quality-first" — use the best agent, cost secondary.

import { ROUTING_RULES, AGENT_PROFILES, OLLAMA_MODEL_FOR_SKILL, OLLAMA_DEFAULT_MODEL } from "./table.js";
import { RouterHistory } from "./history.js";
import { classify, classifyExtended, isClassifierAvailable } from "./classifier.js";
import { SkillRouter } from "./SkillRouter.js";
import { DispatchDB } from "../dispatch/db.js";
import type { RoutingRequest, RoutingDecision, AgentId, RoutingRule } from "./types.js";
// ISS-031: sourced from config/paths.ts.
import { GATEWAY_URL as GATEWAY } from "../config/paths.js";

const OLLAMA  = "http://localhost:11434";

// ISS-023: claude used to be hardcoded always-available with zero real
// liveness signal — gemini/codex/ollama at least check gateway/Ollama
// reachability. This couldn't produce a *false success* (runClaude() still
// does its own real check and throws honestly), but it could waste a full
// attempt — up to 120s if `claude -p` hangs — before the fallback chain ever
// got a chance to skip a claude that's known-bad right now. A 5-minute
// cooldown after the most recent recorded claude failure is enough to avoid
// that wasted attempt without needing an active health-check process; it
// self-heals the moment a claude-routed task actually succeeds again.
const CLAUDE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

// ─── Availability checks ──────────────────────────────────────────────────────

async function isGatewayUp(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch { return false; }
}

async function isOllamaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch { return false; }
}

// ─── Rule matching ────────────────────────────────────────────────────────────

function domainOverlap(ruleDomains: string[] | undefined, taskDomains: string[]): boolean {
  if (!ruleDomains || ruleDomains.length === 0) return true;   // rule matches any domain
  if (taskDomains.length === 0) return true;                    // task has no domain hint
  return ruleDomains.some(d => taskDomains.includes(d));
}

function matchRule(rule: RoutingRule, req: RoutingRequest): boolean {
  if (rule.skill && rule.skill !== req.skill) return false;
  if (rule.verbs && req.verb && !rule.verbs.includes(req.verb)) return false;
  if (!domainOverlap(rule.domains, req.domains ?? [])) return false;
  return true;
}

function ruleScore(rule: RoutingRule, req: RoutingRequest): number {
  let score = 0;
  if (rule.skill === req.skill) score += 10;
  if (rule.verbs && req.verb && rule.verbs.includes(req.verb)) score += 5;
  if (rule.domains && (req.domains ?? []).some(d => rule.domains!.includes(d))) score += 3;
  return score;
}

// ─── Main router ──────────────────────────────────────────────────────────────

export class WireRouter {
  private history: RouterHistory;
  private skillRouter: SkillRouter;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.history = new RouterHistory(stateDir);
    this.skillRouter = new SkillRouter(stateDir);
  }

  async route(req: RoutingRequest): Promise<RoutingDecision> {
    const [gwUp, ollamaUp] = await Promise.all([isGatewayUp(), isOllamaUp()]);

    const costPreference = req.costPreference ?? "quality-first";
    const domains = req.domains ?? [];

    const ruleDecision = this.routeByRules(req, gwUp, ollamaUp, costPreference, domains);

    // Layer 0: skill history pre-check — override the agent pick if outcome
    // data is confident, but keep the rule's chain as fallbacks. It used to
    // return fallbacksAvailable: [], so one 503 from the history-picked agent
    // failed the whole task (ISS-066).
    const suggestedAgent = this.skillRouter.suggest(req.skill);
    if (suggestedAgent && this.isAgentAvailable(suggestedAgent, gwUp, ollamaUp)) {
      if (!req.modelFilter || req.modelFilter.size === 0 || req.modelFilter.has(suggestedAgent)) {
        const ollamaModel = suggestedAgent === "ollama"
          ? (OLLAMA_MODEL_FOR_SKILL[req.skill] ?? OLLAMA_DEFAULT_MODEL)
          : undefined;
        // Can still be empty when nothing else is available (e.g. history and
        // last-resort both pick claude) — that is terminal, not the ISS-066 bug.
        const fallbacks = [ruleDecision.agent, ...ruleDecision.fallbacksAvailable]
          .filter(a => a !== suggestedAgent && this.isAgentAvailable(a, gwUp, ollamaUp));
        return {
          agent: suggestedAgent,
          ollamaModel,
          rule: "skill-history",
          fallbacksAvailable: [...new Set(fallbacks)],
          costTier: AGENT_PROFILES[suggestedAgent]?.costTier ?? "high",
        };
      }
    }

    return ruleDecision;
  }

  private routeByRules(
    req: RoutingRequest,
    gwUp: boolean,
    ollamaUp: boolean,
    costPreference: NonNullable<RoutingRequest["costPreference"]>,
    domains: string[],
  ): RoutingDecision {

    // Find all matching rules, sorted by specificity score descending
    const matches = ROUTING_RULES
      .filter(r => matchRule(r, req))
      .map(r => ({ rule: r, score: ruleScore(r, req) }))
      .sort((a, b) => b.score - a.score);

    // Evaluate candidates in order: preferred + fallbacks
    for (const { rule } of matches) {
      const candidates = [rule.preferredAgent, ...rule.fallbackChain];

      // Apply cost filter for free-first preference
      const filtered = costPreference === "free-first"
        ? candidates.filter(a => AGENT_PROFILES[a]?.costTier === "free").concat(candidates)
        : candidates;

      // Deduplicate preserving order
      const ordered = [...new Set(filtered)];

      for (const agent of ordered) {
        // Apply model filter — skip agents not in the selected set (alternate process only)
        if (req.modelFilter && req.modelFilter.size > 0 && !req.modelFilter.has(agent)) continue;
        if (!this.isAgentAvailable(agent, gwUp, ollamaUp)) continue;

        // Apply learned weight bonus — may shift final pick
        const bonus = this.history.weightBonus(agent, req.skill, domains);

        // A negative bonus > -0.15 still allows the rule-preferred agent through.
        // Only skip if the learned bonus is very negative (consistent failures).
        if (bonus < -0.15) continue;

        const ollamaModel = agent === "ollama"
          ? (OLLAMA_MODEL_FOR_SKILL[req.skill] ?? OLLAMA_DEFAULT_MODEL)
          : undefined;

        return {
          agent,
          ollamaModel,
          rule: rule.notes ?? `${rule.skill ?? "*"}/${rule.verbs?.join(",") ?? "*"}`,
          fallbacksAvailable: ordered.filter(a =>
            a !== agent &&
            this.isAgentAvailable(a, gwUp, ollamaUp) &&
            (!req.modelFilter || req.modelFilter.size === 0 || req.modelFilter.has(a))
          ),
          costTier: AGENT_PROFILES[agent]?.costTier ?? "high",
        };
      }
    }

    // Absolute last resort — claude (always available via CLI even without gateway)
    return {
      agent: "claude",
      rule: "last-resort",
      fallbacksAvailable: [],
      costTier: "high",
    };
  }

  // Record a result for learning
  recordResult(params: {
    taskId: string;
    skill: string;
    verb: string;
    domains: string[];
    agent: AgentId;
    status: "success" | "partial" | "failed";
    confidence?: number;
    rule: string;
  }): void {
    this.history.record({ ...params, ts: Date.now() });
  }

  // Layer 2: classify free-text task description, then route
  // Returns null classifierResult if qwen3:4b unavailable or parse fails (falls through to Layer 1)
  async classifyAndRoute(taskText: string, overrides?: Partial<RoutingRequest>): Promise<RoutingDecision & { classifierResult?: { skill: string; verb: string; domains: string[]; confidence: number } }> {
    let classifierResult: { skill: string; verb: string; domains: string[]; confidence: number } | undefined;
    let decompositionType: RoutingDecision["decompositionType"] | undefined;

    const available = await isClassifierAvailable();
    if (available) {
      // Use classifyExtended for decomposition support; fall back to classify on failure
      const result = await classifyExtended(taskText);
      if (result) {
        classifierResult = result;
        if (result.decomposition?.type) {
          decompositionType = result.decomposition.type;
        }
      } else {
        const basicResult = await classify(taskText);
        if (basicResult) classifierResult = basicResult;
      }
    }

    const req: RoutingRequest = {
      skill: classifierResult?.skill ?? overrides?.skill ?? "quick",
      verb: classifierResult?.verb ?? overrides?.verb,
      domains: classifierResult?.domains ?? overrides?.domains ?? [],
      type: overrides?.type ?? "task",
      costPreference: overrides?.costPreference,
      modelFilter: overrides?.modelFilter,
    };

    const decision = await this.route(req);
    return { ...decision, classifierResult, ...(decompositionType ? { decompositionType } : {}) };
  }

  // Summary of learned weights for a skill (for debugging / display)
  weightSummary(skill: string, domains: string[]): Record<string, number> {
    const agents = ["claude", "gemini", "codex", "ollama"] as AgentId[];
    const result: Record<string, number> = {};
    for (const agent of agents) {
      const bonus = this.history.weightBonus(agent, skill, domains);
      if (bonus !== 0) result[agent] = Math.round(bonus * 100) / 100;
    }
    return result;
  }

  private isAgentAvailable(agent: AgentId, gwUp: boolean, ollamaUp: boolean): boolean {
    if (agent === "ollama") return ollamaUp;
    if (agent === "claude") return !this.claudeRecentlyFailed();
    return gwUp;                           // all others need the gateway
  }

  // ISS-023: real (if lightweight) claude liveness signal — see the cooldown
  // constant's comment above for rationale. Fails open (available) on any DB
  // read problem: a missing/unreadable dispatch.db should never itself block
  // routing to claude, only a genuine recorded failure should.
  private claudeRecentlyFailed(): boolean {
    let db: DispatchDB | undefined;
    try {
      db = new DispatchDB(this.stateDir);
      const [mostRecent] = db.listRecentByRoutedTo("claude", 1);
      if (!mostRecent || mostRecent.status !== "failed") return false;
      return Date.now() - mostRecent.updated_at < CLAUDE_FAILURE_COOLDOWN_MS;
    } catch (e) {
      console.warn(`[router] claudeRecentlyFailed: DB read failed, treating claude as available — ${(e as Error).message}`);
      return false;
    } finally {
      db?.close();
    }
  }
}
