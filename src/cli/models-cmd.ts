// wire models — model management and inspection
//
// Usage:
//   wire models list                  list ALL models: local (Ollama) + configured API providers
//   wire models test                  health-test every configured model (local + API)
//   wire models loaded                show models currently warm in RAM (/api/ps)
//   wire models set <skill> <model>   assign a local model to a Wire skill (writes .env)
//   wire models pull <name>           pull a model from Ollama registry
//   wire models remove <name>         remove a local model from Ollama
//   wire models info                  show .env overrides + API key statuses
//
// Adding a local model:
//   wire models pull llama3.2
//   wire models set explain llama3.2
//   wire models test    ← verify it responds
//
// Adding an API provider:
//   Open .env at path shown in `wire models list`
//   Add:  PROVIDER_API_KEY=<key>
//   Save, then run `wire models test` to verify the key is active

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OLLAMA_URL,
  OLLAMA_SKILL_MODEL,
  OLLAMA_DEFAULT_MODEL,
  EMBED_MODEL,
  GEMINI_SKILL_MODEL,
  GEMINI_DEFAULT_MODEL,
  LLAMA4_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
} from "../config/models.js";

const PROJECT_ROOT = join(import.meta.dir, "../..");
const ENV_FILE     = join(PROJECT_ROOT, ".env");

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  dim:    "\x1b[90m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  cyan:   "\x1b[36m",
  bold:   "\x1b[1m",
};

function ok(s: string)   { return `${C.green}${s}${C.reset}`; }
function warn(s: string) { return `${C.yellow}${s}${C.reset}`; }
function fail(s: string) { return `${C.red}${s}${C.reset}`; }
function dim(s: string)  { return `${C.dim}${s}${C.reset}`; }
function bold(s: string) { return `${C.bold}${s}${C.reset}`; }
function cyan(s: string) { return `${C.cyan}${s}${C.reset}`; }

// ─── Skill → .env key (local Ollama models) ───────────────────────────────────

const SKILL_TO_ENV: Record<string, string> = {
  quick:        "OLLAMA_QUICK",
  summarize:    "OLLAMA_SUMMARIZE",
  classify:     "OLLAMA_CLASSIFY",
  explain:      "OLLAMA_EXPLAIN",
  code_review:  "OLLAMA_CODE_REVIEW",
  debug:        "OLLAMA_DEBUG",
  local_code:   "OLLAMA_LOCAL_CODE",
  local_review: "OLLAMA_LOCAL_REVIEW",
  local_reason: "OLLAMA_LOCAL_REASON",
  deepseek:     "OLLAMA_DEEPSEEK",
  default:      "OLLAMA_DEFAULT",
  embed:        "EMBED_MODEL",
};

// ─── API provider registry ────────────────────────────────────────────────────

interface ApiProvider {
  id:          string;
  name:        string;
  envKey:      string;
  defaultModel: string;
  models:      string[];
  skills:      string[];
  status:      "active" | "planned";
  setupNote:   string;           // shown in the "not configured" compact list
  testFn:      (key: string, model: string) => Promise<TestResult>;
}

// ─── Timeout constants ────────────────────────────────────────────────────────
// Local: 45s — generous for cold-start of 9 GB model under load
// API:   15s — network round-trip; flag as failure if provider is unresponsive

const TIMEOUT_LOCAL_MS = 45_000;
const TIMEOUT_API_MS   = 15_000;

// ─── .env helpers ─────────────────────────────────────────────────────────────

function readEnvContent(): string {
  return existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
}

function getEnvValue(key: string, content: string): string | null {
  const m = content.match(new RegExp(`^${key}=(.+)$`, "m"));
  return m ? m[1]!.trim() || null : null;
}

function writeEnvKey(key: string, value: string): void {
  const current = readEnvContent();
  const lines = current.split("\n");
  const idx = lines.findIndex(
    l => l.trimStart().startsWith(`${key}=`) && !l.trimStart().startsWith("#"),
  );
  if (idx >= 0) {
    lines[idx] = `${key}=${value}`;
    writeFileSync(ENV_FILE, lines.join("\n"), "utf8");
  } else {
    writeFileSync(ENV_FILE, `${current.trimEnd()}\n${key}=${value}\n`, "utf8");
  }
}

