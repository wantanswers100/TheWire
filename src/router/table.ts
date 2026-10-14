// Routing table — Wire Platform
//
// Design: hybrid rule-based + weight-adjusted.
// Rules define the default preference. Weights (learned from history) can
// shift the decision when a non-default agent has a consistently better
// track record for a given skill+domain combination.
//
// Fallback chain order:
//   preferred → fallback[0] → fallback[1] → claude (always last resort)

import type { AgentProfile, RoutingRule, OllamaModel } from "./types.js";

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  claude: {
    id: "claude",
    costTier: "high",
    strengths: ["implement", "debug", "architecture", "security", "review", "wire", "handoff", "typescript", "bun", "node"],
  },
  gemini: {
    id: "gemini",
    costTier: "low",
    strengths: ["research", "query", "plan", "synthesis", "gcp", "firebase", "frontend", "react", "large-context"],
  },
  codex: {
    id: "codex",
    costTier: "low",
    strengths: ["scaffold", "boilerplate", "implement", "typescript", "api"],
  },
  ollama: {
    id: "ollama",
    costTier: "free",
    strengths: ["summarize", "quick", "explain", "code_review", "debug", "local"],
  },
  system: {
    id: "system",
    costTier: "free",
    strengths: ["system", "execute", "local", "shell", "linux"],
  },
  llama4: {
    id: "llama4",
    costTier: "free",
    strengths: ["explain", "plan", "summarize", "research", "long-context", "implement"],
    notes: "Llama 4 Scout/Maverick via Groq free tier. Scout for explain/summarize (10M ctx), Maverick for plan/research/implement.",
  },
  deepseek: {
    id: "deepseek",
    costTier: "free",
    strengths: ["debug", "analyze", "reason", "math", "code"],
    notes: "DeepSeek R1 Distill 70B via Groq free tier. Chain-of-thought reasoning model. Restricted to code/math/logic. NOT for research/explain/summarize.",
  },
  antigravity: {
    id: "antigravity",
    costTier: "free",
    strengths: ["research", "plan", "synthesis", "explain", "large-context"],
    notes: "Gemini Flash/Pro via agy CLI (Google account OAuth). Tiers: flash-low/medium/high and pro-low/pro-high. Default: gemini-3.7-flash-medium. Flex up to pro-high via AGY_RESEARCH env var. No token reporting.",
  },
};

// Skill → Ollama model override (used when ollama is selected)
// Models: qwen3:1.7b (quick/light), qwen3:4b (reasoning/classify/256K), qwen2.5-coder:14b (code)
// deepseek-r1:8b: reasoning model — routed for debug (step-by-step reasoning beats code generation
//   for bug diagnosis). Restricted to code/math only: CCP censorship confirmed, never route
//   research/explain/summarize here. See deepseek-lab battery results.
export const OLLAMA_MODEL_FOR_SKILL: Record<string, OllamaModel> = {
  quick:       "qwen3:1.7b",
  summarize:   "qwen3:1.7b",
  explain:     "qwen3:4b",
  classify:    "qwen3:4b",
  code_review: "qwen2.5-coder:14b",
  debug:       "deepseek-r1:8b",
  deepseek:    "deepseek-r1:8b",
};
export const OLLAMA_DEFAULT_MODEL: OllamaModel = "qwen3:1.7b";

// ─── Routing rules ────────────────────────────────────────────────────────────
// Evaluated top-to-bottom. First match wins.
// More specific rules (skill + verb + domain) should come before general ones.

