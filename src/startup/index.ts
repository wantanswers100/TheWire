#!/usr/bin/env bun
// wire-start — Wire Platform startup briefing
//
// Checks gateway, auto-starts it if down, reads claude's inbox,
// checks Ollama models. Run on-demand; auto-start via .bashrc later.
//
// Usage: bun run wire-start

import { join } from "node:path";
import { readFileSync, existsSync, statSync } from "node:fs";
import { updateLinuxContext } from "./linux-context.js";
// ISS-031: sourced from config/paths.ts.
import { PROJECT_ROOT, KEYS_DIR, GATEWAY_URL as GATEWAY } from "../config/paths.js";
import { checkAgyAuth } from "../dispatch/agyAuth.js";
import { loadEnvFile, probeGemini, probeGroq, type ApiStatus } from "../cli/status-cmd.js";
import { GEMINI_DEFAULT_MODEL, LLAMA4_DEFAULT_MODEL } from "../config/models.js";
import { formatVersionLine } from "../version.js";
import { briefingPath as localBriefingPath } from "../config/local.js";

const OLLAMA = "http://localhost:11434";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readClaudeToken(): string | null {
  const path = join(KEYS_DIR, "gateway-tokens.json");
  if (!existsSync(path)) return null;
  try {
    const tokens = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    return tokens["claude"] ?? null;
  } catch {
    return null;
  }
}

async function checkGateway(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnGateway(): void {
  const proc = Bun.spawn(
    ["bun", "run", join(PROJECT_ROOT, "src/gateway/server.ts")],
    { cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "ignore"], detached: true }
  );
  proc.unref();
}

async function waitForGateway(maxMs = 4000): Promise<boolean> {
  const step = 400;
  for (let elapsed = 0; elapsed < maxMs; elapsed += step) {
    await Bun.sleep(step);
    if (await checkGateway()) return true;
  }
  return false;
}

