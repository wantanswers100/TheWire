// Router types — Wire Platform task router

import type { AgentId } from "../types.js";
export type { AgentId };
export type OllamaModel =
  | "qwen3:1.7b"
  | "qwen3:4b"
  | "qwen2.5-coder:14b"
  | "nomic-embed-text"
  | "deepseek-r1:8b"   // restricted: code/math only — see scratch/deepseek-lab/docs/routing-decision.md
  // legacy — kept so old .env values don't break at parse time
  | "phi3:mini" | "phi3.5" | "codegemma:2b" | "qwen2.5-coder:7b";

// Cost tier — controls free-first vs quality-first preference
export type CostTier = "free" | "low" | "high";

export interface AgentProfile {
  id: AgentId;
  costTier: CostTier;
  ollamaModel?: OllamaModel;   // only set for ollama
  strengths: string[];          // skill/domain keywords this agent excels at
  maxTokens?: number;
  notes?: string;
}

// A routing rule: when these conditions match, prefer this agent
export interface RoutingRule {
  skill?: string;
  verbs?: string[];             // matches any verb in the list
  domains?: string[];           // matches if task domain overlaps
  preferredAgent: AgentId;
  fallbackChain: AgentId[];     // try these in order if preferred is unavailable
  costTier: CostTier;           // minimum cost tier acceptable for this rule
  notes?: string;
}

// The input the router evaluates
export interface RoutingRequest {
  skill: string;
  verb?: string;
  domains?: string[];
  type: string;                 // task | result | handoff | ping
  costPreference?: "free-first" | "quality-first";  // default: quality-first
  /** Optional: restrict routing to only these agent IDs. When absent, all agents eligible. */
  modelFilter?: Set<AgentId>;
}

// What the router returns
export interface RoutingDecision {
  agent: AgentId;
  ollamaModel?: OllamaModel;
  rule: string;                 // which rule matched (for logging)
  fallbacksAvailable: AgentId[];
  costTier: CostTier;
  decompositionType?: "functional" | "temporal" | "spatial" | "resource";
}

// One entry in the learning history
export interface RoutingHistoryEntry {
  ts: number;
  taskId: string;
  skill: string;
  verb: string;
  domains: string[];
  agent: AgentId;
  status: "success" | "partial" | "failed";
  confidence?: number;          // from ResultSpec if available
  rule: string;
}

// Accumulated weights per (skill+domain → agent)
export interface RoutingWeights {
  // key: `${skill}:${domain}:${agent}` → score 0.0–1.0
  [key: string]: number;
}