// ─── Ollama response types ─────────────────────────────────────────────────────

type OllamaTagsResponse = {
  models: Array<{ name: string; size: number; digest: string; details?: { parameter_size?: string } }>;
};
type OllamaPsResponse = {
  models: Array<{ name: string; size_vram: number; expires_at: string; details?: { parameter_size?: string } }>;
};

function formatBytes(b: number): string {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(0)} MB`;
  return `${b} B`;
}

// ─── Test result ──────────────────────────────────────────────────────────────

interface TestResult {
  ok:          boolean;
  elapsedMs:   number;
  error?:      string;       // short error label
  fix?:        string[];     // ordered list of fix suggestions
}

// ─── Ollama model tester ───────────────────────────────────────────────────────

async function testOllamaModel(model: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      // think: false is a top-level Ollama param (not inside options) that disables qwen3
      // reasoning/thinking mode. Without it, <think> blocks consume all num_predict tokens.
      body:    JSON.stringify({ model, prompt: "Reply with the single word OK", stream: false, think: false, options: { num_predict: 30 } }),
      signal:  AbortSignal.timeout(TIMEOUT_LOCAL_MS),
    });

    const elapsed = Date.now() - t0;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const isNotFound = res.status === 404 || body.includes("not found");
      return {
        ok: false, elapsedMs: elapsed,
        error: isNotFound ? `model not found` : `HTTP ${res.status}`,
        fix: isNotFound
          ? [`wire models pull ${model}`]
          : [`Check Ollama is running: ollama list`, `Restart: ollama serve`],
      };
    }

    const data = await res.json() as { response?: string };
    if (!data.response) throw new Error("empty response");
    return { ok: true, elapsedMs: elapsed };

  } catch (e) {
    const elapsed = Date.now() - t0;
    const isTimeout = elapsed >= TIMEOUT_LOCAL_MS - 500;
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false, elapsedMs: elapsed,
      error: isTimeout ? `timeout after ${(TIMEOUT_LOCAL_MS / 1000)}s` : msg,
      fix: isTimeout
        ? [
            `Model cold-start may exceed ${TIMEOUT_LOCAL_MS / 1000}s — pre-warm with: ollama run ${model}`,
            `Or assign a lighter model: wire models set <skill> qwen3:1.7b`,
          ]
        : [`Start Ollama: ollama serve`, `Check model: ollama list`],
    };
  }
}

// ─── Embed tester ─────────────────────────────────────────────────────────────

async function testEmbedModel(model: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model, prompt: "test" }),
      signal:  AbortSignal.timeout(TIMEOUT_LOCAL_MS),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) return { ok: false, elapsedMs: elapsed, error: `HTTP ${res.status}`,
      fix: [`wire models pull ${model}`] };
    const data = await res.json() as { embedding?: number[] };
    if (!data.embedding?.length) throw new Error("empty embedding");
    return { ok: true, elapsedMs: elapsed };
  } catch (e) {
    const elapsed = Date.now() - t0;
    return { ok: false, elapsedMs: elapsed,
      error: e instanceof Error ? e.message : String(e),
      fix: [`wire models pull ${model}`, `Start Ollama: ollama serve`] };
  }
}

// ─── Gemini tester ────────────────────────────────────────────────────────────

async function testGemini(key: string, model: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ contents: [{ parts: [{ text: "Reply with: OK" }] }] }),
      signal:  AbortSignal.timeout(TIMEOUT_API_MS),
    });
    const elapsed = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, elapsedMs: elapsed, error: `auth error (${res.status})`,
        fix: [`GEMINI_API_KEY is invalid or expired`, `Update key in: ${ENV_FILE}`, `Get new key → aistudio.google.com/apikey`] };
    }
    if (res.status === 429) {
      return { ok: false, elapsedMs: elapsed, error: `quota exceeded (429)`,
        fix: [`Gemini free-tier quota hit`, `Wait or upgrade at: aistudio.google.com`] };
    }
    if (!res.ok) {
      return { ok: false, elapsedMs: elapsed, error: `HTTP ${res.status}`,
        fix: [`Check Gemini API status`, `Try: wire models test`] };
    }
    const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    if (!text) throw new Error("empty response");
    return { ok: true, elapsedMs: elapsed };
  } catch (e) {
    const elapsed = Date.now() - t0;
    const isTimeout = elapsed >= TIMEOUT_API_MS - 500;
    return { ok: false, elapsedMs: elapsed,
      error: isTimeout ? `timeout after ${TIMEOUT_API_MS / 1000}s` : (e instanceof Error ? e.message : String(e)),
      fix: isTimeout
        ? [`Gemini API unresponsive — check status at status.cloud.google.com`, `Try again in a few minutes`]
        : [`Check internet connection`, `Verify GEMINI_API_KEY in ${ENV_FILE}`] };
  }
}

// ─── Groq tester (shared by llama4 + deepseek providers) ─────────────────────

async function testGroq(key: string, model: string): Promise<TestResult> {
  const t0 = Date.now();
  try {
    // Reasoning models (gpt-oss, deepseek family) spend part of max_tokens on
    // internal <think>/reasoning tokens before emitting visible content — a
    // budget of 10 can be consumed entirely by reasoning, leaving content
    // empty with finish_reason:"length" even though the model is healthy.
    // Verified against api.groq.com/openai/v1/chat/completions 2026-08-11.
    const isReasoningModel = /gpt-oss|deepseek/i.test(model);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word OK" }],
        temperature: 0,
        max_tokens: isReasoningModel ? 60 : 10,
      }),
      signal: AbortSignal.timeout(TIMEOUT_API_MS),
    });
    const elapsed = Date.now() - t0;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, elapsedMs: elapsed, error: `auth error (${res.status})`,
        fix: [`GROQ_API_KEY is invalid or expired`, `Update key in: ${ENV_FILE}`, `Get free key → console.groq.com`] };
    }
    if (res.status === 429) {
      return { ok: false, elapsedMs: elapsed, error: `rate limit (429)`,
        fix: [`Groq free tier: 30 RPM / 1K RPD per model`, `Wait and retry`, `Check quota at console.groq.com`] };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, elapsedMs: elapsed, error: `HTTP ${res.status}`,
        fix: [`Groq error: ${body.slice(0, 100)}`] };
    }
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("empty response");
    return { ok: true, elapsedMs: elapsed };
  } catch (e) {
    const elapsed = Date.now() - t0;
    const isTimeout = elapsed >= TIMEOUT_API_MS - 500;
    return { ok: false, elapsedMs: elapsed,
      error: isTimeout ? `timeout after ${TIMEOUT_API_MS / 1000}s` : (e instanceof Error ? e.message : String(e)),
      fix: isTimeout
        ? [`Groq API unresponsive — check status.groq.com`]
        : [`Check internet connection`, `Verify GROQ_API_KEY in ${ENV_FILE}`] };
  }
}

// ─── API provider registry ────────────────────────────────────────────────────

const API_PROVIDERS: ApiProvider[] = [
  {
    id:           "gemini",
    name:         "Gemini (Google AI)",
    envKey:       "GEMINI_API_KEY",
    defaultModel: GEMINI_DEFAULT_MODEL,
    models:       [GEMINI_DEFAULT_MODEL],
    skills:       Object.keys(GEMINI_SKILL_MODEL),
    status:       "active",
    setupNote:    "aistudio.google.com/apikey",
    testFn:       (key) => testGemini(key, GEMINI_DEFAULT_MODEL),
  },
  {
    id:           "anthropic",
    name:         "Claude (Anthropic API)",
    envKey:       "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    models:       ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
    skills:       ["implement", "debug", "verify", "audit", "architecture"],
    status:       "planned",
    setupNote:    "console.anthropic.com/settings/keys",
    testFn:       async () => ({ ok: false, elapsedMs: 0, error: "not yet integrated", fix: ["Direct Anthropic API planned — Wire uses claude CLI today"] }),
  },
  {
    id:           "openai",
    name:         "OpenAI (GPT)",
    envKey:       "OPENAI_API_KEY",
    defaultModel: "gpt-4o-mini",
    models:       ["gpt-4o", "gpt-4o-mini", "o3"],
    skills:       ["scaffold", "implement", "boilerplate"],
    status:       "planned",
    setupNote:    "platform.openai.com/api-keys",
    testFn:       async () => ({ ok: false, elapsedMs: 0, error: "not yet integrated", fix: ["Direct OpenAI API planned — Wire uses codex CLI today"] }),
  },
  {
    id:           "perplexity",
    name:         "Perplexity (Sonar)",
    envKey:       "PERPLEXITY_API_KEY",
    defaultModel: "sonar",
    models:       ["sonar", "sonar-pro", "sonar-reasoning"],
    skills:       ["research", "query"],
    status:       "planned",
    setupNote:    "perplexity.ai/settings/api",
    testFn:       async () => ({ ok: false, elapsedMs: 0, error: "not yet integrated", fix: ["Perplexity integration planned"] }),
  },
  {
    id:           "groq",
    name:         "Groq (Llama 4 / fast inference)",
    envKey:       "GROQ_API_KEY",
    defaultModel: LLAMA4_DEFAULT_MODEL,
    models:       [LLAMA4_DEFAULT_MODEL, "openai/gpt-oss-20b"],
    skills:       ["explain", "summarize", "quick", "plan", "research", "implement"],
    status:       "active",
    setupNote:    "console.groq.com (free — no credit card)",
    testFn:       (key) => testGroq(key, LLAMA4_DEFAULT_MODEL),
  },
  {
    id:           "deepseek",
    name:         "GPT-OSS 120B reasoning (via Groq)",
    envKey:       "GROQ_API_KEY",   // shares the same key as groq/llama4
    defaultModel: DEEPSEEK_DEFAULT_MODEL,
    models:       [DEEPSEEK_DEFAULT_MODEL],
    skills:       ["debug", "analyze", "reason"],
    status:       "active",
    setupNote:    "console.groq.com — uses same GROQ_API_KEY as Llama 4",
    testFn:       (key) => testGroq(key, DEEPSEEK_DEFAULT_MODEL),
  },
];

// ─── Subcommand: list ─────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const env = readEnvContent();

  // ── Local models ────────────────────────────────────────────────────────────
  console.log(bold("\n── Local Models (Ollama · free · MIT/Apache) ────────────────────"));

  let tags: OllamaTagsResponse | null = null;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    tags = await res.json() as OllamaTagsResponse;
  } catch (e) {
    console.log(`  ${warn("⚡ Ollama offline")} — ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ${dim("Start: ollama serve")}`);
  }

  if (tags) {
    const installed = new Set(tags.models.map(m => m.name));
    for (const m of tags.models) {
      const params = m.details?.parameter_size ?? "";
      console.log(`  ${ok("●")} ${m.name.padEnd(28)} ${dim(formatBytes(m.size).padEnd(9))} ${dim(params)}`);
    }
    console.log(bold("\n  Skill assignments"));
    console.log(dim("  " + "─".repeat(50)));
    for (const [skill, model] of Object.entries(OLLAMA_SKILL_MODEL)) {
      const isIn = installed.has(model) || tags.models.some(m => m.name.split(":")[0] === model.split(":")[0]);
      const marker = isIn ? ok("✓") : warn("✗");
      const note   = isIn ? "" : warn(`  → wire models pull ${model}`);
      console.log(`  ${marker}  ${skill.padEnd(14)} → ${model}${note}`);
    }
    console.log(dim(`\n  default (unmatched): ${OLLAMA_DEFAULT_MODEL}`));
    console.log(dim(`  add model:  wire models pull <name>`));
    console.log(dim(`  reassign:   wire models set <skill> <model>`));
    console.log(dim(`  verify:     wire models test`));
  }

  // ── Configured API providers ─────────────────────────────────────────────────
  const configured   = API_PROVIDERS.filter(p => getEnvValue(p.envKey, env) !== null);
  const unconfigured = API_PROVIDERS.filter(p => getEnvValue(p.envKey, env) === null);

  if (configured.length > 0) {
    console.log(bold("\n── API Models (key configured) ──────────────────────────────────"));
    for (const p of configured) {
      const badge = p.status === "active" ? ok("[active]") : warn("[planned]");
      console.log(`  ${ok("●")} ${bold(p.name)}  ${badge}`);
      console.log(`     ${ok("✓")} ${p.envKey} = ${dim("****")}`);
      console.log(`     ${dim("Models:  " + p.models.join("  ·  "))}`);
      console.log(`     ${dim("Skills:  " + p.skills.join("  ·  "))}`);
      console.log(`     ${dim("Run test: wire models test")}`);
      console.log();
    }
  }

  // ── Unconfigured providers — compact list ─────────────────────────────────
  if (unconfigured.length > 0) {
    console.log(bold("\n── API Models (not configured) ──────────────────────────────────"));
    console.log(dim(`   To add: open ${ENV_FILE} and add the key`));
    console.log();
    for (const p of unconfigured) {
      const badge = p.status === "active" ? "[active]" : "[planned]";
      console.log(`  ${dim("○")} ${p.name.padEnd(28)} ${dim(badge)}`);
      console.log(`     ${dim(p.envKey + "=<key>")}`);
      console.log(`     ${dim("Get key → " + p.setupNote)}`);
      console.log();
    }
    console.log(dim("  After adding a key, run: wire models test"));
  }

  console.log();
}

// ─── Subcommand: test ─────────────────────────────────────────────────────────

async function cmdTest(): Promise<void> {
  const env = readEnvContent();
  let passed = 0;
  let failed = 0;

  // ── Local models ─────────────────────────────────────────────────────────────
  console.log(bold("\nTesting local models (Ollama)"));
  console.log(dim(`  Timeout per model: ${TIMEOUT_LOCAL_MS / 1000}s`));
  console.log(dim("─".repeat(56)));

  // Deduplicate: each unique model tested once; track which skills it serves
  const modelToSkills: Map<string, string[]> = new Map();
  for (const [skill, model] of Object.entries(OLLAMA_SKILL_MODEL)) {
    const skills = modelToSkills.get(model) ?? [];
    skills.push(skill);
    modelToSkills.set(model, skills);
  }
  // Embed model separate
  modelToSkills.set(EMBED_MODEL, ["embed"]);

  for (const [model, skills] of modelToSkills) {
    const isEmbed = skills.includes("embed");
    process.stdout.write(`  ${dim("●")} ${model.padEnd(28)} ${dim("[" + skills.join("/") + "]")}  `);

    const result = isEmbed ? await testEmbedModel(model) : await testOllamaModel(model);
    const elapsed = (result.elapsedMs / 1000).toFixed(1);

    if (result.ok) {
      process.stdout.write(`${ok("✓")} ${dim(elapsed + "s")}\n`);
      passed++;
    } else {
      process.stdout.write(`${fail("✗")} ${warn(result.error ?? "failed")}\n`);
      if (result.fix?.length) {
        for (const line of result.fix) {
          console.log(`     ${dim("→ " + line)}`);
        }
      }
      failed++;
    }
  }

  // ── API providers ────────────────────────────────────────────────────────────
  const activeWithKey = API_PROVIDERS.filter(p => {
    const key = getEnvValue(p.envKey, env);
    return key !== null && p.status === "active";
  });

  if (activeWithKey.length > 0) {
    console.log(bold("\nTesting API models"));
    console.log(dim(`  Timeout per provider: ${TIMEOUT_API_MS / 1000}s`));
    console.log(dim("─".repeat(56)));

    for (const p of activeWithKey) {
      const key = getEnvValue(p.envKey, env)!;
      process.stdout.write(`  ${dim("●")} ${p.name.padEnd(28)} ${dim("[" + p.defaultModel + "]")}  `);

      const result = await p.testFn(key, p.defaultModel);
      const elapsed = (result.elapsedMs / 1000).toFixed(1);

      if (result.ok) {
        process.stdout.write(`${ok("✓")} ${dim(elapsed + "s")}\n`);
        passed++;
      } else {
        process.stdout.write(`${fail("✗")} ${warn(result.error ?? "failed")}\n`);
        if (result.fix?.length) {
          for (const line of result.fix) {
            console.log(`     ${dim("→ " + line)}`);
          }
        }
        failed++;
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log();
  if (failed === 0) {
    console.log(ok(`✓ All ${passed} model${passed !== 1 ? "s" : ""} responding`));
  } else {
    console.log(fail(`✗ ${failed} failure${failed !== 1 ? "s" : ""}`) + dim(`  (${passed} passed, ${failed} failed)`));
    console.log(dim(`  Run 'wire models list' to see configuration`));
  }
  console.log();
}

// ─── Subcommand: loaded ───────────────────────────────────────────────────────

async function cmdLoaded(): Promise<void> {
  console.log(bold("\nModels currently loaded in RAM (Ollama)"));
  console.log(dim("─".repeat(56)));

  let ps: OllamaPsResponse;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ps = await res.json() as OllamaPsResponse;
  } catch (e) {
    console.log(`  ${warn("Ollama offline")} — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (!ps.models?.length) {
    console.log(`  ${dim("No models loaded")} — next request triggers a cold start`);
    console.log();
    return;
  }

  for (const m of ps.models) {
    const expiry    = new Date(m.expires_at);
    const secsLeft  = Math.round((expiry.getTime() - Date.now()) / 1000);
    const expiryStr = secsLeft > 0 ? `unloads in ${secsLeft}s` : "expiring";
    const vram      = m.size_vram > 0 ? `${formatBytes(m.size_vram)} VRAM` : "CPU only";
    const params    = m.details?.parameter_size ?? "";
    console.log(`  ${ok("●")} ${m.name.padEnd(30)} ${dim(vram.padEnd(16))} ${dim(params.padEnd(8))} ${dim(expiryStr)}`);
  }
  console.log();
}

