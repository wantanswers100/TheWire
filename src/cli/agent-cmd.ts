// agent-cmd.ts — universal Markdown handoff visibility and explicit pickup.
//
// The background watch loop remains visibility-only. `pickup` is an explicit
// foreground command: it may invoke the selected agent adapter and write a
// result handoff only after the user runs the command directly.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DispatchDB } from "../dispatch/db.js";
import type { DispatchRecord } from "../dispatch/db.js";
import {
  agentWatchPidFile,
  defaultAgentInboxDir,
  getAgentStatusGroups,
  isAgentWatchRunning,
  runAgentWatchCycle,
} from "../dispatch/agentWatchLoop.js";
import { isKnownAgentToken, KNOWN_AGENT_TOKENS } from "../dispatch/agentHandoff.js";
import type { MarkdownAgentToken } from "../dispatch/agentHandoff.js";
import { pickupCore } from "../dispatch/agentPickup.js";
import { pruneStaleCore } from "../dispatch/codexPruneStale.js";
import type { PruneCandidate } from "../dispatch/codexPruneStale.js";
import { pruneProcessedArchiveCore } from "../dispatch/archivePrune.js";
import { PROVIDER_POLICIES } from "../router/providerPolicy.js";
// ISS-031: sourced from config/paths.ts.
import { STATE_DIR as DEFAULT_STATE_DIR, INBOX_DIR as DEFAULT_INBOX_DIR } from "../config/paths.js";
const WATCH_POLL_INTERVAL_MS = 20_000;
const PICKUP_TARGETS = new Set<MarkdownAgentToken>(["claude", "codex", "gemini", "ollama"]);

function dispatchDbExists(stateDir: string): boolean {
  return existsSync(join(stateDir, "dispatch.db"));
}

function formatRecord(r: DispatchRecord): string {
  return `  [${r.id.slice(0, 12)}] ${r.from.padEnd(12)} → ${r.routed_to.padEnd(12)} ${r.skill.padEnd(12)} ${(r.project ?? "?").padEnd(24)} ${r.source_file ?? "?"}`;
}

function printUsage(): void {
  console.log("Usage: wire agent <status|watch|pickup|prune-stale|prune-processed> ...");
  console.log("");
  console.log("  wire agent status [agent]          Universal Markdown handoff visibility.");
  console.log("  wire agent watch start             Scan inbox/ every 20s, park/quarantine only.");
  console.log("  wire agent watch stop              Stop the universal visibility watcher.");
  console.log("  wire agent watch status [agent]    Watcher lifecycle + grouped handoff rows.");
  console.log("  wire agent pickup <agent>          Explicitly run next awaiting handoff for claude/codex/gemini/ollama.");
  console.log("  wire agent prune-stale [agent] [--apply]");
  console.log("                                      Dry-run by default. Lists (or, with --apply, deletes)");
  console.log("                                      awaiting_hitl/quarantined rows whose source_file no longer");
  console.log("                                      exists in inbox/, for one agent or all known agents. Never");
  console.log("                                      touches done/failed/policy_violation rows or any file on disk.");
  console.log("  wire agent prune-processed [--older-than-days N] [--apply]");
  console.log("                                      Dry-run by default. Lists (or, with --apply, deletes) files");
  console.log("                                      in inbox/.processed/ older than N days (default 30). Never");
  console.log("                                      touches dispatch.db, the active inbox, or anything outside");
  console.log("                                      inbox/.processed/.");
  console.log("");
  console.log("Watch/status never invoke LLMs. Pickup is foreground-only and reports fallback guidance on failure.");
}

function parseOptionalTarget(raw: string | undefined): MarkdownAgentToken | undefined {
  if (raw === undefined) return undefined;
  if (isKnownAgentToken(raw)) return raw;
  console.error(`Unknown agent token: ${raw}`);
  console.error(`Known tokens: ${KNOWN_AGENT_TOKENS.join(", ")}`);
  process.exit(1);
}

