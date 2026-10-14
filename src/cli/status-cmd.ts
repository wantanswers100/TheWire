// wire status — workspace status: Ollama models, gateway, dispatch loop, usage ledger
//
// Usage:
//   wire status

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL, GEMINI_DEFAULT_MODEL, GROQ_API_BASE, LLAMA4_DEFAULT_MODEL } from "../config/models.js";
import { GEMINI_MODEL_BY_ROLE, GROQ_MODEL_BY_ROLE } from "../gateway/complete.js";
// ISS-031: sourced from config/paths.ts.
import { PROJECT_ROOT, STATE_DIR, GATEWAY_URL } from "../config/paths.js";
import { checkAgyAuth } from "../dispatch/agyAuth.js";
import { checkCodexAuth } from "../dispatch/codexAuth.js";
import { APP_VERSION, formatVersionLine } from "../version.js";

const PID_FILE = join(STATE_DIR, "dispatch.pid");
const ACTIVE_DIR = join(homedir(), "projects", "active");
const USAGE_DIR = join(homedir(), "projects", "logs", "runs", "usage");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(s: string): string  { return `\x1b[32m${s}\x1b[0m`; }
function warn(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function dim(s: string): string  { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── Section: Ollama ──────────────────────────────────────────────────────────

async function ollamaSection(): Promise<void> {
  console.log(bold("\nOllama Models"));

  let models: string[] = [];
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(4_000),
    });
    if (res.ok) {
      const data = await res.json() as { models?: Array<{ name: string }> };
      models = (data.models ?? []).map(m => m.name);
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`  ${warn("OFFLINE")}  ${dim(`(${e instanceof Error ? e.message : String(e)})`)}`);
    return;
  }

  if (models.length === 0) {
    console.log(`  ${warn("running")} — no models loaded`);
    return;
  }

  // Show installed models
  for (const name of models) {
    console.log(`  ${ok("✓")} ${name}`);
  }

  // Show wire role → model mapping, flag any role whose model isn't installed
  console.log(dim("\n  Wire role assignments:"));
  const roleEntries = Object.entries(OLLAMA_SKILL_MODEL);
  for (const [role, model] of roleEntries) {
    const base = model.split(":")[0] ?? model;
    const installed = models.some(m => m === model || m.startsWith(base + ":") || m === base);
    const marker = installed ? ok("✓") : warn("✗");
    console.log(`  ${marker}  ${role.padEnd(14)} → ${model}${installed ? "" : warn("  (not installed)")}`);
  }
}

// ─── Section: API Models ──────────────────────────────────────────────────────

export function loadEnvFile(): Record<string, string> {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

export type ApiStatus = { label: string; model: string; ms: number; status: "ok" | "quota" | "auth" | "nokey" | "error"; detail: string };

export async function probeGemini(apiKey: string, model: string): Promise<ApiStatus> {
  const isThinking = /^gemini-[3-9]/.test(model);
  const genCfg: Record<string, unknown> = { maxOutputTokens: 5, temperature: 0 };
  if (isThinking) genCfg["thinkingConfig"] = { thinkingBudget: 0 };
  const body = { contents: [{ parts: [{ text: "Reply: OK" }] }], generationConfig: genCfg };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const ms = Date.now() - t0;
    if (res.status === 429) return { label: "Gemini", model, ms, status: "quota", detail: "free tier quota exceeded — resets daily" };
    if (res.status === 401 || res.status === 403) return { label: "Gemini", model, ms, status: "auth", detail: "invalid or deleted API key" };
    if (!res.ok) return { label: "Gemini", model, ms, status: "error", detail: `HTTP ${res.status}` };
    const d = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) return { label: "Gemini", model, ms, status: "error", detail: "empty response (thinking model needs thinkingBudget:0)" };
    return { label: "Gemini", model, ms, status: "ok", detail: text.trim().slice(0, 30) };
  } catch (e) {
    return { label: "Gemini", model, ms: Date.now() - t0, status: "error", detail: e instanceof Error ? e.message.slice(0, 50) : "timeout" };
  }
}

