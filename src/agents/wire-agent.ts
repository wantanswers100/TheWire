// Wire Agent core — Wire Platform Phase 20
//
// Enrichment layer that sits between the dispatch loop and the workers.
// Not a daemon — instantiated once by DispatchLoop and called per task.
//
// enrich(skill, payload) — queries memory + RAG, returns context string
//   injected into the worker prompt before every call.
//
// sessionBrief() — formats recent task log + project state into a startup
//   summary. Called once by `wire dispatch start`.
//   NOT idempotent: digest() updates stored hashes; a second call sees
//   everything as unchanged. Call exactly once per session.
//
// Wire Agent does not route, does not fire workers, does not send messages.
// That is the dispatch loop's job. Wire Agent only enriches.

import { MemoryStore } from "./memory.js";
import { RagStore } from "./rag.js";
import { ProactiveMonitor } from "../proactive/monitor.js";
import { queryWorking, queryEpisodic, querySemantic } from "./MemoryTiers.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EnrichmentContext {
  memorySummary: string;    // relevant memory entries formatted as text
  ragContext: string;       // relevant document chunks (only for skill=knowledge)
  // Note: isEmpty is intentionally absent — compute at call site with
  // (!ctx.memorySummary && !ctx.ragContext) to avoid derived-field invariant gap
}

// Internal formatting type — not part of the public API
interface BriefEntry {
  when: string;
  skill: string;
  routedTo: string;
  status: string;
  summary: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MEMORY_TOP_K = 3;    // max memory entries to inject per task
const RAG_TOP_K = 3;       // max RAG chunks to inject when skill=knowledge
const BRIEF_LIMIT = 10;    // recent tasks to include in session brief

// ─── WireAgent ────────────────────────────────────────────────────────────────

export class WireAgent {
  private memory: MemoryStore;
  private rag: RagStore;
  private monitor: ProactiveMonitor;
  private sessionBriefFired = false;
  private workingMemory = new Map<string, Map<string, unknown>>();

  constructor(stateDir: string) {
    this.memory = new MemoryStore(stateDir);
    this.rag = new RagStore(stateDir);
    this.monitor = new ProactiveMonitor(stateDir);
  }

  // Set a working memory key for an in-flight task.
  setWorking(taskId: string, key: string, value: unknown): void {
    let taskMap = this.workingMemory.get(taskId);
    if (!taskMap) {
      taskMap = new Map<string, unknown>();
      this.workingMemory.set(taskId, taskMap);
    }
    taskMap.set(key, value);
  }

  // Clear working memory for a completed task, releasing its entry.
  clearWorking(taskId: string): void {
    this.workingMemory.delete(taskId);
  }

  // ── enrich ────────────────────────────────────────────────────────────────
  // Returns formatted context to inject into the worker prompt.
  // Always succeeds — failures produce empty context, never throw.
  // When a source fails, logs a warning so silent context loss is detectable.

  async enrich(skill: string, payload: Record<string, unknown>): Promise<EnrichmentContext> {
    const query = this.buildQuery(skill, payload);
    const taskId = (payload["id"] as string | undefined) ?? "default";

    const [working, episodic, semantic] = await Promise.all([
      queryWorking(taskId, this.workingMemory),
      queryEpisodic(query, this.memory),
      querySemantic(query, this.rag),
    ]);

    const memorySummary = [working, episodic].filter(Boolean).join("\n");
    const ragContext = semantic || "";

    return { memorySummary, ragContext };
  }

  // ── sessionBrief ──────────────────────────────────────────────────────────
  // Returns a human-readable startup briefing from recent task history
  // and the project monitor digest.
  // NOT idempotent — digest() writes hashes to DB; second call shows all unchanged.