// ─── Subcommand: set ──────────────────────────────────────────────────────────

function cmdSet(skill: string, model: string): void {
  const envKey = SKILL_TO_ENV[skill];
  if (!envKey) {
    console.error(`Unknown skill: ${skill}`);
    console.error(`Known skills: ${Object.keys(SKILL_TO_ENV).join(", ")}`);
    process.exit(1);
  }
  writeEnvKey(envKey, model);
  console.log(`${ok("✓")} ${skill} → ${model}  (${envKey}=${model} written to .env)`);
  console.log(dim(`  Immediate effect for CLI commands.`));
  console.log(dim(`  Dispatch daemon: dispatch stop && dispatch start to reload.`));
  console.log(dim(`  Verify: wire models test`));
}

// ─── Subcommand: pull ─────────────────────────────────────────────────────────

function cmdPull(name: string): void {
  console.log(`Pulling ${bold(name)} from Ollama registry...`);
  const r = spawnSync("ollama", ["pull", name], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`ollama pull failed (exit ${r.status ?? "null"})`);
    process.exit(r.status ?? 1);
  }
  console.log(`\n${ok("✓")} ${name} installed`);
  console.log(dim(`  Assign: wire models set <skill> ${name}`));
  console.log(dim(`  Verify: wire models test`));
}