export async function probeGroq(apiKey: string, model: string): Promise<ApiStatus> {
  const body = { model, messages: [{ role: "user", content: "Reply: OK" }], max_tokens: 5 };
  const t0 = Date.now();
  try {
    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const ms = Date.now() - t0;
    if (res.status === 429) return { label: "Groq", model, ms, status: "quota", detail: "rate limited" };
    if (res.status === 401) return { label: "Groq", model, ms, status: "auth", detail: "invalid API key" };
    if (res.status === 400) return { label: "Groq", model, ms, status: "error", detail: "model not found or bad request" };
    if (!res.ok) return { label: "Groq", model, ms, status: "error", detail: `HTTP ${res.status}` };
    const d = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = d.choices?.[0]?.message?.content ?? "";
    return { label: "Groq", model, ms, status: "ok", detail: text.trim().slice(0, 30) };
  } catch (e) {
    return { label: "Groq", model, ms: Date.now() - t0, status: "error", detail: e instanceof Error ? e.message.slice(0, 50) : "timeout" };
  }
}

function renderApiStatus(s: ApiStatus): void {
  const modelShort = s.model.length > 28 ? s.model.slice(0, 25) + "..." : s.model;
  const msStr = dim(`${s.ms}ms`);
  if (s.status === "nokey") {
    console.log(`  ${warn("✗")} ${s.label.padEnd(8)} ${warn("NO KEY")}  ${dim("set " + (s.label.startsWith("Gemini") ? "GEMINI_API_KEY" : "GROQ_API_KEY") + " in .env")}`);
  } else if (s.status === "ok") {
    console.log(`  ${ok("✓")} ${s.label.padEnd(8)} ${ok("LIVE")}    ${modelShort.padEnd(28)} ${msStr}`);
  } else if (s.status === "quota") {
    console.log(`  ${warn("~")} ${s.label.padEnd(8)} ${warn("QUOTA")}   ${modelShort.padEnd(28)} ${dim(s.detail)}`);
  } else if (s.status === "auth") {
    console.log(`  ${warn("✗")} ${s.label.padEnd(8)} ${warn("AUTH")}    ${dim(s.detail)}`);
  } else {
    console.log(`  ${warn("✗")} ${s.label.padEnd(8)} ${warn("ERROR")}   ${dim(s.detail)}`);
  }
}

