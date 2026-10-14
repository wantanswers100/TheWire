// Skill loop types — outcome recording, stats, compression
// OutcomeRecord lives in src/types.ts to prevent circular imports with loop.ts

import type { OutcomeRecord, SkillType, AgentId } from "../types.js";

export type OutcomeHook = (record: OutcomeRecord) => Promise<void>;

export interface SkillRecord {
  id: number;
  skill: SkillType;
  subject: string | null;
  prompt_hash: string;
  outcome: "success" | "failed";
  agent_used: AgentId;
  tokens_used: number | null;
  result_summary: string;
  compressed_summary: string | null;
  compression_model: string;
  created_at: number;
  compressed_at: number | null;
}

export interface SkillStats {
  skill: SkillType;
  total: number;
  successes: number;
  failures: number;
  success_rate: number;         // 0.0–1.0
  avg_tokens: number | null;
  most_used_agent: AgentId | null;
}

export interface CompressionRequest {
  skill: string;
  records: SkillRecord[];
}

export interface CompressionResult {
  compressed_summary: string;
  model: string;
  compressedAt: number;
}