export const ROUTING_RULES: RoutingRule[] = [
  // ── System/Linux tasks → system agent ────────────────────────────────────
  {
    skill: "system",
    verbs: ["execute"],
    preferredAgent: "system",
    fallbackChain: [],
    costTier: "free",
    notes: "Linux/shell tasks always route to the system agent — executed locally with HITL gate",
  },

  // ── Handoffs always go to claude ──────────────────────────────────────────
  {
    skill: "wire",
    preferredAgent: "claude",
    fallbackChain: [],
    costTier: "high",
    notes: "Handoff coordination is always Claude's job",
  },

  // ── DeepSeek: restricted opt-in, code/math only ──────────────────────────
  // NOT included in default routing. Invoked only via explicit `--skill deepseek`.
  // CCP-aligned censorship confirmed — never route research, explain, summarize here.
  // See scratch/deepseek-lab/docs/routing-decision.md for full assessment.
  {
    skill: "deepseek",
    preferredAgent: "deepseek",  // DeepSeek R1 Distill 70B via Groq (requires GROQ_API_KEY + network)
    fallbackChain: ["ollama"],   // local deepseek-r1:8b via Ollama if Groq unavailable
    costTier: "free",
    notes: "DeepSeek R1: Groq 70B primary (requires network), local 8B via Ollama fallback. Code/math/logic only.",
  },

  // ── Llama 4 explicit opt-in ───────────────────────────────────────────────
  {
    skill: "llama4",
    preferredAgent: "llama4",
    fallbackChain: ["gemini", "claude"],
    costTier: "free",
    notes: "Direct Llama 4 route via Groq free tier — use --skill llama4 to invoke explicitly",
  },

  // ── Free-tier tasks → ollama ──────────────────────────────────────────────
  {
    skill: "quick",
    preferredAgent: "ollama",
    fallbackChain: ["llama4", "claude"],
    costTier: "free",
    notes: "Quick tasks: qwen3:1.7b, free. llama4 fallback before Claude.",
  },
  {
    skill: "summarize",
    preferredAgent: "ollama",
    fallbackChain: ["llama4", "claude"],
    costTier: "free",
    notes: "Summarization: qwen3:1.7b local, llama4 fallback (Scout 10M ctx), then Claude.",
  },
  {
    skill: "explain",
    preferredAgent: "ollama",
    fallbackChain: ["llama4", "claude"],
    costTier: "free",
    notes: "Explanation: qwen3:4b local, llama4 Scout fallback, then Claude.",
  },
  {
    skill: "code_review",
    preferredAgent: "ollama",
    fallbackChain: ["claude"],
    costTier: "free",
    notes: "Code review: qwen2.5-coder:14b, free",
  },

  // ── Plan → llama4 first (free Maverick) ──────────────────────────────────
  {
    skill: "plan",
    preferredAgent: "llama4",
    fallbackChain: ["gemini", "antigravity", "claude"],
    costTier: "free",
    notes: "Planning: Llama 4 Maverick free via Groq, Gemini REST fallback, antigravity (agy) free fallback, Claude last resort.",
  },

  // ── Research → gemini, llama4 / antigravity as free fallbacks before Claude ──
  {
    skill: "research",
    preferredAgent: "gemini",
    fallbackChain: ["llama4", "antigravity", "claude"],
    costTier: "low",
    notes: "Research: Gemini REST primary, llama4 Groq free, antigravity (agy Gemini Pro free), Claude last resort.",
  },
  {
    skill: "research",
    verbs: ["query", "plan"],
    preferredAgent: "gemini",
    fallbackChain: ["llama4", "antigravity", "claude"],
    costTier: "low",
  },

  // ── Scaffolding → codex ───────────────────────────────────────────────────
  {
    skill: "scaffold",
    preferredAgent: "codex",
    fallbackChain: ["claude"],
    costTier: "low",
    notes: "Boilerplate and scaffolding: Codex",
  },

  // ── Implementation: TypeScript/Bun/Node → claude ──────────────────────────
  {
    skill: "implement",
    verbs: ["implement", "debug", "refactor"],
    domains: ["typescript", "bun", "node", "security", "crypto"],
    preferredAgent: "claude",
    fallbackChain: ["codex"],
    costTier: "high",
    notes: "Core implementation in stack languages: Claude",
  },

  // ── Implementation: other languages → codex first ─────────────────────────
  {
    skill: "implement",
    verbs: ["implement", "scaffold"],
    preferredAgent: "codex",
    fallbackChain: ["claude"],
    costTier: "low",
    notes: "General implementation: Codex, fallback Claude",
  },

  // ── Refactor: TypeScript/Bun/Node → claude ───────────────────────────────
  {
    skill: "refactor",
    domains: ["typescript", "bun", "node", "security", "crypto"],
    preferredAgent: "claude",
    fallbackChain: ["codex"],
    costTier: "high",
    notes: "Refactor in stack languages: Claude",
  },
  {
    skill: "refactor",
    preferredAgent: "codex",
    fallbackChain: ["claude"],
    costTier: "low",
    notes: "General refactor: Codex, fallback Claude",
  },

  // ── Debug → claude ────────────────────────────────────────────────────────
  {
    skill: "debug",
    preferredAgent: "claude",
    fallbackChain: ["ollama", "codex"],
    costTier: "high",
    notes: "Deep debugging: Claude. Ollama (qwen2.5-coder:14b) as cheap fallback",
  },

  // ── Verify / audit → claude ───────────────────────────────────────────────
  {
    skill: "verify",
    preferredAgent: "claude",
    fallbackChain: ["ollama"],
    costTier: "high",
  },
  {
    skill: "audit",
    preferredAgent: "claude",
    fallbackChain: ["ollama"],
    costTier: "high",
  },

  // ── Default fallthrough ───────────────────────────────────────────────────
  {
    preferredAgent: "claude",
    fallbackChain: ["gemini", "ollama"],
    costTier: "high",
    notes: "Default: Claude handles anything unmatched",
  },
];