function formatStatusGroups(stateDir: string, target?: MarkdownAgentToken): string {
  if (!dispatchDbExists(stateDir)) {
    return [
      "Ready — awaiting human approval (0):",
      "",
      "Manual-only / unsupported dispatch target (0):",
      "",
      "Quarantined — invalid, needs manual fix + resubmit (0):",
      "",
      "Recent completed: done=0 failed=0 policy_violation=0",
    ].join("\n");
  }

  const groups = getAgentStatusGroups(stateDir, 50, target);
  const lines: string[] = [];

  lines.push(`Ready — awaiting human approval (${groups.ready.length}):`);
  for (const r of groups.ready) lines.push(formatRecord(r));
  lines.push("");

  lines.push(`Manual-only / unsupported dispatch target (${groups.manualOnly.length}):`);
  for (const r of groups.manualOnly) lines.push(formatRecord(r));
  if (groups.manualOnly.length > 0) {
    lines.push("  To process: run `wire agent pickup antigravity`.");
  }
  lines.push("");

  lines.push(`Quarantined — invalid, needs manual fix + resubmit (${groups.quarantined.length}):`);
  for (const r of groups.quarantined) lines.push(`  [${r.id.slice(0, 12)}] ${r.routed_to.padEnd(12)} ${r.source_file ?? "?"} — ${r.error ?? "(no detail)"}`);
  lines.push("");

  const done = groups.recentCompleted.filter(r => r.status === "done").length;
  const failed = groups.recentCompleted.filter(r => r.status === "failed").length;
  const violation = groups.recentCompleted.filter(r => r.status === "policy_violation").length;
  lines.push(`Recent completed: done=${done} failed=${failed} policy_violation=${violation}`);
  return lines.join("\n");
}

export function statusCore(stateDir: string = DEFAULT_STATE_DIR, target?: MarkdownAgentToken): string {
  const lines: string[] = [];
  lines.push("Universal agent mesh visibility:");
  lines.push(`  known tokens: ${KNOWN_AGENT_TOKENS.join(", ")}`);
  lines.push("  execution:    explicit pickup only; watch/status never invoke LLMs");
  lines.push("  idle cost:    zero LLM/API calls; status reads state only");
  if (target) lines.push(`  filter:       ${target}`);
  lines.push("");

  const targets = target ? [target] : KNOWN_AGENT_TOKENS;
  for (const t of targets) {
    const rows = dispatchDbExists(stateDir) ? new DispatchDB(stateDir).listRecentByRoutedTo(t, 20) : [];
    lines.push(`  ${t.padEnd(12)} rows: ${rows.length}`);
  }
  lines.push("");
  lines.push(formatStatusGroups(stateDir, target));
  return lines.join("\n");
}

function runStatus(target?: MarkdownAgentToken): void {
  console.log(statusCore(DEFAULT_STATE_DIR, target));
}

