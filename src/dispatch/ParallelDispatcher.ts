// ParallelDispatcher — concurrent subtask execution with per-task timeouts
//
// Safety invariants:
//   - All subtask IDs must be distinct (asserted via Set before dispatch)
//   - HITL skills rejected at submission (implement, architect, scaffold, refactor, wire)
//   - crypto.randomBytes(16) for nonce generation when caller doesn't provide subtaskId
//   - Promise.allSettled NOT Promise.all — partial failure doesn't abort the group

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runOllama, runGemini, runLlama4 } from "./workers.js";
import { ResultMerger } from "./ResultMerger.js";
import type { AgentId } from "../types.js";
import type {
  ParallelTask,
  ParallelDispatchRequest,
  SubtaskResult,
  ParallelDispatchResult,
} from "./parallel-types.js";

const HITL_SKILLS = new Set(["implement", "architect", "scaffold", "refactor", "wire"]);
const DEFAULT_TIMEOUT_MS = 30_000;

export class ParallelDispatcher {
  private db: Database;
  private merger: ResultMerger;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "parallel.db"));
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS parallel_groups (
        parentTaskId TEXT NOT NULL,
        subtaskId    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        result       TEXT,
        error        TEXT,
        started_at   INTEGER NOT NULL,
        finished_at  INTEGER,
        PRIMARY KEY (parentTaskId, subtaskId)
      )
    `);
    this.merger = new ResultMerger();
  }

  async dispatch(req: ParallelDispatchRequest): Promise<ParallelDispatchResult> {
    const { parentTaskId, tasks } = req;

    // Guard: HITL skill rejection
    for (const task of tasks) {
      if (HITL_SKILLS.has(task.skill)) {
        throw new Error(
          `ParallelDispatcher: skill '${task.skill}' requires HITL approval and cannot run in parallel batch`
        );
      }
    }

    // Guard: all subtask IDs must be distinct
    const idSet = new Set(tasks.map(t => t.subtaskId));
    if (idSet.size !== tasks.length) {
      throw new Error("ParallelDispatcher: duplicate subtaskId values in request");
    }

    // Register all subtasks in SQLite before dispatching
    const now = Date.now();
    for (const task of tasks) {
      this.db.run(
        "INSERT OR REPLACE INTO parallel_groups (parentTaskId, subtaskId, status, started_at) VALUES (?,?,?,?)",
        [parentTaskId, task.subtaskId, "running", now]
      );
    }

    const start = Date.now();

    // Dispatch all concurrently — allSettled never throws
    const settled = await Promise.allSettled(
      tasks.map(task => this.runTask(parentTaskId, task))
    );

    const results: SubtaskResult[] = settled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      // Promise.allSettled rejection shouldn't happen (runTask catches internally)
      const task = tasks[i]!;
      return {
        subtaskId: task.subtaskId,
        skill: task.skill,
        subject: task.subject,
        status: "failed" as const,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        durationMs: Date.now() - now,
      };
    });

    let merged: string | undefined;
    if (req.mergeResults && results.length > 0) {
      const successes = results.filter(r => r.status === "success");
      if (successes.length > 0) {
        merged = await this.merger.merge(successes).catch(() => undefined);
      }
    }

    return {
      parentTaskId,
      results,
      merged,
      successCount: results.filter(r => r.status === "success").length,
      failureCount: results.filter(r => r.status !== "success").length,
      totalDurationMs: Date.now() - start,
    };
  }

  private async runTask(parentTaskId: string, task: ParallelTask): Promise<SubtaskResult> {
    const start = Date.now();
    const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const payload = {
      format: "task",
      verb: "query",
      domain: task.domain,
      subject: task.subject,
      output: { format: "prose" },
    };

    const agent = task.preferredAgent ?? this.chooseAgent(task.skill);

    const runPromise = this.callWorker(agent, task.skill, payload);
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    let output: string;
    let agentUsed = agent;
    let tokensUsed: number | undefined;

    try {
      const result = await Promise.race([runPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);
      output = result.text;
      tokensUsed = result.tokensUsed;

      this.db.run(
        "UPDATE parallel_groups SET status=?, result=?, finished_at=? WHERE parentTaskId=? AND subtaskId=?",
        ["success", output.slice(0, 2000), Date.now(), parentTaskId, task.subtaskId]
      );

      return {
        subtaskId: task.subtaskId,
        skill: task.skill,
        subject: task.subject,
        status: "success",
        output,
        agentUsed,
        tokensUsed,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      clearTimeout(timeoutHandle);
      const isTimeout = err instanceof Error && err.message.startsWith("timeout");
      const error = err instanceof Error ? err.message : String(err);

      this.db.run(
        "UPDATE parallel_groups SET status=?, error=?, finished_at=? WHERE parentTaskId=? AND subtaskId=?",
        [isTimeout ? "timeout" : "failed", error, Date.now(), parentTaskId, task.subtaskId]
      );

      return {
        subtaskId: task.subtaskId,
        skill: task.skill,
        subject: task.subject,
        status: isTimeout ? "timeout" : "failed",
        error,
        durationMs: Date.now() - start,
      };
    }
  }

  private chooseAgent(skill: string): AgentId {
    // Simple routing: research → gemini, everything else → ollama
    if (skill === "research" || skill === "plan") return "gemini";
    if (skill === "quick" || skill === "summarize" || skill === "explain") return "ollama";
    return "llama4";
  }

  private async callWorker(agent: AgentId, skill: string, payload: Record<string, unknown>) {
    switch (agent) {
      case "gemini": return runGemini(skill, payload);
      case "llama4": return runLlama4(skill, payload);
      default:       return runOllama(skill, payload);
    }
  }

  // Generate a cryptographically random subtask ID
  static newSubtaskId(): string {
    return randomBytes(16).toString("hex");
  }

  // Retrieve results for a parent task (for polling / result retrieval)
  getGroupResults(parentTaskId: string): Array<{ subtaskId: string; status: string; result: string | null; error: string | null }> {
    return this.db.query(
      "SELECT subtaskId, status, result, error FROM parallel_groups WHERE parentTaskId=? ORDER BY started_at ASC"
    ).all(parentTaskId) as Array<{ subtaskId: string; status: string; result: string | null; error: string | null }>;
  }
}
