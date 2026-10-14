// Model configuration — Wire Platform
//
// All model assignments live here. To swap a model, set the corresponding
// env var in .env and restart the dispatch loop. No source changes needed.
//
// Env vars (all optional — defaults shown below):
//
//   OLLAMA_URL          http://localhost:11434
//   OLLAMA_QUICK        qwen3:1.7b
//   OLLAMA_SUMMARIZE    qwen3:1.7b
//   OLLAMA_CLASSIFY     qwen3:4b
//   OLLAMA_EXPLAIN      qwen3:4b
//   OLLAMA_CODE_REVIEW  qwen2.5-coder:14b
//   OLLAMA_DEBUG        qwen2.5-coder:14b
//   OLLAMA_LOCAL_CODE   qwen2.5-coder:14b
//   OLLAMA_LOCAL_REVIEW qwen2.5-coder:14b
//   OLLAMA_LOCAL_REASON qwen3:4b
//   OLLAMA_DEFAULT      qwen3:1.7b      (fallback for unmapped skills)
//   OLLAMA_DEEPSEEK     deepseek-r1:8b  (opt-in: code/math only — NOT in default routing)
//   EMBED_MODEL         nomic-embed-text
//
//   GEMINI_RESEARCH     gemini-3.7-flash
//   GEMINI_PLAN         gemini-3.7-flash
//   GEMINI_EXPLAIN      gemini-3.7-flash
//   GEMINI_VERIFY       gemini-3.7-flash
//   GEMINI_IMPLEMENT    gemini-3.7-flash
//   GEMINI_ARCHITECT    gemini-3.7-flash
//   GEMINI_REFACTOR     gemini-3.7-flash
//   GEMINI_AUDIT        gemini-3.7-flash
//   GEMINI_DEFAULT      gemini-3.7-flash       (fallback for unmapped skills)
//   Note: every skill fallback derives from GEMINI_DEFAULT_MODEL below — one
//   source of truth. Update GEMINI_DEFAULT (or the fallback literal here) and
//   all skills move together. (2026-08-11: gemini-2.0-flash retired;
//   2026-08-28: gemini-3.5-flash -> gemini-3.7-flash, comment block had
//   drifted from the live default below — a drift check caught it)
//
//   NOT the same route as Antigravity/agy below: this GEMINI_* section is
//   the free/low-cost API+CLI route (MODEL-PROVIDER-POLICY.md's "gemini"
//   agent — Gemini free API / Gemini CLI). agy is a distinct manual-only
//   app/token via Google account OAuth, never an automatic fallback for
//   this route or vice versa (MODEL-PROVIDER-POLICY.md, explicit rule).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "../..");