// ─── Subcommand: remove ───────────────────────────────────────────────────────

function cmdRemove(name: string): void {
  console.log(`Removing ${bold(name)} from Ollama...`);
  const r = spawnSync("ollama", ["rm", name], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`ollama rm failed (exit ${r.status ?? "null"})`);
    process.exit(r.status ?? 1);
  }
  console.log(`${ok("✓")} ${name} removed`);
  console.log(dim(`  If any skill pointed here: wire models set <skill> <replacement>`));
}

// ─── Subcommand: info ─────────────────────────────────────────────────────────

function cmdInfo(): void {
  const env = readEnvContent();
  console.log(bold("\nWire model configuration"));
  console.log(dim(`  ${ENV_FILE}\n`));

  const overrides: string[] = [];
  for (const [skill, envKey] of Object.entries(SKILL_TO_ENV)) {
    const val = getEnvValue(envKey, env);
    if (val) overrides.push(`  ${cyan(envKey)}=${val}  ${dim("(" + skill + ")")}`);
  }
  console.log(bold("  Local overrides (.env)"));
  if (!overrides.length) console.log(dim("  None — using built-in defaults"));
  else overrides.forEach(l => console.log(l));

  console.log(bold("\n  Effective local skill → model"));
  for (const [skill, model] of Object.entries(OLLAMA_SKILL_MODEL))
    console.log(`  ${skill.padEnd(14)} → ${model}`);

  console.log(bold("\n  API provider key status"));
  for (const p of API_PROVIDERS) {
    const hasKey = getEnvValue(p.envKey, env) !== null;
    const badge  = p.status === "active" ? ok("[active]") : dim("[planned]");
    const marker = hasKey ? ok("✓") : warn("✗");
    const note   = hasKey ? dim("****") : warn("not set — add to .env");
    console.log(`  ${marker} ${p.name.padEnd(28)} ${badge}  ${p.envKey}=${note}`);
  }
  console.log();
}