async function fetchInbox(token: string): Promise<{ messages: unknown[]; warning?: string }> {
  try {
    const res = await fetch(`${GATEWAY}/inbox/claude?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { messages: [], warning: `gateway returned ${res.status} — check token or restart gateway` };
    }
    const data = await res.json() as { messages?: unknown[] };
    return { messages: data.messages ?? [] };
  } catch (e) {
    return { messages: [], warning: `gateway unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function checkOllama(): Promise<{ running: boolean; models: string[] }> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json() as { models?: Array<{ name: string }> };
    return { running: true, models: (data.models ?? []).map(m => m.name) };
  } catch {
    return { running: false, models: [] };
  }
}

function col(label: string, width = 16): string {
  return label.padEnd(width);
}

function fmtMessage(msg: Record<string, unknown>): string {
  const type  = String(msg["type"]  ?? "?").padEnd(9);
  const from  = `from=${msg["from"]  ?? "?"}`.padEnd(18);
  const skill = `skill=${msg["skill"] ?? "?"}`.padEnd(22);
  const tsVal = msg["ts"];
  const time  = tsVal ? new Date(tsVal as number).toLocaleTimeString("en-US", { hour12: false }) : "";
  return `  ${type}${from}${skill}${time}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const DIV = "─".repeat(58);
const now = new Date();
const dateStr = now.toLocaleDateString("en-CA");         // YYYY-MM-DD
const timeStr = now.toLocaleTimeString("en-US", { hour12: false });

console.log(`\n${DIV}`);
console.log(`  Wire Platform  |  ${dateStr}  ${timeStr}`);
console.log(`  Version  ${formatVersionLine()}`);
console.log(DIV);
console.log("");

// ── Gateway ──────────────────────────────────────────────────────────────────

let gwUp = await checkGateway();
let gwStarted = false;

if (!gwUp) {
  spawnGateway();
  gwStarted = true;
  gwUp = await waitForGateway();
}

if (gwUp) {
  const note = gwStarted ? "  (auto-started)" : "";
  console.log(`${col("Gateway")}${GATEWAY}  [running]${note}`);
  console.log(`${col("Agents")}claude  gemini  codex  ollama  system`);
} else {
  console.log(`${col("Gateway")}[failed to start]`);
  console.log(`${col("")}  run manually: bun run wire-gateway`);
}

console.log("");

// ── Inbox ────────────────────────────────────────────────────────────────────

const token = readClaudeToken();

if (!token) {
  console.log(`${col("Inbox")}token not found — run: bun run bootstrap`);
} else if (!gwUp) {
  console.log(`${col("Inbox")}unavailable (gateway down)`);
} else {
  const { messages: msgs, warning } = await fetchInbox(token);
  if (warning) {
    console.log(`${col("Inbox")}[warn] ${warning}`);
  } else if (msgs.length === 0) {
    console.log(`${col("Inbox")}empty (claude)`);
  } else {
    console.log(`${col("Inbox")}${msgs.length} pending (claude)`);
    for (const msg of msgs.slice(0, 6)) {
      console.log(fmtMessage(msg as Record<string, unknown>));
    }
    if (msgs.length > 6) {
      console.log(`  ... and ${msgs.length - 6} more`);
    }
  }
}

console.log("");

// ── Platforms (Gemini / Groq / Antigravity) ────────────────────────────────────
// The owner's ask: an indicator every time Wire starts, not just when `wire status`
// is run on demand — so a dead fallback tier is visible before it's needed,
// not discovered mid-task. Reuses the same probes `wire status` uses.

function fmtPlatform(s: ApiStatus): string {
  if (s.status === "nokey") return `${s.label}: no key`;
  if (s.status === "ok") return `${s.label}: up (${s.ms}ms)`;
  if (s.status === "quota") return `${s.label}: quota exceeded`;
  if (s.status === "auth") return `${s.label}: auth error`;
  return `${s.label}: error`;
}

const envForProbes = { ...loadEnvFile(), ...process.env };
const geminiKey = envForProbes["GEMINI_API_KEY"] ?? "";
const groqKey = envForProbes["GROQ_API_KEY"] ?? "";

// Security diff-review, Phase 49: these were sequential awaits, adding up to
// 16s of blocking startup latency worst-case (two 8s timeouts back to back).
// apiModelsSection() in status-cmd.ts already runs the same two probes via
// Promise.all — mirror that pattern here instead of re-serializing it.
const [geminiResult, groqResult] = await Promise.all([
  geminiKey
    ? probeGemini(geminiKey, envForProbes["GEMINI_DEFAULT"] ?? envForProbes["GEMINI_MODEL"] ?? GEMINI_DEFAULT_MODEL)
    : Promise.resolve(null),
  groqKey
    ? probeGroq(groqKey, envForProbes["LLAMA4_DEFAULT"] ?? LLAMA4_DEFAULT_MODEL)
    : Promise.resolve(null),
]);

const platformResults: string[] = [];
if (geminiResult) {
  platformResults.push(fmtPlatform(geminiResult));
} else {
  platformResults.push("Gemini: no key");
}
if (groqResult) {
  platformResults.push(fmtPlatform(groqResult));
} else {
  platformResults.push("Groq: no key");
}
const agy = checkAgyAuth();
platformResults.push(agy.configured ? `Antigravity: ready (${agy.cliVersion})` : agy.cliPresent ? "Antigravity: not ready" : "Antigravity: not found");

console.log(`${col("Platforms")}${platformResults.join("   ")}`);

console.log("");

// ── Ollama ───────────────────────────────────────────────────────────────────

const ollama = await checkOllama();

if (ollama.running) {
  const list = ollama.models.length > 0
    ? ollama.models.join("  ")
    : "no models installed";
  console.log(`${col("Ollama")}running  [${list}]`);
} else {
  console.log(`${col("Ollama")}not running  (start: ollama serve)`);
}

console.log("");
console.log(DIV);
console.log("  Commands: wire send | wire recv | wire route | wire inspect | wire-gateway");
console.log(`${DIV}\n`);

// ── Daily Brief ──────────────────────────────────────────────────────────────

// Optional: WIRE_BRIEFING_PATH or .wire-state/local.json "briefingPath".
const briefingPath = localBriefingPath();

if (briefingPath && existsSync(briefingPath)) {
  const ageMs = Date.now() - statSync(briefingPath).mtimeMs;
  if (ageMs < 86_400_000) {
    console.log(`── Daily Brief ${"─".repeat(44)}`);
    console.log(readFileSync(briefingPath, "utf8").slice(0, 800));
    console.log(DIV);
    console.log("");
  }
}

// ── Linux context (silent — runs after display) ───────────────────────────────
await updateLinuxContext().catch(() => { /* non-fatal */ });