function loadEnvFile(): Record<string, string> {
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

function env(key: string, fallback: string): string {
  return process.env[key] ?? loadEnvFile()[key] ?? fallback;
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

export const OLLAMA_URL = env("OLLAMA_URL", "http://localhost:11434");

export const OLLAMA_SKILL_MODEL: Record<string, string> = {
  quick:        env("OLLAMA_QUICK",        "qwen3:1.7b"),
  summarize:    env("OLLAMA_SUMMARIZE",    "qwen3:1.7b"),
  classify:     env("OLLAMA_CLASSIFY",     "qwen3:4b"),
  explain:      env("OLLAMA_EXPLAIN",      "qwen3:4b"),
  code_review:  env("OLLAMA_CODE_REVIEW",  "qwen2.5-coder:14b"),
  debug:        env("OLLAMA_DEBUG",        "qwen2.5-coder:14b"),
  local_code:   env("OLLAMA_LOCAL_CODE",   "qwen2.5-coder:14b"),
  local_review: env("OLLAMA_LOCAL_REVIEW", "qwen2.5-coder:14b"),
  local_reason: env("OLLAMA_LOCAL_REASON", "qwen3:4b"),
  // deepseek: restricted to code/math only — off by default, opt-in via env var
  deepseek:     env("OLLAMA_DEEPSEEK",     "deepseek-r1:8b"),
};

export const OLLAMA_DEFAULT_MODEL = env("OLLAMA_DEFAULT", "qwen3:1.7b");

// ─── Embed ────────────────────────────────────────────────────────────────────

export const EMBED_MODEL = env("EMBED_MODEL", "nomic-embed-text");

// ─── Gemini (free API / CLI route — distinct from Antigravity/agy below) ──────

// Single source of truth for the Gemini fallback literal — every skill below
// derives from this instead of repeating the model string per line.
export const GEMINI_DEFAULT_MODEL = env("GEMINI_DEFAULT", "gemini-3.7-flash");

export const GEMINI_SKILL_MODEL: Record<string, string> = {
  research:  env("GEMINI_RESEARCH",   GEMINI_DEFAULT_MODEL),
  plan:      env("GEMINI_PLAN",       GEMINI_DEFAULT_MODEL),
  explain:   env("GEMINI_EXPLAIN",    GEMINI_DEFAULT_MODEL),
  verify:    env("GEMINI_VERIFY",     GEMINI_DEFAULT_MODEL),
  implement: env("GEMINI_IMPLEMENT",  GEMINI_DEFAULT_MODEL),
  architect: env("GEMINI_ARCHITECT",  GEMINI_DEFAULT_MODEL),
  refactor:  env("GEMINI_REFACTOR",   GEMINI_DEFAULT_MODEL),
  audit:     env("GEMINI_AUDIT",      GEMINI_DEFAULT_MODEL),
};

// ─── Groq (free tier) ────────────────────────────────────────────────────────
//
// Groq free tier — no billing required. OpenAI-compatible API.
// Free tier limits (2026-08-17): 30 RPM, 8K TPM, 1K RPD for all models below.
//
// Active models:
//   openai/gpt-oss-20b  — 30 RPM,  8K TPM, 1K RPD — fast path (quick/summarize/explain)
//   openai/gpt-oss-120b — 30 RPM,  8K TPM, 1K RPD — capable path (research/plan/implement)
//
// DEPRECATED (removed from Groq — DO NOT USE):
//   llama-3.3-70b-versatile — removed 2026-08-17 (HTTP 404 confirmed)
//   llama-3.1-8b-instant    — removed from free tier 2026-06-17
//
// Env overrides (set in .env):
//   GROQ_API_KEY       — free key from console.groq.com
//   LLAMA4_FAST        — default: openai/gpt-oss-20b
//   LLAMA4_CAPABLE     — default: openai/gpt-oss-120b
//   LLAMA4_DEFAULT     — default: openai/gpt-oss-20b (overrides LLAMA4_FAST for status probe)

export const GROQ_API_BASE = env("GROQ_API_BASE", "https://api.groq.com/openai/v1");
export const LLAMA4_FAST     = env("LLAMA4_FAST",    "openai/gpt-oss-20b");  // was llama-3.3-70b-versatile (removed 2026-08-17)
export const LLAMA4_CAPABLE  = env("LLAMA4_CAPABLE", "openai/gpt-oss-120b"); // was llama-3.3-70b-versatile (removed 2026-08-17)

export const LLAMA4_SKILL_MODEL: Record<string, string> = {
  explain:   env("LLAMA4_EXPLAIN",   LLAMA4_FAST),
  summarize: env("LLAMA4_SUMMARIZE", LLAMA4_FAST),
  quick:     env("LLAMA4_QUICK",     LLAMA4_FAST),
  plan:      env("LLAMA4_PLAN",      LLAMA4_CAPABLE),
  research:  env("LLAMA4_RESEARCH",  LLAMA4_CAPABLE),
  implement: env("LLAMA4_IMPLEMENT", LLAMA4_CAPABLE),
};

export const LLAMA4_DEFAULT_MODEL = env("LLAMA4_DEFAULT", LLAMA4_FAST);

// ─── DeepSeek (via Groq free tier) ───────────────────────────────────────────
//
// Reasoning model via Groq. Uses same GROQ_API_KEY.
// Chain-of-thought: responses include <think>...</think> blocks. Wire strips them.
// Strengths: step-by-step debugging, mathematical reasoning, deep code analysis.
// Restriction: code/math/logic ONLY — do NOT route research/explain/summarize here.
//
// DEPRECATED (Groq deprecated this model 2025-10-02 — DO NOT USE as default):
//   deepseek-r1-distill-llama-70b
// Replaced with openai/gpt-oss-120b (Groq's recommended reasoning-capable
// replacement; verified against console.groq.com/docs/deprecations 2026-08-11).
//
// Env overrides:
//   DEEPSEEK_MODEL    default: openai/gpt-oss-120b
//   DEEPSEEK_DEBUG    default: openai/gpt-oss-120b
//   DEEPSEEK_ANALYZE  default: openai/gpt-oss-120b

export const DEEPSEEK_DEFAULT_MODEL  = env("DEEPSEEK_MODEL",   "openai/gpt-oss-120b");

export const DEEPSEEK_SKILL_MODEL: Record<string, string> = {
  debug:   env("DEEPSEEK_DEBUG",   DEEPSEEK_DEFAULT_MODEL),
  analyze: env("DEEPSEEK_ANALYZE", DEEPSEEK_DEFAULT_MODEL),
  reason:  env("DEEPSEEK_REASON",  DEEPSEEK_DEFAULT_MODEL),
};

// ─── Antigravity / agy (Gemini via Google account OAuth — distinct from the ──
// ─── free Gemini API/CLI route above; never an automatic fallback for it) ────
//
// agy CLI exposes Gemini model families with per-model effort tiers:
//
//   Flash family (fast, high-volume):
//     gemini-3.7-flash-low    — fastest, minimal reasoning effort
//     gemini-3.7-flash-medium — balanced (Wire default for most skills)
//     gemini-3.7-flash-high   — max reasoning effort on flash model
//
//   Pro family (frontier, complex tasks):
//     gemini-3.1-pro-low      — frontier model, balanced effort
//     gemini-3.1-pro-high     — frontier model, max effort
//
// Flex guidance:
//   Flex DOWN (speed/quota): set AGY_DEFAULT=gemini-3.7-flash-low in .env
//   Flex UP (quality):       set AGY_RESEARCH=gemini-3.1-pro-high in .env
//   Frontier for synthesis:  set AGY_SYNTHESIZE=gemini-3.1-pro-high in .env
//
// Env overrides (all optional):
//   AGY_DEFAULT     gemini-3.7-flash-medium   (base for all unmapped skills)
//   AGY_RESEARCH    gemini-3.7-flash-medium   (flex up: gemini-3.1-pro-high)
//   AGY_PLAN        gemini-3.7-flash-medium
//   AGY_EXPLAIN     gemini-3.7-flash-low      (speed-optimised)
//   AGY_SUMMARIZE   gemini-3.7-flash-low
//   AGY_SYNTHESIZE  gemini-3.1-pro-low        (frontier for deep synthesis)

export const AGY_DEFAULT_MODEL = env("AGY_DEFAULT", "gemini-3.7-flash-medium");

export const AGY_SKILL_MODEL: Record<string, string> = {
  research:  env("AGY_RESEARCH",   AGY_DEFAULT_MODEL),
  plan:      env("AGY_PLAN",       AGY_DEFAULT_MODEL),
  explain:   env("AGY_EXPLAIN",    "gemini-3.7-flash-low"),
  summarize: env("AGY_SUMMARIZE",  "gemini-3.7-flash-low"),
  synthesize: env("AGY_SYNTHESIZE", "gemini-3.1-pro-low"),
};