// ─── Subcommand: status (network + availability matrix) ──────────────────────

async function cmdStatus(): Promise<void> {
  const env = readEnvContent();

  // Network check first
  process.stdout.write(bold("\n── Network\n"));
  process.stdout.write(`  ${dim("●")} checking connectivity...  `);
  const t0 = Date.now();
  let netAvailable = false;
  let netLatency = 0;
  try {
    const r = await fetch("https://1.1.1.1", { method: "HEAD", signal: AbortSignal.timeout(2500), cache: "no-store" });
    netLatency = Date.now() - t0;
    netAvailable = r.ok || r.status < 500;
  } catch {
    netLatency = Date.now() - t0;
  }
  process.stdout.write(
    netAvailable
      ? `${ok("●")} ${ok("online")}  ${dim(netLatency + "ms")}\n`
      : `${fail("○")} ${fail("offline")}  ${dim("— API models unavailable")}\n`
  );

  // Ollama check
  let ollamaUp = false;
  try {
    const r = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(1000) });
    ollamaUp = r.ok;
  } catch { /* offline */ }

  console.log(bold("\n── Model Availability"));
  console.log(dim("─".repeat(62)));

  // Helper
  const row = (available: boolean, name: string, note: string, reason?: string) => {
    const marker = available ? ok("●") : dim("○");
    const nameStr = available ? name : dim(name);
    const noteStr = available ? dim(note) : dim(note);
    const reasonStr = reason ? `  ${fail("⚠")} ${warn(reason)}` : "";
    console.log(`  ${marker}  ${nameStr.padEnd(36)} ${noteStr}${reasonStr}`);
  };

  // Local models
  console.log(dim("  Local (Ollama)"));
  const localModels = [
    { name: "qwen3:1.7b",         note: "quick, summarize" },
    { name: "qwen3:4b",           note: "classify, explain, reason" },
    { name: "qwen2.5-coder:14b",  note: "code_review, debug" },
    { name: "nomic-embed-text",   note: "RAG embeddings" },
    { name: "deepseek-r1:8b",     note: "deepseek fallback (local, code/math only)" },
  ];
  for (const m of localModels) {
    if (!ollamaUp) {
      row(false, m.name, m.note, "ollama offline — run: ollama serve");
    } else {
      row(true, m.name, m.note);
    }
  }

  // API models
  console.log(dim("\n  API Models"));
  for (const p of API_PROVIDERS) {
    if (p.status === "planned") {
      row(false, p.name, p.skills.join(", "), "planned — not yet integrated");
      continue;
    }
    const hasKey = getEnvValue(p.envKey, env) !== null;
    if (!hasKey) {
      row(false, p.name, p.skills.join(", "), `${p.envKey} not set — add to ${ENV_FILE}`);
      continue;
    }
    if (!netAvailable) {
      row(false, p.name, p.skills.join(", "), "no network — key set but cannot reach API");
      continue;
    }
    row(true, p.name, p.skills.join(", "));
  }

  // Summary
  const apiReady = API_PROVIDERS.filter(p => {
    if (p.status === "planned") return false;
    if (!getEnvValue(p.envKey, env)) return false;
    return netAvailable;
  });

  console.log(dim("\n─".repeat(62)));
  const localStatus = ollamaUp ? ok("Ollama up") : warn("Ollama offline");
  const netStatus   = netAvailable ? ok("network up") : warn("network offline");
  const apiStatus   = apiReady.length > 0 ? ok(`${apiReady.length} API provider${apiReady.length > 1 ? "s" : ""} ready`) : warn("no API providers reachable");
  console.log(`  ${localStatus}  ·  ${netStatus}  ·  ${apiStatus}`);

  if (!netAvailable) {
    console.log(warn("\n  API models grayed out — offline mode: Ollama only"));
    console.log(dim("  Use: wire ask --models ollama \"<task>\""));
  }

  const missingKeys = API_PROVIDERS.filter(p => p.status === "active" && !getEnvValue(p.envKey, env));
  if (missingKeys.length > 0) {
    console.log(dim(`\n  Missing keys (${missingKeys.length}): ${missingKeys.map(p => p.envKey).join(", ")}`));
    console.log(dim(`  Add to: ${ENV_FILE}`));
  }

  console.log();
}

