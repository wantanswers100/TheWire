// wire context — session briefing for Claude
//
// Outputs a compact, structured summary of everything Claude needs to know
// before starting work in this project. Designed to be read at session start.
//
// Usage:
//   wire context
//   wire context --json    (machine-readable for piping into prompts)

import { existsSync, readFileSync } from "node:fs";
import { join }                     from "node:path";
import { homedir }                  from "node:os";
import { Database }                 from "bun:sqlite";
import { checkCodexAuth }           from "../dispatch/codexAuth.js";
// ISS-031: sourced from config/paths.ts.
import { PROJECT_ROOT, STATE_DIR }  from "../config/paths.js";

const PROJECTS_ROOT = join(homedir(), "projects");
// Claude Code names a project dir after its path with "/" replaced by "-".
const MEMORY_DIR    = join(homedir(), ".claude", "projects", homedir().replace(/\//g, "-"), "memory");

const b  = (s: string) => `\x1b[1m${s}\x1b[0m`;
const d  = (s: string) => `\x1b[2m${s}\x1b[0m`;
const g  = (s: string) => `\x1b[32m${s}\x1b[0m`;
const y  = (s: string) => `\x1b[33m${s}\x1b[0m`;
const r  = (s: string) => `\x1b[31m${s}\x1b[0m`;
const c  = (s: string) => `\x1b[36m${s}\x1b[0m`;
const SEP = d("─".repeat(58));

// ─── Pending tasks ────────────────────────────────────────────────────────────

function pendingSection(): void {
  const pendingPath = join(PROJECTS_ROOT, "pending.md");
  if (!existsSync(pendingPath)) return;
  const text = readFileSync(pendingPath, "utf8");

  // Find the most recent resume queue block
  const lines = text.split("\n");
  const items: string[] = [];
  let inQueue = false;
  for (const line of lines) {
    if (/resume queue/i.test(line)) { inQueue = true; continue; }
    if (inQueue) {
      if (/^##/.test(line)) break;             // next section
      const m = line.match(/^\d+\.\s+\*\*(.+?)\*\*/);
      if (m) items.push(m[1]!.trim());
    }
  }

  if (items.length === 0) return;
  console.log(b("\nPending tasks"));
  items.forEach((item, i) => console.log(`  ${d(`${i + 1}.`)} ${item}`));
}

// ─── Active issues ────────────────────────────────────────────────────────────

function issuesSection(): void {
  const issuesPath = join(PROJECT_ROOT, "ISSUES.md");
  if (!existsSync(issuesPath)) return;
  const text = readFileSync(issuesPath, "utf8");

  // Extract open issues: ## ISS-NNN blocks where Status is not CLOSED/RESOLVED
  const issueBlocks = text.split(/^## /m).slice(1);
  const open: Array<{ id: string; title: string; priority: string; due?: string }> = [];

  for (const block of issueBlocks) {
    const idMatch    = block.match(/^(ISS|DEC|RES)-(\d+)/);
    const titleMatch = block.match(/^(?:ISS|DEC|RES)-\d+\s+(.+)/);
    const statusLine = block.match(/\*\*Status[:\*]*\s*([^\n*]+)/i);
    const priLine    = block.match(/\*\*Priority[:\*]*\s*([^\n*]+)/i);
    const dueLine    = block.match(/\*\*Due[:\*]*\s*([^\n*]+)/i);

    if (!idMatch) continue;
    const status = statusLine?.[1]?.trim().toUpperCase() ?? "";
    if (status.includes("CLOSED") || status.includes("RESOLVED") || status.includes("DONE")) continue;

    open.push({
      id:       idMatch[0],
      title:    titleMatch?.[1]?.slice(0, 55).trim() ?? "",
      priority: priLine?.[1]?.trim() ?? "–",
      due:      dueLine?.[1]?.trim(),
    });
  }

  if (open.length === 0) return;
  console.log(b("\nActive issues"));
  for (const iss of open.slice(0, 8)) {
    const due = iss.due ? d(` · due ${iss.due}`) : "";
    console.log(`  ${y(iss.id.padEnd(10))} ${iss.title}${due}`);
  }
  if (open.length > 8) console.log(d(`  … and ${open.length - 8} more`));
}

// ─── Knowledge graph ──────────────────────────────────────────────────────────

function knowledgeGraphSection(): void {
  const dbPath = join(STATE_DIR, "triples.db");
  if (!existsSync(dbPath)) {
    console.log(b("\nKnowledge Graph") + d("  (not seeded — run: bun run scripts/extract-triples.ts)"));
    return;
  }
  try {
    const db       = new Database(dbPath, { readonly: true });
    const total    = (db.query("SELECT COUNT(*) as n FROM triples").get() as { n: number }).n;
    const subjects = (db.query("SELECT COUNT(DISTINCT subject) as n FROM triples").get() as { n: number }).n;
    const meta     = db.query("SELECT key, value FROM triples_meta").all() as { key: string; value: string }[];
    db.close();

    const lastRun  = meta.find(m => m.key === "last_run")?.value ?? "never";
    const sprint   = meta.find(m => m.key === "sprint")?.value;

    // Freshness
    const lastMs   = new Date(lastRun.replace(" ", "T") + "Z").getTime();
    const ageMs    = Date.now() - lastMs;
    const ageDays  = Math.max(0, Math.floor(ageMs / 86_400_000));
    const ageLabel = ageDays === 0 ? g("today") : ageDays === 1 ? y("yesterday") : r(`${ageDays}d ago — STALE`);

    console.log(b("\nKnowledge Graph"));
    console.log(`  ${g("✓")} ${total} triples · ${subjects} subjects · ${ageLabel}`);
    if (sprint) console.log(d(`  Sprint: ${sprint}`));
  } catch {
    console.log(b("\nKnowledge Graph") + d("  (db read error)"));
  }
}

// ─── API key availability ─────────────────────────────────────────────────────

function apiKeysSection(): void {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }

  const checks: Array<{ label: string; key: string; model?: string; okOverride?: boolean }> = [
    { label: "Gemini",  key: "GEMINI_API_KEY",  model: env["GEMINI_DEFAULT"] ?? env["GEMINI_MODEL"] },
    { label: "Groq",    key: "GROQ_API_KEY",     model: env["LLAMA4_DEFAULT"] ?? "openai/gpt-oss-20b" },
    { label: "Codex",   key: "OPENAI_API_KEY", okOverride: checkCodexAuth(env).configured },
  ];

  console.log(b("\nAPI Keys configured"));
  for (const { label, key, model, okOverride } of checks) {
    const val = env[key];
    const ok  = okOverride ?? !!(val && val.length > 10 && !val.includes("YOUR_") && !val.includes("pending"));
    const modelStr = model ? d(` (${model})`) : "";
    console.log(`  ${ok ? g("✓") : r("✗")} ${label.padEnd(10)}${ok ? "" : r(" NOT SET")}${modelStr}`);
  }
}

// ─── Recent DEVLOG entries ────────────────────────────────────────────────────

function devlogSection(): void {
  const devlogPath = join(PROJECT_ROOT, "DEVLOG.md");
  if (!existsSync(devlogPath)) return;
  const text  = readFileSync(devlogPath, "utf8");
  const dates = recentDevlogHeadings(text).slice(0, 3);
  if (dates.length === 0) return;
  console.log(b("\nRecent changes (DEVLOG)"));
  for (const heading of dates) console.log(`  ${d("·")} ${heading}`);
}

// ─── Memory index summary ─────────────────────────────────────────────────────

function memorySection(): void {
  const memPath = join(MEMORY_DIR, "MEMORY.md");
  if (!existsSync(memPath)) return;
  const lines = readFileSync(memPath, "utf8").split("\n");
  const entries = lines.filter(l => l.startsWith("- [")).slice(0, 8);
  if (entries.length === 0) return;
  console.log(b("\nMemory index (top items)"));
  for (const entry of entries) {
    // Strip markdown link formatting for display: - [Title](file.md) — description
    const clean = entry.replace(/\[([^\]]+)\]\([^)]+\)/, c("$1"));
    console.log(`  ${clean}`);
  }
}

// ─── Project state ────────────────────────────────────────────────────────────

export function projectStatePartsFromStatus(text: string): string[] {
  const phaseMatch = text.match(/^\*\*Phase:\*\*\s*(.+?)(?:\s+—|$)/m);
  const testMatch  = text.match(/(\d+)\/(\d+)\s+tests?\s+passing/i);
  const statusMatch = text.match(/^\*\*State:\*\*\s*([A-Z]+)/m);

  const parts: string[] = [];
  if (phaseMatch)  parts.push(phaseMatch[1]!.trim());
  if (testMatch)   parts.push(`${testMatch[1]!}/${testMatch[2]!} tests`);
  if (statusMatch) parts.push(statusMatch[1]!);
  return parts;
}

export function recentDevlogHeadings(text: string): string[] {
  return [...text.matchAll(/^## ((?:\d{4}-\d{2}-\d{2}T[^\s]+Z|\d{4}-\d{2}-\d{2})\s+(?:—|-)\s+.+)$/gm)].map(m => m[1]!);
}

function projectStateSection(): void {
  const statusPath = join(PROJECT_ROOT, "STATUS.md");
  if (!existsSync(statusPath)) return;
  const text = readFileSync(statusPath, "utf8");
  const parts = projectStatePartsFromStatus(text);

  console.log(b("\nProject state") + (parts.length ? `  ${d(parts.join(" · "))}` : ""));
}

// ─── Pre-action checklist reminder ───────────────────────────────────────────

function checklistReminder(): void {
  console.log(b("\nClaude: before acting"));
  console.log(d("  1. Check API Keys above — never spawn an agent for an unconfigured API"));
  console.log(d("  2. Apply model:\"sonnet\" to ALL named subagents (sonnet-5 parent)"));
  console.log(d("  3. Search memory before proposing solutions: wire memory search <topic>"));
  console.log(d("  4. Check pending tasks above before starting new work"));
  console.log(d("  5. Log every file change in DEVLOG.md before moving on"));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runContext(_args: string[]): Promise<void> {
  const now = new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  console.log(`\n${SEP}`);
  console.log(`${b("wire context")}  ${d("—")}  ${d(now)}`);
  console.log(SEP);

  projectStateSection();
  pendingSection();
  issuesSection();
  knowledgeGraphSection();
  apiKeysSection();
  devlogSection();
  memorySection();
  checklistReminder();

  console.log(`\n${SEP}\n`);
}