async function apiModelsSection(): Promise<void> {
  console.log(bold("\nAPI Models"));
  const env = { ...loadEnvFile(), ...process.env };

  const geminiKey = env["GEMINI_API_KEY"] ?? "";
  const geminiModel = env["GEMINI_DEFAULT"] ?? env["GEMINI_MODEL"] ?? GEMINI_DEFAULT_MODEL;
  const groqKey = env["GROQ_API_KEY"] ?? "";
  const groqModel = env["LLAMA4_DEFAULT"] ?? LLAMA4_DEFAULT_MODEL;

  const probes: Promise<ApiStatus>[] = [];

  if (!geminiKey || geminiKey === "REPLACE_WITH_YOUR_NEW_KEY") {
    probes.push(Promise.resolve({ label: "Gemini", model: geminiModel, ms: 0, status: "nokey" as const, detail: "" }));
  } else {
    probes.push(probeGemini(geminiKey, geminiModel));
  }

  if (!groqKey) {
    probes.push(Promise.resolve({ label: "Groq", model: groqModel, ms: 0, status: "nokey" as const, detail: "" }));
  } else {
    probes.push(probeGroq(groqKey, groqModel));
  }

  const results = await Promise.all(probes);
  for (const r of results) renderApiStatus(r);

  // 2026-09-22 (found investigating a client app's "All providers
  // failed" outage): the probes above check config/models.ts's
  // GEMINI_DEFAULT_MODEL/LLAMA4_DEFAULT_MODEL -- used by Wire's own dispatch
  // loop (wire ask/wire task) -- which is a COMPLETELY SEPARATE model
  // configuration from gateway/complete.ts's GEMINI_MODEL_BY_ROLE/
  // GROQ_MODEL_BY_ROLE, the one client apps (and any other external
  // /complete caller) actually uses. `wire status` showed green the whole
  // time groq/compound-mini was returning a hard 404 for every real trading
  // call, because it was never checking that model at all. Probing the
  // /complete-specific models here, separately labeled, closes that blind
  // spot -- a green wire-dispatch model no longer implies a green
  // /complete model, and vice versa.
  const completeGeminiModels = [...new Set(Object.values(GEMINI_MODEL_BY_ROLE))];
  const completeGroqModels = [...new Set(Object.values(GROQ_MODEL_BY_ROLE))];

  const completeProbes: Promise<ApiStatus>[] = [];
  for (const model of completeGeminiModels) {
    completeProbes.push(
      !geminiKey || geminiKey === "REPLACE_WITH_YOUR_NEW_KEY"
        ? Promise.resolve({ label: "Gemini", model, ms: 0, status: "nokey" as const, detail: "" })
        : probeGemini(geminiKey, model)
    );
  }
  for (const model of completeGroqModels) {
    completeProbes.push(
      !groqKey
        ? Promise.resolve({ label: "Groq", model, ms: 0, status: "nokey" as const, detail: "" })
        : probeGroq(groqKey, model)
    );
  }
  const completeResults = await Promise.all(completeProbes);
  for (const r of completeResults) renderApiStatus({ ...r, label: `${r.label} (/complete)` });

  // Codex is a first-class routed agent (router/table.ts: costTier low,
  // strengths scaffold/boilerplate/implement/typescript/api) but had no
  // presence in this panel — `wire status` showed Gemini/Groq/Antigravity
  // only, so an operator glancing at status had no signal Codex existed or
  // was authenticated. `wire codex status` already surfaced this; this is
  // the same presence-only check (envApiKeyPresent/envSessionTokenPresent/
  // authFilePresent — never opens or reads auth.json content) rolled up
  // into the main panel. Never a live call — checkCodexAuth() is
  // side-effect-free by design (see codexAuth.ts).
  const codex = checkCodexAuth(env);
  if (!codex.configured) {
    console.log(`  ${warn("✗")} ${"Codex".padEnd(8)} ${warn("NOT READY")}  ${dim("no OPENAI_API_KEY, no OPENAI_SESSION_TOKEN, no ~/.codex/auth.json — run: codex login")}`);
  } else {
    const via = codex.authFilePresent
      ? `auth.json, ${codex.authFileAgeDays!.toFixed(1)}d old`
      : codex.envSessionTokenPresent ? "OPENAI_SESSION_TOKEN" : "OPENAI_API_KEY";
    console.log(`  ${ok("✓")} ${"Codex".padEnd(8)} ${ok("READY")}     ${dim(`${via} — presence-only check, not a live call`)}`);
  }

  // ISSUE-018: antigravity (agy) has been a first-class dispatch agent since
  // Phase 48 but was never surfaced here — checkAgyAuth() existed only in the
  // dispatch path. Presence-only check (CLI installed + runnable), consistent
  // with how the router treats agy (OAuth-based, no key/token to probe).
  const agy = checkAgyAuth();
  if (!agy.cliPresent) {
    console.log(`  ${warn("✗")} ${"Antigravity".padEnd(8)} ${warn("NOT FOUND")}  ${dim("agy CLI not on PATH — fallback tier unavailable")}`);
  } else if (!agy.configured) {
    console.log(`  ${warn("✗")} ${"Antigravity".padEnd(8)} ${warn("NOT READY")}  ${dim("agy present but --version failed — check OAuth/install")}`);
  } else {
    console.log(`  ${ok("✓")} ${"Antigravity".padEnd(8)} ${ok("READY")}     ${dim(`agy ${agy.cliVersion} — presence-only check, not a live call`)}`);
  }
}

