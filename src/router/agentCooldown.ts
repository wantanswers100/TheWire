// Agent cooldown store — error-type-aware, TTL'd skip state for the live
// dispatch loop (dispatch/loop.ts::runWorker).
//
// Problem: runWorker walks agentChain in fixed order on every task, with no
// memory of an agent's recent failures across tasks. If Gemini's quota is
// exhausted, every research-skill task still tries Gemini first, waits for
// it to fail, then falls through — paying the failed-attempt latency on
// every call until the quota resets.
//
// This store lets a failed agent be skipped for a reason-appropriate window,
// then automatically re-tried once the window elapses. It never removes an
// agent from a chain permanently and never bypasses provider consent policy
// (providerPolicy.ts) — it only decides whether to attempt the *next*
// candidate first this cycle.
//
// Storage: .wire-state/agent-cooldown.json — same pattern as router/history.ts
// (in-memory read-through, corrupt file resets to baseline, 0o600 perms).

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentId } from "../types.js";
import type { RuntimeFailureReason } from "./providerFallback.js";

// policy_blocked is a static policy fact, not a transient failure — never cooldownable.
export type CooldownReason = Exclude<RuntimeFailureReason, "policy_blocked" | "available">;

interface CooldownEntry {
  reason: CooldownReason;
  until: number;      // epoch ms
  failCount: number;  // consecutive failures for this agent, reset to 0 on success
}

type CooldownState = Partial<Record<AgentId, CooldownEntry>>;

// Base cooldown window per reason. quota/timeout double per consecutive
// failure (capped) — LiteLLM-style per-exception-type exponential backoff.
// auth/not_running/generic-failed stay flat: they're config problems the owner
// fixes manually, or one-off blips — no benefit to escalating the penalty.
const BASE_MS: Record<CooldownReason, number> = {
  quota_exhausted: 15 * 60_000,
  usage_exhausted: 15 * 60_000,
  auth_missing: 5 * 60_000,
  not_running: 5 * 60_000,
  timeout: 60_000,
  failed: 30_000,
};

const CAP_MS: Record<CooldownReason, number> = {
  quota_exhausted: 4 * 60 * 60_000,
  usage_exhausted: 4 * 60 * 60_000,
  auth_missing: 5 * 60_000,
  not_running: 5 * 60_000,
  timeout: 10 * 60_000,
  failed: 30_000,
};

const DOUBLES: ReadonlySet<CooldownReason> = new Set(["quota_exhausted", "usage_exhausted", "timeout"]);

function durationFor(reason: CooldownReason, failCount: number): number {
  const base = BASE_MS[reason];
  const cap = CAP_MS[reason];
  if (!DOUBLES.has(reason)) return base;
  // failCount=1 → base, failCount=2 → base*2, failCount=3 → base*4, ...
  const scaled = base * Math.pow(2, Math.max(failCount - 1, 0));
  return Math.min(scaled, cap);
}

export class AgentCooldownStore {
  private path: string;
  private state: CooldownState;

  constructor(stateDir: string) {
    this.path = join(stateDir, "agent-cooldown.json");
    this.state = this.load();
  }

  private load(): CooldownState {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as CooldownState;
    } catch (e) {
      console.error(`[router/agent-cooldown] state file corrupt, resetting to baseline: ${e}`);
      return {};
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (e) {
      console.warn(`[router/agent-cooldown] persist failed (in-memory state still applies): ${(e as Error).message}`);
    }
  }

  // Kill switch — set WIRE_COOLDOWN_DISABLED=1 to bypass entirely without a
  // revert/redeploy if the heuristic misbehaves in production.
  private disabled(): boolean {
    return process.env["WIRE_COOLDOWN_DISABLED"] === "1";
  }

  isOnCooldown(agent: AgentId): boolean {
    if (this.disabled()) return false;
    const entry = this.state[agent];
    if (!entry) return false;
    if (Date.now() >= entry.until) return false;
    return true;
  }

  reasonFor(agent: AgentId): CooldownReason | null {
    const entry = this.state[agent];
    if (!entry || Date.now() >= entry.until) return null;
    return entry.reason;
  }

  recordFailure(agent: AgentId, reason: CooldownReason): void {
    const prior = this.state[agent];
    const failCount = prior && prior.reason === reason ? prior.failCount + 1 : 1;
    const until = Date.now() + durationFor(reason, failCount);
    this.state[agent] = { reason, until, failCount };
    this.persist();
  }

  // A successful call is real signal the agent has recovered — clear
  // immediately rather than waiting out a stale cooldown window.
  clear(agent: AgentId): void {
    if (!(agent in this.state)) return;
    delete this.state[agent];
    this.persist();
  }
}

// ─── Failure classification ────────────────────────────────────────────────
// Maps the distinguishable error message shapes already thrown by
// dispatch/workers.ts into the shared RuntimeFailureReason taxonomy.
// Order matters — check quota/timeout before the generic auth/not-found
// patterns, since some messages could otherwise match both.

export function classifyFailure(error: unknown): CooldownReason {
  const msg = error instanceof Error ? error.message : String(error);

  if (/rate.?limit|429|quota.?exceeded|spend.?cap/i.test(msg)) return "quota_exhausted";
  if (/ETIMEDOUT|timed?\s?out/i.test(msg)) return "timeout";
  if (/not set|no .*auth found/i.test(msg)) return "auth_missing";
  if (/cli not found|not found in path|not responding/i.test(msg)) return "not_running";
  return "failed";
}