async function runWatchStart(): Promise<void> {
  const pidFile = agentWatchPidFile(DEFAULT_STATE_DIR);
  if (existsSync(pidFile)) {
    const pid = readFileSync(pidFile, "utf8").trim();
    console.log(`Agent watch already running (pid ${pid}). Use 'wire agent watch stop' first.`);
    process.exit(1);
  }

  mkdirSync(DEFAULT_STATE_DIR, { recursive: true });
  writeFileSync(pidFile, String(process.pid), { encoding: "utf8", mode: 0o600 });
  console.log(`[agent watch] pid ${process.pid} written to ${pidFile}`);
  console.log(`[agent watch] polling ${defaultAgentInboxDir()} every ${WATCH_POLL_INTERVAL_MS / 1000}s`);
  console.log("[agent watch] v1: visibility only — classifies, parks, quarantines; never dispatches.");
  console.log("");

  const tick = () => {
    const result = runAgentWatchCycle(DEFAULT_STATE_DIR);
    for (const line of result.lines) console.log(line);
    if (result.parked > 0 || result.quarantined > 0 || result.completed > 0) {
      console.log(`[agent watch] cycle: scanned=${result.scanned} parked=${result.parked} completed=${result.completed} quarantined=${result.quarantined} skipped=${result.skipped} ignored=${result.ignored}`);
    }
  };

  tick();
  const timer = setInterval(tick, WATCH_POLL_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(timer);
    if (existsSync(pidFile)) unlinkSync(pidFile);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function runWatchStop(): void {
  const pidFile = agentWatchPidFile(DEFAULT_STATE_DIR);
  if (!existsSync(pidFile)) {
    console.log("Agent watch is not running.");
    process.exit(0);
  }
  const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[agent watch] stopped (pid ${pid})`);
  } catch (e) {
    console.error(`Failed to stop pid ${pid}:`, e);
  } finally {
    if (existsSync(pidFile)) unlinkSync(pidFile);
  }
}

function runWatchStatus(target?: MarkdownAgentToken): void {
  const status = isAgentWatchRunning(DEFAULT_STATE_DIR);
  console.log(`Agent watch: ${status.running ? `RUNNING (pid ${status.pid})` : "STOPPED"}`);
  if (target) console.log(`Filter: ${target}`);
  console.log("");
  console.log(formatStatusGroups(DEFAULT_STATE_DIR, target));
}

function requiresConsent(target: MarkdownAgentToken): boolean {
  return PROVIDER_POLICIES.find(p => p.agent === target)?.consentRequired ?? false;
}

export function hasReadyPickupWork(stateDir: string, target: MarkdownAgentToken): boolean {
  return dispatchDbExists(stateDir) && getAgentStatusGroups(stateDir, 50, target).ready.length > 0;
}

function isConfirmedAnswer(raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

async function confirmPickup(target: MarkdownAgentToken): Promise<boolean> {
  if (!requiresConsent(target)) return true;
  if (!input.isTTY || !output.isTTY) {
    console.log(`\n(non-interactive context — cannot confirm ${target} pickup cost/usage, refusing)`);
    return false;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`\nPickup with ${target} may use paid/subscription quota. Proceed? [y/N] `);
    return isConfirmedAnswer(answer);
  } finally {
    rl.close();
  }
}

async function runPickup(target: MarkdownAgentToken | undefined): Promise<void> {
  if (!target) {
    console.error("Usage: wire agent pickup <claude|codex|gemini|ollama>");
    process.exit(1);
  }
  if (!PICKUP_TARGETS.has(target)) {
    const result = await pickupCore(DEFAULT_STATE_DIR, target);
    console.log(result.lines.join("\n"));
    process.exit(result.ok ? 0 : 1);
  }

  if (!hasReadyPickupWork(DEFAULT_STATE_DIR, target)) {
    console.log(`No awaiting handoff for ${target}.`);
    process.exit(0);
  }

  const confirmed = await confirmPickup(target);
  if (!confirmed) {
    console.log(`Refused: ${target} pickup not confirmed. No agent invoked, no result handoff written.`);
    process.exit(1);
  }
  const result = await pickupCore(DEFAULT_STATE_DIR, target);
  console.log(result.lines.join("\n"));
  process.exit(result.ok ? 0 : 1);
}

function formatPruneCandidate(agent: string, c: PruneCandidate): string {
  const created = new Date(c.created_at).toLocaleString("en-CA", { hour12: false });
  return `  [${c.id.slice(0, 12)}] ${agent.padEnd(12)} ${c.status.padEnd(13)} ${c.skill.padEnd(10)} ${(c.project ?? "(no project)").padEnd(24)} ${c.source_file ?? "(none)"}  (created ${created})`;
}

function runPruneStale(target: MarkdownAgentToken | undefined, apply: boolean): void {
  const agents: readonly string[] = target ? [target] : KNOWN_AGENT_TOKENS;

  let totalScanned = 0;
  let totalEligible = 0;
  let totalDeleted = 0;
  let totalUnsafe = 0;
  let totalNoSource = 0;

  for (const agent of agents) {
    const result = pruneStaleCore(DEFAULT_STATE_DIR, apply, undefined, agent);
    totalScanned += result.scanned;
    totalEligible += result.eligible.length;
    totalDeleted += result.deleted.length;
    totalUnsafe += result.unsafeSkipped.length;
    totalNoSource += result.noSourceSkipped;

    if (result.eligible.length === 0 && result.unsafeSkipped.length === 0 && result.noSourceSkipped === 0) continue;

    console.log(`${agent} — scanned ${result.scanned} row(s):`);
    if (result.eligible.length > 0) {
      console.log(`  ${apply ? "deleted" : "eligible for pruning"} (${result.eligible.length}):`);
      for (const c of result.eligible) console.log(formatPruneCandidate(agent, c));
    }
    if (result.unsafeSkipped.length > 0) {
      console.log(`  unsafe source_file, skipped — never eligible regardless of file state (${result.unsafeSkipped.length}):`);
      for (const c of result.unsafeSkipped) console.log(formatPruneCandidate(agent, c));
    }
    if (result.noSourceSkipped > 0) {
      console.log(`  no source_file recorded — skipped, cannot verify staleness (${result.noSourceSkipped} row(s)).`);
    }
    console.log("");
  }

  console.log(`Scanned ${totalScanned} row(s) across ${agents.length} agent(s) (${agents.join(", ")}).`);
  if (apply) {
    console.log(totalDeleted > 0 ? `${totalDeleted} row(s) deleted from dispatch.db.` : "No rows deleted.");
  } else if (totalEligible > 0) {
    console.log(`Dry-run — no changes made. Pass --apply to delete these ${totalEligible} row(s) from dispatch.db.`);
  } else {
    console.log("Dry-run — no changes made. Nothing eligible for pruning.");
  }
  if (totalUnsafe > 0) console.log(`(${totalUnsafe} row(s) had an unsafe source_file and were never eligible.)`);
  if (totalNoSource > 0) console.log(`(${totalNoSource} row(s) had no source_file recorded and were skipped.)`);
}

function runPruneProcessed(olderThanDays: number, apply: boolean): void {
  const result = pruneProcessedArchiveCore(DEFAULT_INBOX_DIR, apply, olderThanDays);

  console.log(`Scanned ${result.scanned} file(s) in ${result.processedDir} (older than ${result.olderThanDays}d).`);
  console.log("");

  if (result.eligible.length === 0) {
    console.log("Nothing to prune — no files older than the threshold.");
  } else {
    console.log(`${apply ? "Deleted" : "Eligible for pruning"} (${result.eligible.length}):`);
    for (const c of result.eligible) console.log(`  ${c.filename}  (${c.ageDays.toFixed(1)}d old)`);
  }

  console.log("");
  if (apply) {
    console.log(result.deleted.length > 0 ? `${result.deleted.length} file(s) deleted from ${result.processedDir}.` : "No files deleted.");
  } else if (result.eligible.length > 0) {
    console.log(`Dry-run — no changes made. Pass --apply to delete these ${result.eligible.length} file(s).`);
  } else {
    console.log("Dry-run — no changes made.");
  }
}

export async function runAgentCmd(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "status") {
    runStatus(parseOptionalTarget(args[1]));
    process.exit(0);
  }

  if (subcommand === "watch") {
    const watchSubcommand = args[1];
    if (watchSubcommand === "start") {
      await runWatchStart();
      return;
    }
    if (watchSubcommand === "stop") {
      runWatchStop();
      process.exit(0);
    }
    if (watchSubcommand === "status") {
      runWatchStatus(parseOptionalTarget(args[2]));
      process.exit(0);
    }
    console.error("Usage: wire agent watch <start|stop|status>");
    process.exit(1);
  }

  if (subcommand === "pickup") {
    await runPickup(parseOptionalTarget(args[1]));
    return;
  }

  if (subcommand === "prune-stale") {
    const rest = args.slice(1);
    const apply = rest.includes("--apply");
    const agentArg = rest.find(a => a !== "--apply");
    runPruneStale(parseOptionalTarget(agentArg), apply);
    process.exit(0);
  }

  if (subcommand === "prune-processed") {
    const rest = args.slice(1);
    const apply = rest.includes("--apply");
    const flagIdx = rest.indexOf("--older-than-days");
    let olderThanDays = 30;
    if (flagIdx !== -1) {
      const raw = rest[flagIdx + 1];
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (Number.isNaN(parsed) || parsed < 0) {
        console.error(`--older-than-days requires a non-negative integer, got "${raw ?? "(none)"}"`);
        process.exit(1);
      }
      olderThanDays = parsed;
    }
    runPruneProcessed(olderThanDays, apply);
    process.exit(0);
  }

  if (subcommand === "dispatch") {
    console.error("wire agent dispatch is not implemented. Use explicit pickup paths such as wire agent pickup claude, or agent-specific commands such as wire codex dispatch.");
    process.exit(1);
  }

  printUsage();
  process.exit(subcommand ? 1 : 0);
}