// ─── Section: Gateway ─────────────────────────────────────────────────────────

async function gatewaySection(): Promise<void> {
  console.log(bold("\nGateway"));
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (res.ok) {
      let detail = "";
      try {
        const json = await res.json() as { version?: string; protocol?: string };
        const parts = [json.protocol, json.version ? `v${json.version}` : undefined].filter(Boolean);
        detail = parts.join("  ·  ");
      } catch {
        detail = "up";
      }
      console.log(`  ${ok("RUNNING")}  ${GATEWAY_URL}  ${dim(detail)}`);
    } else {
      console.log(`  ${warn("ERROR")}    ${GATEWAY_URL}  HTTP ${res.status}`);
    }
  } catch {
    console.log(`  ${warn("STOPPED")}  ${GATEWAY_URL}`);
    console.log(dim("  Start with: bun run wire-gateway  (or: wire-up for the full briefing)"));
  }
}

// ─── Section: Dispatch loop ───────────────────────────────────────────────────

function dispatchSection(): void {
  console.log(bold("\nDispatch Loop"));
  if (!existsSync(PID_FILE)) {
    console.log(`  ${warn("STOPPED")}`);
    console.log(dim("  Start with: wire dispatch start"));
    return;
  }

  const pidStr = readFileSync(PID_FILE, "utf8").trim();
  const pid = parseInt(pidStr, 10);

  if (!pidAlive(pid)) {
    console.log(`  ${warn("STALE")}  pid ${pid} (no longer running — stale pid file)`);
    console.log(dim(`  Clean up: rm ${PID_FILE}`));
    return;
  }

  console.log(`  ${ok("RUNNING")}  pid ${pid}`);
}

// ─── Section: Context packs ───────────────────────────────────────────────────

const PROJECT_MARKERS = [".git", "STATUS.md", "CLAUDE.md", "README.md"];

