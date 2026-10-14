// agentWatchLoop.ts — universal Markdown handoff visibility layer.
//
// v1 is classifier/recorder ONLY. This module must never import workers,
// adapters, child_process, or any agent CLI wrapper. Dropping a Markdown file
// into inbox/ can only create DispatchDB visibility rows; it cannot spend
// tokens or wake a model by itself.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { canonicalizeMaybeMissing } from "./codexScope.js";
import { DispatchDB } from "./db.js";
import type { DispatchRecord } from "./db.js";
import { isKnownAgentToken, KNOWN_AGENT_TOKENS, parseAgentHandoffFile, rawFrontmatterAgentIntent } from "./agentHandoff.js";
import type { MarkdownAgentToken } from "./agentHandoff.js";
// ISS-031: sourced from config/paths.ts. Function form preserved (same
// public API other callers already depend on) but the value now comes from
// the single shared definition instead of a locally-duplicated computation.
import { INBOX_DIR } from "../config/paths.js";

export function defaultAgentInboxDir(): string {
  return INBOX_DIR;
}

export interface AgentWatchCycleResult {
  scanned: number;
  ignored: number;
  skipped: number;
  quarantined: number;
  parked: number;
  completed: number;
  lines: string[];
}

export interface AgentStatusGroups {
  ready: DispatchRecord[];
  manualOnly: DispatchRecord[];
  quarantined: DispatchRecord[];
  recentCompleted: DispatchRecord[];
}

function canonicalPathForId(filePath: string): string {
  try {
    return canonicalizeMaybeMissing(resolve(filePath));
  } catch {
    return resolve(filePath);
  }
}

export function computeAgentDispatchId(target: string, project: string, sourceFile: string): string {
  const key = `agent:${target}:${project}:${canonicalPathForId(sourceFile)}`;
  return createHash("sha256").update(key).digest("hex");
}

export function computeAgentQuarantineId(target: string, sourceFile: string): string {
  const key = `agent-quarantine:${target}:${canonicalPathForId(sourceFile)}`;
  return createHash("sha256").update(key).digest("hex");
}

function listCandidateFiles(inboxDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(inboxDir);
  } catch {
    return [];
  }
  return entries
    .filter(name => name.endsWith(".md"))
    .filter(name => !name.endsWith(":Zone.Identifier"))
    .map(name => join(inboxDir, name))
    .filter(full => {
      try { return statSync(full).isFile(); } catch { return false; }
    });
}

function intendedKnownTarget(filePath: string): MarkdownAgentToken | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const intent = rawFrontmatterAgentIntent(content);
  const candidate = intent?.target ?? intent?.to;
  return candidate && isKnownAgentToken(candidate) ? candidate : null;
}

function rowExistsForAnyKnownTarget(db: DispatchDB, filePath: string, project: string | undefined): boolean {
  const sourceFile = basename(filePath);
  if (project) {
    for (const target of KNOWN_AGENT_TOKENS) {
      if (db.get(computeAgentDispatchId(target, project, filePath))) return true;
      if (db.listAllByRoutedTo(target).some(r => r.project === project && r.source_file === sourceFile)) return true;
    }
  }
  for (const target of KNOWN_AGENT_TOKENS) {
    if (db.get(computeAgentQuarantineId(target, filePath))) return true;
    if (db.listAllByRoutedTo(target).some(r => r.source_file === sourceFile && r.status === "quarantined")) return true;
  }
  return false;
}

export function runAgentWatchCycle(stateDir: string, inboxDir: string = defaultAgentInboxDir()): AgentWatchCycleResult {
  const db = new DispatchDB(stateDir);
  const files = listCandidateFiles(inboxDir);
  const result: AgentWatchCycleResult = { scanned: files.length, ignored: 0, skipped: 0, quarantined: 0, parked: 0, completed: 0, lines: [] };

  for (const filePath of files) {
    const parsed = parseAgentHandoffFile(filePath);

    if (!parsed.ok) {
      const target = intendedKnownTarget(filePath);
      if (!target) {
        result.ignored++;
        continue;
      }
      const qid = computeAgentQuarantineId(target, filePath);
      if (db.get(qid)) {
        result.skipped++;
        continue;
      }
      const errorSummary = parsed.errors.map(e => `[${e.field}] ${e.message}`).join("; ");
      db.insert({
        id: qid,
        from: "unknown",
        skill: "quarantine",
        routed_to: target,
        status: "quarantined",
        created_at: Date.now(),
        source_file: basename(filePath),
        error: errorSummary,
      });
      result.quarantined++;
      result.lines.push(`[quarantine:${target}] ${filePath} — ${errorSummary}`);
      continue;
    }

    const { request } = parsed;
    const id = computeAgentDispatchId(request.target, request.project, filePath);
    if (db.get(id) || rowExistsForAnyKnownTarget(db, filePath, request.project)) {
      result.skipped++;
      continue;
    }

    const skill = request.task_type ?? request.work_type;
    const rowStatus = request.status === "actioned" ? "done" : "awaiting_hitl";
    db.insert({
      id,
      from: request.from,
      skill,
      routed_to: request.target,
      status: rowStatus,
      created_at: Date.now(),
      project: request.project,
      source_file: basename(filePath),
    });
    if (rowStatus === "awaiting_hitl") {
      result.parked++;
      result.lines.push(`[parked:${request.target}] ${filePath} — from=${request.from} work_type=${request.work_type}`);
    } else {
      result.completed++;
      result.lines.push(`[completed:${request.target}] ${filePath} — from=${request.from} work_type=${request.work_type}`);
    }
  }

  return result;
}

export function getAgentStatusGroups(stateDir: string, limitPerAgent = 50, target?: MarkdownAgentToken): AgentStatusGroups {
  const targets = target ? [target] : KNOWN_AGENT_TOKENS;
  const rows = targets.flatMap(t => new DispatchDB(stateDir).listRecentByRoutedTo(t, limitPerAgent));

  return {
    ready: rows.filter(r => r.status === "awaiting_hitl"),
    manualOnly: [],
    quarantined: rows.filter(r => r.status === "quarantined"),
    recentCompleted: rows.filter(r => r.status === "done" || r.status === "failed" || r.status === "policy_violation"),
  };
}

export function agentWatchPidFile(stateDir: string): string {
  return join(stateDir, "agent-watch.pid");
}

export function isAgentWatchRunning(stateDir: string): { running: boolean; pid?: string } {
  const pidFile = agentWatchPidFile(stateDir);
  if (!existsSync(pidFile)) return { running: false };
  return { running: true, pid: readFileSync(pidFile, "utf8").trim() };
}