// ─── Usage ────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("wire models")} — model management (local + API)

${bold("Usage:")}
  wire models list                    All models: local (Ollama) + configured API
  wire models test                    Health-test every configured model
  wire models loaded                  Show local models currently warm in RAM
  wire models set <skill> <model>     Assign a local model to a Wire skill
  wire models pull <name>             Pull a local model from Ollama registry
  wire models remove <name>           Remove a local model from Ollama
  wire models info                    Show .env overrides + API key statuses
  wire models status                  Network check + per-model availability matrix (gray = misconfigured)

${bold("Local skills:")}
  ${Object.keys(SKILL_TO_ENV).join("  ")}

${bold("API providers:")}
  ${API_PROVIDERS.map(p => p.id + " (" + p.envKey + ")").join("\n  ")}

${bold("Examples:")}
  wire models list
  wire models test
  wire models pull llama3.2
  wire models set explain llama3.2
  wire models test              ← verify response
  wire models remove phi3:mini
`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runModels(args: string[]): Promise<void> {
  const subcmd = args[0] ?? "list";

  switch (subcmd) {
    case "list":
    case "ls":
      await cmdList();
      break;

    case "test":
    case "ping":
    case "check":
      await cmdTest();
      break;

    case "loaded":
    case "ps":
      await cmdLoaded();
      break;

    case "set": {
      const [, skill, model] = args;
      if (!skill || !model) {
        console.error("Usage: wire models set <skill> <model>");
        console.error(`Skills: ${Object.keys(SKILL_TO_ENV).join(", ")}`);
        process.exit(1);
      }
      cmdSet(skill, model);
      break;
    }

    case "pull":
    case "add": {
      const name = args[1];
      if (!name) { console.error("Usage: wire models pull <model-name>"); process.exit(1); }
      cmdPull(name);
      break;
    }

    case "remove":
    case "rm":
    case "delete": {
      const name = args[1];
      if (!name) { console.error("Usage: wire models remove <model-name>"); process.exit(1); }
      cmdRemove(name);
      break;
    }

    case "status":
    case "availability":
    case "avail":
      await cmdStatus();
      break;

    case "info":
    case "config":
      cmdInfo();
      break;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown subcommand: ${subcmd}`);
      printHelp();
      process.exit(1);
  }
}