function contextPackSection(): void {
  console.log(bold("\nContext Packs"));

  let projects: string[] = [];
  try {
    projects = readdirSync(ACTIVE_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      // Only real projects — a bare container dir (e.g. an empty *-worktrees
      // holder) has none of these and was listed as "no context pack".
      .filter(d => PROJECT_MARKERS.some(m => existsSync(join(ACTIVE_DIR, d.name, m))))
      .map(d => d.name)
      .sort();
  } catch {
    console.log(dim("  Cannot read ~/projects/active/"));
    return;
  }

  const PACK_FILES = ["brief.md", "architecture.md", "surfaces.md", "risks.md", "deliverables.md"];

  for (const project of projects) {
    const contextDir = join(ACTIVE_DIR, project, "context");
    if (!existsSync(contextDir)) {
      console.log(`  ${warn("✗")} ${project.padEnd(30)} ${dim("no context pack")}`);
      continue;
    }
    const present = PACK_FILES.filter(f => existsSync(join(contextDir, f)));
    const marker = present.length === PACK_FILES.length ? ok("✓") : warn(`${present.length}/${PACK_FILES.length}`);
    console.log(`  ${marker} ${project.padEnd(30)} ${dim(present.join(", "))}`);
  }
}

// ─── Section: Usage ledger ────────────────────────────────────────────────────

function usageLedgerSection(): void {
  console.log(bold("\nUsage Ledger (today)"));

  const today = new Date().toISOString().slice(0, 10);
  const todayFile = join(USAGE_DIR, `${today}.md`);

  if (!existsSync(todayFile)) {
    console.log(dim("  No usage logged today."));
    console.log(dim(`  Ledger path: ${USAGE_DIR}/`));
    return;
  }

  const lines = readFileSync(todayFile, "utf8").split("\n").filter(l => l.startsWith("|") && !l.startsWith("| Timestamp") && !l.startsWith("|---"));
  console.log(`  ${lines.length} run${lines.length === 1 ? "" : "s"} logged today  ${dim(todayFile)}`);

  if (lines.length > 0) {
    const recent = lines.slice(-5);
    console.log(dim("\n  Recent entries:"));
    for (const line of recent) {
      console.log(dim(`  ${line}`));
    }
  }
}

// ─── Section: Doc audit cache ─────────────────────────────────────────────────

function docAuditSection(): void {
  console.log(bold("\nDoc Staleness"));

  const cacheFile = join(homedir(), ".claude", ".last-audit-result.md");
  if (!existsSync(cacheFile)) {
    console.log(dim("  No audit cache — run: ~/projects/scripts/audit-docs.sh"));
    return;
  }

  const lines = readFileSync(cacheFile, "utf8").split("\n");
  const get = (key: string) => lines.find(l => l.startsWith(`${key}=`))?.split("=")[1] ?? "0";

  const ts   = get("ts");
  const p1   = parseInt(get("p1"), 10);
  const p2   = parseInt(get("p2"), 10);
  const p3   = parseInt(get("p3"), 10);

  const findings = lines
    .filter(l => l.startsWith("finding="))
    .map(l => l.slice("finding=".length));

  if (p1 === 0 && p2 === 0 && p3 === 0) {
    console.log(`  ${ok("✓")} All docs current  ${dim(`(last checked: ${ts})`)}`);
    return;
  }

  if (p1 > 0) console.log(`  ${warn("P1")} ${p1} critical — update before starting work`);
  if (p2 > 0) console.log(`  ${warn("P2")} ${p2} stale — update this session`);
  if (p3 > 0) console.log(dim(`  P3  ${p3} informational`));
  console.log(dim(`  Last checked: ${ts}`));

  const actionable = findings.filter(f => f.startsWith("P1|") || f.startsWith("P2|"));
  if (actionable.length > 0) {
    console.log(dim("\n  Stale items:"));
    for (const f of actionable) {
      const [sev, msg] = f.split("|");
      console.log(`  ${warn(sev!)}  ${msg}`);
    }
  }

  console.log(dim("\n  Fix: ~/projects/scripts/audit-docs.sh"));
}

// ─── Section: Knowledge Graph ─────────────────────────────────────────────────

function knowledgeGraphSection(): void {
  console.log(bold("\nKnowledge Graph"));

  const triplesDb = join(STATE_DIR, "triples.db");
  if (!existsSync(triplesDb)) {
    console.log(dim("  No triples.db — run: bun run scripts/extract-triples.ts"));
    return;
  }

  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(triplesDb, { readonly: true });

    const total = (db.query("SELECT COUNT(*) as n FROM triples").get() as { n: number }).n;
    const subjects = (db.query("SELECT COUNT(DISTINCT subject) as n FROM triples").get() as { n: number }).n;

    const getMeta = (key: string): string =>
      (db.query("SELECT value FROM triples_meta WHERE key=?").get(key) as { value: string } | null)?.value ?? "—";

    const lastRun   = getMeta("last_run");
    const sprint    = getMeta("sprint");

    // Staleness check — warn if last run > 7 days ago
    const lastRunMs = lastRun !== "—" ? new Date(lastRun).getTime() : 0;
    const daysSince = Math.max(0, Math.floor((Date.now() - lastRunMs) / 86_400_000));
    const freshness = daysSince === 0 ? ok("today") : daysSince <= 7 ? warn(`${daysSince}d ago`) : warn(`${daysSince}d ago — rerun extractor`);

    console.log(`  ${ok("✓")} ${total} triples  ·  ${subjects} subjects  ·  last updated ${freshness}`);
    if (sprint !== "—") console.log(dim(`  Sprint: ${sprint}`));
    console.log(dim(`  Refresh: bun run scripts/extract-triples.ts`));

    // Zone breakdown
    const zones = db.query("SELECT object as zone, COUNT(*) as n FROM triples WHERE predicate='zone' GROUP BY object").all() as { zone: string; n: number }[];
    if (zones.length > 0) {
      console.log(dim(`  Zones: ${zones.map(z => `${z.zone}(${z.n})`).join("  ")}`));
    }

    db.close();
  } catch (e) {
    console.log(`  ${warn("ERROR")}  ${dim(e instanceof Error ? e.message : String(e))}`);
  }
}

