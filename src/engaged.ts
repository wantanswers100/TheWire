// "Wire is engaged" markers — lets a host CLI's status line show that Wire is
// working right now, and on whose behalf, without spending model tokens.
//
// Each in-flight call writes .wire-state/engaged/<pid>-<n>.json and deletes it
// when the call settles (finally), so the directory is empty when Wire is idle.
// Readers skip entries whose process is gone or that are older than STALE_MS —
// a crash (kill -9) can leave a file behind, and it must not show forever.
//
// Consumers: ~/.claude/statusline-command.sh via `wire engaged --line`
// (Claude Code). Codex and agy have no custom status-line hook (checked
// 2026-09-30: Codex 0.156 `tui.status_line` takes built-in items only).

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./config/paths.js";

export const ENGAGED_DIR = join(STATE_DIR, "engaged");
const STALE_MS = 30 * 60_000;

export interface EngagedEntry {
  pid: number;
  caller: string;     // "terminal", "claude-code", "codex", "antigravity", …
  action: string;     // short label, e.g. "ask", "wire_work"
  startedAt: number;  // epoch ms
}

let seq = 0;

/** Mark Wire engaged for the duration of `fn`. Never throws on marker I/O. */
export async function withEngaged<T>(caller: string, action: string, fn: () => Promise<T>, dir = ENGAGED_DIR): Promise<T> {
  const file = join(dir, `${process.pid}-${++seq}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const entry: EngagedEntry = { pid: process.pid, caller, action: action.slice(0, 40), startedAt: Date.now() };
    writeFileSync(file, JSON.stringify(entry));
  } catch { /* status display is best-effort; never block the real work */ }
  try {
    return await fn();
  } finally {
    try { rmSync(file, { force: true }); } catch { /* best-effort */ }
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Live entries only — dead pids and stale files are skipped (and removed). */
export function listEngaged(dir = ENGAGED_DIR, now = Date.now()): EngagedEntry[] {
  let names: string[];
  try { names = readdirSync(dir).filter(n => n.endsWith(".json")); } catch { return []; }
  const out: EngagedEntry[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const e = JSON.parse(readFileSync(path, "utf8")) as EngagedEntry;
      if (!alive(e.pid) || now - e.startedAt > STALE_MS) { rmSync(path, { force: true }); continue; }
      out.push(e);
    } catch {
      try { rmSync(path, { force: true }); } catch { /* ignore */ }
    }
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/** Compact status-line text, or "" when idle: "wire▸ codex:wire_work 12s" (+N more). */
export function engagedLine(entries = listEngaged(), now = Date.now()): string {
  if (entries.length === 0) return "";
  const first = entries[0]!;
  const secs = Math.max(0, Math.round((now - first.startedAt) / 1000));
  const more = entries.length > 1 ? ` +${entries.length - 1}` : "";
  return `wire▸ ${first.caller}:${first.action} ${secs}s${more}`;
}

/** Map an MCP client's self-reported name to a short caller label. */
export function callerFromClientName(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("claude")) return "claude-code";
  if (n.includes("codex")) return "codex";
  if (n.includes("antigravity") || n.includes("agy")) return "antigravity";
  if (n.includes("gemini")) return "gemini-cli";
  return n ? n.slice(0, 20) : "mcp";
}
