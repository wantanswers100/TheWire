// Dispatch loop — Wire Platform Phase 17
//
// Event-driven inbox watcher. For each incoming task message addressed to claude:
//   1. Route via WireRouter (Layer 1 rules + Layer 2 classifier)
//   2. Fire the appropriate worker (Ollama / Gemini / Codex)
//   3. Send signed result back to the requesting agent via gateway
//   4. HITL gate: implement/architect/scaffold/refactor actions require approval
//      before Codex fires — approval is a wire message reply, never a CLI prompt
//
// State: .wire-state/dispatch.db (SQLite)
// Inbox: watched via Bun.watch (event-driven, not polling)

import { watch } from "fs";
import { join, basename } from "node:path";
import { readdirSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { decodeMessage, parseWireFile } from "../envelope/decode.js";
import { buildMessage, serializeMessage, wireFilename } from "../envelope/encode.js";
import { isWireFile } from "./legacy.js";
import { WireRouter } from "../router/index.js";
import { DispatchDB } from "./db.js";
import { EvalStore } from "./EvalStore.js";
import { PhaseGate } from "./PhaseGate.js";
import { MemoryStore } from "../agents/memory.js";
import { WireAgent } from "../agents/wire-agent.js";
import { runOllama, runGemini, runCodex, runSystem, runLlama4, runDeepSeek, runClaude, runAgy } from "./workers.js";
import type { WorkerResult } from "./workers.js";
import type { WirePayload, AgentId, OutcomeRecord } from "../types.js";
import { AgentCooldownStore, classifyFailure } from "../router/agentCooldown.js";
import { isContextRefusal } from "./refusal.js";

// ─── HITL — skills requiring approval before execution ───────────────────────
const HITL_SKILLS = new Set(["implement", "architect", "scaffold", "refactor", "wire"]);

// ─── Cost tier ordering for resource-first decomposition ─────────────────────
// Lower number = cheaper. Stable sort preserves original chain order within a tier.
const AGENT_COST_TIER: Record<string, number> = {
  ollama: 0, system: 0, llama4: 0, deepseek: 0,  // free
  gemini: 1, codex: 1,                             // low
  claude: 2,                                       // high
};

function reorderCheapestFirst(chain: AgentId[]): AgentId[] {
  return [...chain].sort((a, b) => {
    const tierA = AGENT_COST_TIER[a] ?? 2;
    const tierB = AGENT_COST_TIER[b] ?? 2;
    return tierA - tierB;
  });
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface LoopConfig {
  keysDir: string;
  stateDir: string;
  inboxDir: string;
  gatewayUrl: string;
  agentToken: string;
  onOutcome?: (record: OutcomeRecord) => Promise<void>;
  judgeOverride?: import("./PhaseGate.js").JudgeFn;  // test injection point — bypasses Ollama judge
}

// ─── Main loop class ──────────────────────────────────────────────────────────

export class DispatchLoop {
  private router: WireRouter;
  private db: DispatchDB;
  private evalStore: EvalStore;
  private phaseGate: PhaseGate;
  private memory: MemoryStore;
  private wireAgent: WireAgent;
  private cooldown: AgentCooldownStore;
  private config: LoopConfig;
  private running = false;
  private watcher: ReturnType<typeof watch> | null = null;

  constructor(config: LoopConfig) {
    this.config = config;
    this.router = new WireRouter(config.stateDir);
    this.db = new DispatchDB(config.stateDir);
    this.evalStore = new EvalStore(config.stateDir);
    this.phaseGate = new PhaseGate(config.judgeOverride);
    this.memory = new MemoryStore(config.stateDir);
    this.wireAgent = new WireAgent(config.stateDir);
    this.cooldown = new AgentCooldownStore(config.stateDir);
    mkdirSync(config.inboxDir, { recursive: true });
  }

  sessionBrief(): string {
    return this.wireAgent.sessionBrief();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log(`[dispatch] started — watching ${this.config.inboxDir}`);

    // Process any messages already in inbox before watcher starts
    this.scanInbox();

    // Watch for new files
    this.watcher = watch(this.config.inboxDir, { persistent: true }, (_event, filename) => {
      if (filename && isWireFile(filename)) {
        const filepath = join(this.config.inboxDir, filename);
        // Small delay to let the write complete before reading
        setTimeout(() => {
          void this.processFile(filepath).catch((e) =>
            console.error(`[dispatch] processFile error for ${filepath}:`, e)
          );
        }, 50);
      }
    });

    this.watcher.on("error", (e) => console.error("[dispatch] watcher error:", e));
  }

  stop(): void {
    this.running = false;
    this.watcher?.close();
    this.watcher = null;
    this.db.close();
    this.evalStore.close();
    console.log("[dispatch] stopped");
  }

  // ── Scan existing inbox files ──────────────────────────────────────────────

  private scanInbox(): void {
    try {
      const files = readdirSync(this.config.inboxDir).filter(isWireFile).sort();
      for (const f of files) {
        void this.processFile(join(this.config.inboxDir, f)).catch((e) =>
          console.error(`[dispatch] scanInbox processFile error for ${f}:`, e)
        );
      }
    } catch (e) {
      console.error("[dispatch] scanInbox error:", e);
    }
  }

  // ── Archive a fully-handled task file ──────────────────────────────────────
  //
  // ISS-033: nothing ever removed a processed inbox file — every task and
  // result message accumulated forever (26+ files by the time this was
  // fixed, growing the readdirSync() scanInbox() does on every daemon
  // restart, and re-logging the same stale "discarding invalid" warnings —
  // see ISS-028's fix — every restart, indefinitely). Moves (never deletes)
  // to inboxDir/.processed/ so history is preserved without unbounded growth
  // at the watch point. Deliberately scoped to the two cases where this is
  // safe with the highest confidence: a message that will NEVER succeed
  // (schema-invalid, addressed to us) and a message that has been fully
  // claimed and handed to a worker (its content is already captured in the
  // DB; the source file is no longer needed). Result/ack messages, "not
  // addressed to us" messages, and key_rotation messages are deliberately
  // left untouched — this daemon shares the inbox with other consumers and
  // those cases carry more risk of removing something still in use.
  private archiveInboxFile(filepath: string): void {
    try {
      if (!existsSync(filepath)) return; // already archived by a racing duplicate call
      const archiveDir = join(this.config.inboxDir, ".processed");
      mkdirSync(archiveDir, { recursive: true });
      renameSync(filepath, join(archiveDir, basename(filepath)));
    } catch (e) {
      console.warn(`[dispatch] archiveInboxFile failed for ${filepath}: ${(e as Error).message}`);
    }
  }

  // ── Process a single inbox file ────────────────────────────────────────────

  private async processFile(filepath: string): Promise<void> {
    if (!existsSync(filepath)) return;

    let content: string;
    try { content = readFileSync(filepath, "utf8"); }
    catch (e) {
      console.error(`[dispatch] cannot read inbox file ${filepath}: ${(e as Error).message}`);
      return;
    }

    const raw = parseWireFile(content);
    if (!raw) return;

    const result = decodeMessage(raw, "claude");
    if (!result.ok) {
      // ISS-028: "not addressed to us" and "genuinely malformed" both come
      // back as ok:false, but they mean very different things. A message
      // for another recipient is expected and fine to ignore silently — this
      // daemon shares the inbox directory with every other agent. A message
      // that WAS addressed to us but failed schema validation (e.g. the
      // classifier's keyword-fallback path producing an empty domain[],
      // which used to be true for ~90% of its branches — see
      // classifier.ts's keywordClassify()) was previously dropped with zero
      // trace, so `wire ask` reported success while the task vanished.
      // decode.ts's routing check reuses the same "schema_invalid" code as
      // real schema failures, distinguished only by this detail prefix.
      const isNotForUs = result.code === "schema_invalid" && result.detail?.startsWith("Message addressed to");
      if (!isNotForUs) {
        console.warn(`[dispatch] discarding invalid inbox file ${filepath}: [${result.code}] ${result.detail}`);
        // ISS-033: this message is addressed to us but will NEVER pass
        // validation — archiving it stops it from being re-logged and
        // re-scanned on every future daemon restart forever.
        this.archiveInboxFile(filepath);
      }
      return;
    }
    if (result.message.to !== "claude") return;
    if (result.message.type !== "task") return;

    const msg = result.message;
    const payload = result.payload as unknown as Record<string, unknown>;

    // key_rotation payloads require the separate crypto package for attestation verification — skip them
    if (payload["format"] === "key_rotation") {
      console.warn(`[dispatch] key_rotation from ${msg.from}: attestation verification requires the separate crypto package — skipping`);
      return;
    }

    // Skip already-processed messages
    if (this.db.isProcessed(msg.id)) return;

    // ISS-032: atomic claim BEFORE the async route() yield point below.
    // Two concurrent processFile() calls for the same message id (duplicate
    // inotify events from a single write, or an editor's write+rename/
    // write+chmod sequence) can both pass the isProcessed() check above
    // before either commits to the DB — the previous db.insert() call sat
    // AFTER the `await router.route(...)`, a real yield point, so both
    // callers could reach it and both proceed to runWorker(), silently
    // double-dispatching (and, for paid API workers, double-billing).
    // insert() now reports whether THIS call actually won the race
    // (INSERT OR IGNORE + affected-row count) — only the winner proceeds;
    // caught firing live in production during ISS-028 verification
    // (2026-08-12), see ISSUES.md ISS-032 and this date's DEVLOG entry.
    const claimed = this.db.insert({ id: msg.id, from: msg.from, skill: msg.skill, routed_to: "unrouted", status: "routing", created_at: Date.now() });
    if (!claimed) {
      console.log(`[dispatch] task ${msg.id.slice(0, 8)} already claimed by a concurrent event — skipping duplicate`);
      return;
    }

    console.log(`[dispatch] task ${msg.id.slice(0, 8)} from=${msg.from} skill=${msg.skill}`);

    // ISS-033: the task is claimed and its content is now fully captured in
    // `msg`/`payload` above — the source file is no longer needed. Archive
    // it now rather than leaving it in the active inbox indefinitely.
    this.archiveInboxFile(filepath);

    // Build model filter from payload if present (alternate process — default routing unchanged)
    const rawFilter = payload["modelFilter"] as AgentId[] | undefined;
    const modelFilter = rawFilter?.length ? new Set<AgentId>(rawFilter) : undefined;

    // Route — now properly awaited (fixes pre-existing async gap)
    //
    // ISS-029: `verb` must be passed here — nl-cmd.ts's own router.route()
    // call (used for the CLI's plan-preview display) includes it, and
    // verb-scoped routing rules (table.ts) gate/score on req.verb. Omitting
    // it here meant the daemon's actual routing decision could structurally
    // diverge from what the CLI displayed and the user confirmed, not just
    // from the expected temporal drift (live availability checks, learned
    // weights) — undermining the "one routing authority" guarantee the
    // ISS-027 fix was specifically meant to establish.
    //
    // Layer 2: when subject is present, use classifyAndRoute() to enable
    // decomposition type detection. Falls through to route() semantics on
    // classifier failure (classifyAndRoute handles its own fallback).
    const subject = payload["subject"] as string | undefined;
    const routeDecision = subject
      ? await this.router.classifyAndRoute(subject, {
          skill: msg.skill,
          verb: payload["verb"] as string | undefined,
          domains: (payload["domain"] as string[]) ?? [],
          type: "task",
          modelFilter,
        })
      : await this.router.route({
          skill: msg.skill,
          verb: payload["verb"] as string | undefined,
          domains: (payload["domain"] as string[]) ?? [],
          type: "task",
          modelFilter,
        });
    const targetAgent = routeDecision.agent;

    // Claim already happened above (status:"routing"); just fill in the
    // real target now that routing resolved (was "unrouted" as a placeholder).
    this.db.update(msg.id, { routed_to: targetAgent });

    // HITL gate — consequential skills stop and request approval
    if (HITL_SKILLS.has(msg.skill)) {
      this.db.update(msg.id, { status: "awaiting_hitl" });
      this.sendHitlRequest(msg.id, msg.from, msg.skill, targetAgent, payload).catch(async (e) => {
        const errMsg = `HITL request delivery failed: ${(e as Error).message}`;
        console.error(`[dispatch] HITL send failed for task ${msg.id.slice(0, 8)}:`, e);
        this.db.update(msg.id, { status: "failed", error: errMsg });
        // Logged to memory for visibility, but deliberately NOT emitOutcome():
        // no agent ran, so this must not count against the skill/agent's
        // routing success rate in skill history.
        await this.memory.logTask({
          taskId: msg.id, from: msg.from, skill: msg.skill, routedTo: targetAgent,
          status: "failed", resultSummary: errMsg.slice(0, 300),
        }).catch((memErr) =>
          console.warn(`[dispatch] HITL failure for ${msg.id.slice(0, 8)} not logged to memory: ${(memErr as Error).message}`)
        );
        await this.sendResult(msg.from, msg.skill, {
          format: "error",
          taskId: msg.id,
          code: "hitl_delivery_failed",
          message: errMsg.slice(0, 400),
          retryable: true,
        }).catch((sendErr) =>
          console.error(`[dispatch] failed to deliver HITL failure error for ${msg.id.slice(0, 8)}:`, sendErr)
        );
      });
      return;
    }

    // Build agent chain, then apply decomposition routing adjustments
    let agentChain: AgentId[] = [targetAgent, ...routeDecision.fallbacksAvailable];
    const decomp = routeDecision.decompositionType ?? "functional";

    if (decomp === "resource") {
      // Reorder chain: cheapest agent first, escalate on failure
      agentChain = reorderCheapestFirst(agentChain);
    }
    // spatial: ParallelDispatcher would apply if task has subtasks — fall through to functional path
    // temporal and functional: existing sequential path unchanged

    // Fire worker async (non-blocking) — pass full fallback chain for auto-retry
    void this.runWorker(msg.id, msg.from, msg.skill, agentChain, payload).catch((e) => {
      console.error(`[dispatch] runWorker uncaught error for task ${msg.id.slice(0, 8)}:`, e);
      this.db.update(msg.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
    });
  }

  // ── Dispatch a single agent, reject immediately on timeout/error ──────────

  private async callAgent(agent: AgentId, skill: string, payload: Record<string, unknown>, enrichedContext: string | undefined): Promise<WorkerResult> {
    if (agent === "system" || skill === "system") {
      return runSystem(payload);
    } else if (agent === "ollama") {
      return runOllama(skill, payload, enrichedContext);
    } else if (agent === "gemini") {
      return runGemini(skill, payload, enrichedContext);
    } else if (agent === "codex") {
      return runCodex(skill, payload, enrichedContext);
    } else if (agent === "llama4") {
      return runLlama4(skill, payload, enrichedContext);
    } else if (agent === "deepseek") {
      return runDeepSeek(skill, payload, enrichedContext);
    } else if (agent === "claude") {
      return runClaude(skill, payload, enrichedContext);
    } else if (agent === "antigravity") {
      return runAgy(skill, payload, enrichedContext);
    } else {
      // Genuinely unrecognized agent id — throw rather than silently
      // substitute another provider. runWorker()'s fallback chain already
      // catches this and tries the next agent (or reports failure if none
      // remain); a silent substitution here is exactly the class of bug
      // this fix removes for "claude" above.
      throw new Error(`Unknown agent "${agent}" — no worker defined.`);
    }
  }

  // ── Run worker and send result — tries each agent in chain until one succeeds

  private async runWorker(
    taskId: string,
    from: string,
    skill: string,
    agentChain: AgentId[],
    payload: Record<string, unknown>
  ): Promise<void> {
    this.db.update(taskId, { status: "running" });

    // Enrich once — shared across all fallback attempts
    const ctx = await this.wireAgent.enrich(skill, payload);
    const enrichedContext = (!ctx.memorySummary && !ctx.ragContext) ? undefined : [ctx.memorySummary, ctx.ragContext].filter(Boolean).join("\n\n");

    let workerResult: WorkerResult | null = null;
    let usedAgent: AgentId | null = null;
    const errors: string[] = [];

    const subject = payload["subject"] as string | undefined;

    for (const agent of agentChain) {
      if (this.cooldown.isOnCooldown(agent)) {
        const reason = this.cooldown.reasonFor(agent);
        console.log(`[dispatch] skipping agent=${agent} for task ${taskId.slice(0, 8)} — on cooldown (${reason})`);
        this.evalStore.record(taskId, "worker", 0.0, { agent, skill, verdict: "skipped_cooldown" });
        errors.push(`${agent}: skipped (cooldown: ${reason})`);
        continue;
      }

      const attemptStart = Date.now();
      console.log(`[dispatch] trying agent=${agent} for task ${taskId.slice(0, 8)}`);
      try {
        const gateResult = await this.phaseGate.runWithGuardrails(
          taskId,
          skill,
          subject ?? "",
          () => this.callAgent(agent, skill, payload, enrichedContext),
          this.evalStore,
          (_tid, reason) => {
            // PhaseGate escalation: mark for human review, log, and stop chain
            this.db.update(taskId, { status: "awaiting_review", error: `PhaseGate escalated: ${reason}` });
            console.warn(`[dispatch] task ${taskId.slice(0, 8)} escalated to awaiting_review — ${reason}`);
          },
        );

        if (gateResult.verdict === "escalated") {
          // Escalation handler already updated DB; stop the fallback chain.
          // logTask failure must not re-enter the catch block and continue the chain.
          try {
            await this.memory.logTask({
              taskId,
              from,
              skill,
              subject,
              routedTo: agent,
              status: "failed",
              resultSummary: `PhaseGate escalated: ${gateResult.judgeReason ?? "quality check failed"}`,
            });
          } catch (memErr) {
            console.warn(`[dispatch] task ${taskId.slice(0, 8)} escalated but memory.logTask failed: ${(memErr as Error).message}`);
          }
          this.emitOutcome({ taskId, skill, subject, agentUsed: agent, status: "failed",
            resultSummary: `PhaseGate escalated: ${gateResult.judgeReason ?? "quality check failed"}`, createdAt: Date.now() });
          return;
        }

        workerResult = gateResult.result;
        usedAgent = agent;
        this.cooldown.clear(agent);
        this.evalStore.record(taskId, "end_to_end", 1.0, {
          agent,
          skill,
          latency_ms: Date.now() - attemptStart,
          verdict: "pass",
        });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${agent}: ${msg.slice(0, 120)}`);
        this.cooldown.recordFailure(agent, classifyFailure(e));
        this.evalStore.record(taskId, "end_to_end", 0.0, {
          agent,
          skill,
          latency_ms: Date.now() - attemptStart,
          verdict: "fail",
        });
        console.warn(`[dispatch] agent=${agent} failed for ${taskId.slice(0, 8)} — ${msg.slice(0, 80)}${agentChain.indexOf(agent) < agentChain.length - 1 ? " — trying next" : ""}`);
      }
    }

    if (!workerResult || !usedAgent) {
      const errMsg = `All agents failed. Attempts: ${errors.join(" | ")}`;
      console.error(`[dispatch] all agents exhausted for ${taskId.slice(0, 8)}`);
      this.db.update(taskId, { status: "failed", error: errMsg });
      await this.memory.logTask({ taskId, from, skill, routedTo: agentChain[0] ?? "none", status: "failed", resultSummary: errMsg.slice(0, 200) });
      // Failures must reach skill history too, or its success_rate is
      // structurally 1.0 and the HIT_THRESHOLD guard can never fire (ISS-066).
      if (agentChain[0]) {
        this.emitOutcome({ taskId, skill, subject, agentUsed: agentChain[0], status: "failed",
          resultSummary: errMsg.slice(0, 300), createdAt: Date.now() });
      }

      const errorPayload: WirePayload = {
        format: "error",
        taskId,
        code: "agent_unavailable",
        message: errMsg.slice(0, 400),
        retryable: true,
      };
      await this.sendResult(from, skill, errorPayload).catch((sendErr) => {
        console.error(`[dispatch] failed to deliver error result for task ${taskId.slice(0, 8)}: ${(sendErr as Error).message}`);
      });
      return;
    }

    // ISS-025: confidence used to be a flat 0.85 regardless of which agent in
    // the fallback chain actually answered, or how many earlier agents threw
    // first. Real signal exists (agentChain.indexOf(usedAgent) — the tier that
    // succeeded) and was already being discarded. Preferred agent (tier 0)
    // reports 0.9; each fallback tier below it steps down by 0.15, floored at
    // 0.5 — a fallback answer is real and often correct, just less certain to
    // be the router's actual preference than the primary pick would have been.
    const tier = agentChain.indexOf(usedAgent);
    if (tier < 0) {
      console.warn(`[dispatch] usedAgent="${usedAgent}" not found in agentChain — confidence calculation defaulting to tier 0`);
    }
    const confidence = Math.max(0.5, 0.9 - Math.max(tier, 0) * 0.15);

    const resultPayload: WirePayload = {
      format: "result",
      taskId,
      status: "success",
      confidence,
      data: workerResult.text,
      tokensUsed: workerResult.tokensUsed,
      reasoningTrace: workerResult.model ? `routed to ${usedAgent} (${workerResult.model})` : `routed to ${usedAgent}`,
    };

    const resultId = await this.sendResult(from, skill, resultPayload);

    if (resultId === null) {
      // (No emitOutcome() here on purpose: the agent answered fine — this is
      // an infrastructure fault, not a routing-quality signal for skill history.)
      // Worker succeeded but delivery to the gateway failed (disk full, permission,
      // bad path). Do NOT mark "done" — that would be a false-PASS: the requester
      // never received the result even though the underlying work succeeded. (ISS-024)
      const deliveryErrMsg = `Worker succeeded (agent=${usedAgent}) but result delivery to gateway failed — see server log for sendResult() error.`;
      this.db.update(taskId, { status: "failed", error: deliveryErrMsg });
      console.error(`[dispatch] delivery failed for ${taskId.slice(0, 8)} → agent=${usedAgent} (worker output was discarded)`);
      await this.memory.logTask({
        taskId,
        from,
        skill,
        subject: payload["subject"] as string | undefined,
        routedTo: usedAgent,
        status: "failed",
        resultSummary: deliveryErrMsg,
      });
      return;
    }

    this.db.update(taskId, { status: "done", result_id: resultId });
    console.log(`[dispatch] done ${taskId.slice(0, 8)} → agent=${usedAgent} result ${resultId.slice(0, 8)}`);

    // Release working memory for this completed task
    this.wireAgent.clearWorking(taskId);

    // A "the context does not contain..." answer is delivered (it's still the
    // model's output) but recorded as a failed outcome, so it doesn't inflate
    // skill history or get recycled as episodic context (ISS-066).
    const refused = isContextRefusal(workerResult.text);
    if (refused) console.warn(`[dispatch] task ${taskId.slice(0, 8)} agent=${usedAgent} returned a context-refusal — recorded as failed outcome`);
    const outcomeStatus = refused ? "failed" : "success";

    await this.memory.logTask({
      taskId,
      from,
      skill,
      subject: payload["subject"] as string | undefined,
      routedTo: usedAgent,
      status: outcomeStatus,
      resultSummary: workerResult.text.slice(0, 300),
    });

    this.emitOutcome({
      taskId,
      skill,
      subject: payload["subject"] as string | undefined,
      agentUsed: usedAgent,
      status: outcomeStatus,
      resultSummary: workerResult.text.slice(0, 300),
      tokensUsed: workerResult.tokensUsed,
      model: workerResult.model,
      createdAt: Date.now(),
    });
  }

  // Fire outcome hook detached — never await inline
  private emitOutcome(outcome: OutcomeRecord): void {
    if (!this.config.onOutcome) return;
    void this.config.onOutcome(outcome).catch((e) => {
      console.warn(`[dispatch] onOutcome hook failed for task ${outcome.taskId.slice(0, 8)}:`, e);
    });
  }

  // ── HITL approval request ──────────────────────────────────────────────────

  private async sendHitlRequest(
    taskId: string,
    from: string,
    skill: string,
    targetAgent: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const subject = payload["subject"] as string ?? "(no subject)";
    const domain = (payload["domain"] as string[] ?? []).join(", ");

    const hitlPayload: WirePayload = {
      format: "result",
      taskId,
      status: "needs_clarification",
      confidence: 0,
      data: {
        hitl: true,
        skill,
        targetAgent,
        subject,
        domain,
        instruction: `Approve or reject: reply with wire message type=ack to approve, type=error to reject. Task will not execute until approved.`,
      },
      uncertainty: [`Skill '${skill}' requires HITL approval before ${targetAgent} executes.`],
    };

    // sendResult returns null on failure; without this check the task would sit
    // in awaiting_hitl forever and the caller's hitl_delivery_failed path is dead.
    if (!(await this.sendResult(from, skill, hitlPayload))) {
      throw new Error("HITL request could not be written to the inbox");
    }
    console.log(`[dispatch] HITL pending ${taskId.slice(0, 8)} — awaiting approval from ${from}`);
  }

  // ── Send a result message to the gateway ───────────────────────────────────

  private async sendResult(to: string, skill: string, payload: WirePayload): Promise<string | null> {
    try {
      const msg = await buildMessage({
        from: "claude",
        to: to as Parameters<typeof buildMessage>[0]["to"],
        type: payload.format === "error" ? "error" : "result",
        skill: skill as Parameters<typeof buildMessage>[0]["skill"],
        payload,
        ttl: 3600,
        priority: 3,
      });

      const filename = wireFilename(msg);
      const filepath = join(this.config.inboxDir, filename);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(filepath, serializeMessage(msg), { encoding: "utf8", mode: 0o600 });
      return msg.id;
    } catch (e) {
      console.error("[dispatch] sendResult failed:", e);
      return null;
    }
  }
}