// ─── Section: Recent Fallbacks/Reroutes ────────────────────────────────────────
//
// Not new logging — eval_scores already records a pass/fail row per agent
// attempt per task (see EvalStore.record calls in dispatch/loop.ts). This
// section surfaces what was already being captured but never rolled up
// anywhere: which agents failed in the last 24h, forcing the fallback chain
// to move to the next tier. A read-only query, no new writes, no risk to the
// dispatch hot path.

function recentFallbacksSection(): void {
  console.log(bold("\nRecent Fallbacks (24h)"));

  const dbPath = join(STATE_DIR, "dispatch.db");
  if (!existsSync(dbPath)) {
    console.log(dim("  No dispatch.db yet — nothing to report."));
    return;
  }

  try {
    const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const since = Date.now() - 24 * 60 * 60 * 1000;

    // Security diff-review, Phase 49: a verdict='fail' row is written for EVERY
    // agent that throws in the chain, including the last one when all agents
    // are exhausted — that's not "moved to the next tier," there was no next
    // tier. Join against dispatch.status to tell recovered fallbacks (task
    // eventually succeeded via a later tier) from terminal exhaustion (task
    // ended status='failed') and label each correctly.
    const rows = db.query(
      `SELECT e.agent as agent, e.created_at as created_at, d.status as taskStatus
       FROM eval_scores e
       LEFT JOIN dispatch d ON d.id = e.task_id
       WHERE e.step = 'end_to_end' AND e.verdict = 'fail' AND e.created_at >= ?`
    ).all(since) as { agent: string | null; created_at: number; taskStatus: string | null }[];

    db.close();

    if (rows.length === 0) {
      console.log(`  ${ok("✓")} none — no agent failures in the fallback chain`);
      return;
    }

    const recovered = new Map<string, { n: number; last: number }>();
    const exhausted = new Map<string, { n: number; last: number }>();
    for (const r of rows) {
      const bucket = r.taskStatus === "failed" ? exhausted : recovered;
      const key = r.agent ?? "unknown";
      const entry = bucket.get(key) ?? { n: 0, last: 0 };
      entry.n += 1;
      entry.last = Math.max(entry.last, r.created_at);
      bucket.set(key, entry);
    }

    const printBucket = (m: Map<string, { n: number; last: number }>) => {
      for (const [agent, f] of [...m.entries()].sort((a, b) => b[1].n - a[1].n)) {
        const ago = Math.round((Date.now() - f.last) / 60_000);
        console.log(`  ${warn("~")} ${agent.padEnd(12)} ${f.n} failure(s)  ${dim(`last ${ago}m ago`)}`);
      }
    };

    if (recovered.size > 0) {
      console.log(dim("  Recovered (chain moved to next tier and succeeded):"));
      printBucket(recovered);
    }
    if (exhausted.size > 0) {
      console.log(dim("  Exhausted (no tier left — task failed outright):"));
      printBucket(exhausted);
    }
    console.log(dim("  Recovered failures are worth checking before the day they happen with no tier left; exhausted ones already did."));
  } catch (e) {
    console.log(`  ${warn("ERROR")}  ${dim(e instanceof Error ? e.message : String(e))}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runStatus(_args: string[]): Promise<void> {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${bold(`Wire ${APP_VERSION} Status`)}  ${dim(ts)}`);
  console.log(dim(`  ${formatVersionLine()}`));
  console.log(dim("─".repeat(60)));

  await ollamaSection();
  await apiModelsSection();
  await gatewaySection();
  dispatchSection();
  recentFallbacksSection();
  contextPackSection();
  knowledgeGraphSection();
  usageLedgerSection();
  docAuditSection();

  console.log();
}