  sessionBrief(): string {
    if (this.sessionBriefFired) {
      console.warn("[wire-agent] sessionBrief() called more than once — project change detection will be inaccurate");
    }
    this.sessionBriefFired = true;

    const recent = this.memory.recent("task_log", BRIEF_LIMIT);
    const projectBlock = this.buildProjectBlock();

    if (recent.length === 0) {
      const base = "Wire Agent: no prior task history.";
      return projectBlock ? `${base}\n\n${projectBlock}\n\nReady.` : `${base} Ready.`;
    }

    const entries: BriefEntry[] = recent.map(r => {
      let skill = "?";
      let routedTo = "?";
      let status = "?";
      let summary = "";

      try {
        const raw: unknown = typeof r.value === "string" ? JSON.parse(r.value) : r.value;
        const val = (typeof raw === "object" && raw !== null && !Array.isArray(raw))
          ? (raw as Record<string, unknown>)
          : {};
        skill = String(val["skill"] ?? "?");
        routedTo = String(val["routedTo"] ?? "?");
        status = String(val["status"] ?? "?");
        summary = String(val["resultSummary"] ?? "").slice(0, 120);
      } catch (e) {
        console.warn(`[wire-agent] malformed task_log entry key=${r.key}: ${(e as Error).message}`);
      }

      const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
      return { when, skill, routedTo, status, summary };
    });

    const lines = ["Wire Agent — session brief", "─".repeat(40)];
    for (const e of entries) {
      const statusMark = e.status === "success" ? "✓" : "✗";
      lines.push(`${statusMark} [${e.when}] ${e.skill} → ${e.routedTo}`);
      if (e.summary) lines.push(`  ${e.summary.replace(/\n/g, " ")}`);
    }
    lines.push("─".repeat(40));
    lines.push(`${entries.length} task(s) in history.`);

    if (projectBlock) {
      lines.push("");
      lines.push(projectBlock);
    }

    lines.push("Ready.");
    return lines.join("\n");
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildProjectBlock(): string {
    const digests = this.monitor.digest();
    return this.monitor.format(digests);
  }

  private buildQuery(skill: string, payload: Record<string, unknown>): string {
    const parts: string[] = [skill];
    const subject = payload["subject"] as string | undefined;
    const domain = payload["domain"] as string[] | undefined;
    const verb = payload["verb"] as string | undefined;
    if (subject) parts.push(subject);
    if (domain?.length) parts.push(domain.join(" "));
    if (verb) parts.push(verb);
    return parts.join(" ");
  }

  private async queryMemory(query: string): Promise<Array<{ key: string; value: unknown; created_at: number }>> {
    try {
      return await this.memory.search({ query, topK: MEMORY_TOP_K });
    } catch (e) {
      console.warn(`[wire-agent] memory search failed — enrichment will proceed without memory context: ${(e as Error).message}`);
      return [];
    }
  }

  private async queryRag(query: string): Promise<Array<{ content: string; source_file: string; score: number; fallback: boolean }>> {
    try {
      return await this.rag.retrieve({ query, topK: RAG_TOP_K });
    } catch (e) {
      console.warn(`[wire-agent] RAG retrieve failed — enrichment will proceed without document context: ${(e as Error).message}`);
      return [];
    }
  }

  private formatMemory(results: Array<{ key: string; value: unknown; created_at: number }>): string {
    if (results.length === 0) return "";

    const lines = ["[Prior context from memory]"];
    for (const r of results) {
      let display: string;
      if (typeof r.value === "string") {
        try {
          const raw: unknown = JSON.parse(r.value);
          const parsed = (typeof raw === "object" && raw !== null && !Array.isArray(raw))
            ? (raw as Record<string, unknown>)
            : null;
          display = parsed
            ? String(parsed["resultSummary"] ?? parsed["value"] ?? r.value).slice(0, 200)
            : r.value.slice(0, 200);
        } catch {
          display = r.value.slice(0, 200);
        }
      } else {
        display = JSON.stringify(r.value).slice(0, 200);
      }
      lines.push(`- ${r.key}: ${display}`);
    }
    return lines.join("\n");
  }

  private formatRag(results: Array<{ content: string; source_file: string; score: number; fallback: boolean }>): string {
    if (results.length === 0) return "";

    const lines = ["[Relevant document context]"];
    for (const r of results) {
      // Show semantic score as percentage; keyword fallback gets a "keyword" label instead
      const scoreLabel = r.fallback ? "keyword" : `${(r.score * 100).toFixed(0)}%`;
      const filename = r.source_file.split("/").pop() ?? r.source_file;
      lines.push(`[${scoreLabel} — ${filename}]`);
      lines.push(r.content.slice(0, 400));
    }
    return lines.join("\n");
  }
}

// ─── Exported helper: build enriched prompt ───────────────────────────────────
// Used by workers.ts to prepend Wire Agent context to the base prompt.

export function buildEnrichedPrompt(basePrompt: string, context: EnrichmentContext): string {
  if (!context.memorySummary && !context.ragContext) return basePrompt;

  const sections: string[] = [];
  if (context.memorySummary) sections.push(context.memorySummary);
  if (context.ragContext) sections.push(context.ragContext);
  sections.push(basePrompt);
  return sections.join("\n\n");
}
