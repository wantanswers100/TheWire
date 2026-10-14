// Parallel dispatch types — Wire Platform
// Each subtask is an isolated task dispatched concurrently.
// parentTaskId groups subtasks for result correlation.

import type { AgentId, SkillType } from "../types.js";

export interface ParallelTask {
  subtaskId: string;         // must be unique within the group (crypto.randomBytes enforced)
  skill: SkillType;
  subject: string;
  domain: string[];
  preferredAgent?: AgentId; // optional routing hint
  timeoutMs?: number;       // per-task timeout (default: 30_000)
}

export interface ParallelDispatchRequest {
  parentTaskId: string;
  tasks: ParallelTask[];
  mergeResults?: boolean;  // if true, ResultMerger synthesizes a combined answer
}

export interface SubtaskResult {
  subtaskId: string;
  skill: SkillType;
  subject: string;
  status: "success" | "failed" | "timeout";
  output?: string;
  error?: string;
  agentUsed?: AgentId;
  tokensUsed?: number;
  durationMs: number;
}

export interface ParallelDispatchResult {
  parentTaskId: string;
  results: SubtaskResult[];
  merged?: string;         // set when mergeResults=true and ResultMerger ran
  successCount: number;
  failureCount: number;
  totalDurationMs: number;
}
