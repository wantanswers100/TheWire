// wire setup — guided first-run prerequisite check
//
// Verifies: Ollama running, required models pulled, keypairs present,
// inbox + state directories accessible. Prints status table + fix commands.
// No writes — read-only check. Printing fix commands is explicit; user runs them.
//
// Usage: wire setup [--quiet]

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OLLAMA = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

const REQUIRED_MODELS: Array<{ name: string; purpose: string }> = [
  { name: "qwen3:1.7b",        purpose: "quick/summarize — fast local" },
  { name: "qwen3:4b",          purpose: "classify/route/explain — 256K ctx" },
  { name: "qwen2.5-coder:14b", purpose: "code review + diagnose" },
  { name: "nomic-embed-text",  purpose: "RAG embeddings" },
];

const AGENT_IDS = ["claude", "gemini", "codex", "ollama", "system"] as const;

interface Check {
  label: string;
  ok: boolean;
  note: string;
  fix?: string;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

async function checkOllama(): Promise<{ running: boolean; models: string[] }> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json() as { models?: Array<{ name: string }> };
    return {
      running: true,
      models: (data.models ?? []).map(m => m.name),
    };
  } catch {
    return { running: false, models: [] };
  }
}

function modelMatches(pulled: string[], required: string): boolean {
  // "qwen3:4b" matches "qwen3:4b" or "qwen3:4b-instruct-q4_K_M" etc.
  return pulled.some(p => p === required || p.startsWith(required.split(":")[0]! + ":" + required.split(":")[1]!));
}

function checkKeys(keysDir: string): Check[] {
  return AGENT_IDS.map(id => {
    const skPath = join(keysDir, `${id}.ed25519.sk`);
    const x25519Path = join(keysDir, `${id}.x25519.sk`);
    const hasEd = existsSync(skPath);
    const hasX = existsSync(x25519Path);
    const ok = hasEd && hasX;
    return {
      label: `keypair: ${id}`,
      ok,
      note: ok
        ? "Ed25519 + X25519 present"
        : hasEd && !hasX
          ? "Ed25519 present but X25519 missing"
          : "missing",
      fix: ok ? undefined : `wire keygen ${id}`,
    };
  });
}

function checkDir(path: string, label: string): Check {
  const ok = existsSync(path);
  return {
    label,
    ok,
    note: ok ? path : "not found",
    fix: ok ? undefined : `mkdir -p "${path}"`,
  };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function badge(ok: boolean): string {
  return ok ? "[ OK ]" : "[WARN]";
}

function printChecks(checks: Check[]): void {
  for (const c of checks) {
    const b = badge(c.ok);
    const line = `  ${b} ${c.label.padEnd(30)} ${c.note}`;
    console.log(line);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runSetup(
  args: string[],
  keysDir: string,
  stateDir: string,
): Promise<void> {
  const quiet = args.includes("--quiet");

  console.log("\nwire setup — checking prerequisites\n");

  // ── Ollama ──────────────────────────────────────────────────────────────────
  if (!quiet) console.log("Ollama");
  const { running, models: pulledModels } = await checkOllama();

  const ollamaCheck: Check = {
    label: "Ollama daemon",
    ok: running,
    note: running ? OLLAMA : `not reachable at ${OLLAMA}`,
    fix: running ? undefined : "ollama serve",
  };

  const modelChecks: Check[] = REQUIRED_MODELS.map(m => ({
    label: `model: ${m.name}`,
    ok: running && modelMatches(pulledModels, m.name),
    note: !running
      ? "Ollama not running"
      : modelMatches(pulledModels, m.name)
        ? m.purpose
        : `not pulled — ${m.purpose}`,
    fix: running && !modelMatches(pulledModels, m.name)
      ? `ollama pull ${m.name}`
      : undefined,
  }));

  printChecks([ollamaCheck, ...modelChecks]);

  // ── Keys ────────────────────────────────────────────────────────────────────
  if (!quiet) console.log("\nKeypairs");
  const keyChecks = checkKeys(keysDir);
  printChecks(keyChecks);

  // ── Directories ─────────────────────────────────────────────────────────────
  if (!quiet) console.log("\nDirectories");
  const inboxDir = join(
    process.env["HOME"] ?? homedir(),
    "projects",
    "inbox",
  );
  const dirChecks: Check[] = [
    checkDir(stateDir, ".wire-state/"),
    checkDir(keysDir, ".keys/"),
    checkDir(inboxDir, "~/projects/inbox/"),
  ];
  printChecks(dirChecks);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const allChecks = [ollamaCheck, ...modelChecks, ...keyChecks, ...dirChecks];
  const warnings = allChecks.filter(c => !c.ok);
  const fixes = allChecks.filter(c => !c.ok && c.fix);

  console.log();
  if (warnings.length === 0) {
    console.log("  All checks passed. Wire Platform is ready.\n");
    console.log("  Quick start:");
    console.log('    wire - summarize my standup notes');
    console.log('    wire - show me my disk usage');
    console.log('    wire - what is the weather in NYC --to gemini --live');
    console.log();
    return;
  }

  console.log(`  ${warnings.length} check(s) need attention.\n`);
  if (fixes.length > 0) {
    console.log("  Fix commands (run these manually):");
    for (const c of fixes) {
      console.log(`    ${c.fix}`);
    }
    console.log();
  }

  const missingKeys = keyChecks.filter(c => !c.ok);
  if (missingKeys.length > 0 && missingKeys.length === AGENT_IDS.length) {
    console.log("  First-run? Generate all keypairs with:");
    console.log("    for id in claude gemini codex ollama system; do wire keygen $id; done");
    console.log();
  }
}
