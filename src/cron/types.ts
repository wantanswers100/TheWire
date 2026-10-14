import { z } from "zod";
import type { SkillType } from "../types.js";
import { SkillTypeSchema } from "../schema/wirespec.js";

// ─── Forbidden skills — cannot be scheduled (require HITL TTY) ───────────────
export const CRON_FORBIDDEN_SKILLS = new Set<SkillType>([
  "implement",
  "architect",
  "scaffold",
  "refactor",
  "wire",
  "system",
]);

// ─── CronEntry — one scheduled job ───────────────────────────────────────────

export interface CronEntry {
  id: number;
  name: string;
  schedule: string;       // 5-field cron expression: "*/5 * * * *"
  skill: SkillType;
  subject: string;        // task subject dispatched on trigger
  domain: string[];       // routing domains (JSON-encoded in DB)
  enabled: boolean;
  last_run: number | null;
  next_run: number;       // Unix ms — precomputed by CronParser
  run_count: number;
  fail_count: number;
  created_at: number;
}

// ─── CronRunRecord — one execution log entry ──────────────────────────────────

export interface CronRunRecord {
  id: number;
  cron_id: number;
  started_at: number;
  finished_at: number | null;
  status: "running" | "done" | "failed" | "hitl_blocked";
  dispatch_task_id: string | null;
  error: string | null;
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

export const CronAddSchema = z.object({
  name: z.string().min(1).max(64),
  schedule: z.string().regex(
    /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/,
    "Must be a valid 5-field cron expression"
  ),
  skill: SkillTypeSchema,
  subject: z.string().min(1),
  domain: z.array(z.string()).min(1).default(["general"]),
  enabled: z.boolean().default(true),
});

export type CronAddInput = z.infer<typeof CronAddSchema>;
