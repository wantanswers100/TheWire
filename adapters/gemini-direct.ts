#!/usr/bin/env bun
// gemini-direct.ts — call Gemini API directly from the Wire Platform
//
// Used when Claude (as orchestrator) wants Gemini to handle a task directly,
// without going through the wire gateway. Reads GEMINI_API_KEY and
// GEMINI_MODEL from .env.
//
// Usage:
//   echo '{"prompt":"summarize X","skill":"research"}' | bun run adapters/gemini-direct.ts
//   Or imported as a module: import { callGemini } from "./adapters/gemini-direct.js"

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const PROJECT_ROOT = join(import.meta.dir, "..");
const ENV_PATH = join(PROJECT_ROOT, ".env");

// ─── Load .env ────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const lines = readFileSync(ENV_PATH, "utf8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    env[key] = val;
  }
  return env;
}

// ─── Gemini API call ──────────────────────────────────────────────────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message: string; code: number };
}

export async function callGemini(prompt: string, model?: string): Promise<string> {
  const env = { ...loadEnv(), ...process.env };
  const apiKey = env["GEMINI_API_KEY"];
  const resolvedModel = model ?? env["GEMINI_MODEL"] ?? "gemini-3.5-flash";

  if (!apiKey || apiKey === "REPLACE_WITH_NEW_KEY_FROM_AI_STUDIO") {
    throw new Error("GEMINI_API_KEY not set in .env");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:generateContent`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

  // Exponential backoff on 429 — do not hammer the quota bucket
  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 2000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
      body,
      signal: AbortSignal.timeout(120_000),
    });

    if (res.status === 429) {
      if (attempt === MAX_RETRIES - 1) {
        throw new Error(
          "Gemini rate limit hit (429). Check AI Studio for active quota: " +
          "https://ai.google.dev/gemini-api/docs/models — falling back to next agent."
        );
      }
      const waitMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
      await Bun.sleep(waitMs);
      continue;
    }

    const data = await res.json() as GeminiResponse;
    if (data.error) throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");
    return text;
  }

  throw new Error("Gemini: max retries exceeded");
}

// ─── Streaming Gemini call ────────────────────────────────────────────────────
// Uses the SSE streamGenerateContent endpoint. Calls onChunk with each text
// fragment as it arrives so callers can update UI incrementally.

export async function callGeminiStream(
  prompt: string,
  onChunk: (text: string) => void,
  model?: string,
): Promise<void> {
  const env = { ...loadEnv(), ...process.env };
  const apiKey = env["GEMINI_API_KEY"];
  const resolvedModel = model ?? env["GEMINI_MODEL"] ?? "gemini-3.5-flash";

  if (!apiKey || apiKey === "REPLACE_WITH_NEW_KEY_FROM_AI_STUDIO") {
    throw new Error("GEMINI_API_KEY not set in .env");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${resolvedModel}:streamGenerateContent?alt=sse`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
    body,
    signal: AbortSignal.timeout(120_000),
  });

  if (res.status === 429) throw new Error("Gemini rate limit (429) — try again shortly.");
  if (!res.ok) throw new Error(`Gemini stream error: HTTP ${res.status}`);
  if (!res.body) throw new Error("Gemini returned no response body");

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buf     = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";          // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const chunk = JSON.parse(json) as GeminiResponse;
        const text  = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) onChunk(text);
      } catch { /* malformed SSE chunk — skip */ }
    }
  }
}

// ─── CLI mode ─────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const input = await new Response(Bun.stdin.stream()).text();
  let prompt: string;

  try {
    const parsed = JSON.parse(input.trim()) as { prompt?: string; skill?: string };
    prompt = parsed.prompt ?? input.trim();
  } catch {
    prompt = input.trim();
  }

  if (!prompt) {
    console.error("Usage: echo '<prompt>' | bun run adapters/gemini-direct.ts");
    process.exit(1);
  }

  try {
    const result = await callGemini(prompt);
    console.log(result);
  } catch (e) {
    console.error(`Error: ${e}`);
    process.exit(1);
  }
}
