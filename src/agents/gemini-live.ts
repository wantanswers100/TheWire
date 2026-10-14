// Gemini live search — Google Search grounding for real-time queries
//
// Wraps the Gemini API with googleSearch tool enabled. Handles:
//   - Free tier quota exhaustion detection (vs transient rate limits)
//   - Paid consent prompt: yes-once / yes-all-day / no
//   - Day-approval state in .wire-state/paid-approved-YYYY-MM-DD

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GEMINI_DEFAULT_MODEL } from "../config/models.js";
import { promptLine } from "../cli/prompt.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export class QuotaExhaustedError extends Error {
  constructor() {
    super("QUOTA_EXHAUSTED");
    this.name = "QuotaExhaustedError";
  }
}

interface GeminiLiveResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      searchEntryPoint?: { renderedContent?: string };
    };
  }>;
  error?: { message: string; code: number; status?: string };
}

// ─── .env loader ─────────────────────────────────────────────────────────────

function loadEnv(projectRoot: string): Record<string, string> {
  const envPath = join(projectRoot, ".env");
  if (!existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

// ─── Day-approval state ───────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function isPaidApprovedToday(stateDir: string): boolean {
  return existsSync(join(stateDir, `paid-approved-${todayKey()}`));
}

export function approvePaidForDay(stateDir: string): void {
  writeFileSync(join(stateDir, `paid-approved-${todayKey()}`), todayKey(), {
    encoding: "utf8",
    mode: 0o644,
  });
}

// ─── Gemini live search call ──────────────────────────────────────────────────

const BACKOFF_BASE_MS = 2_000;
const MAX_RETRIES = 3;

export async function callGeminiLive(
  prompt: string,
  projectRoot: string,
): Promise<{ text: string; queries: string[] }> {
  const env = { ...loadEnv(projectRoot), ...process.env };
  const apiKey = env["GEMINI_API_KEY"];
  const model = env["GEMINI_MODEL"] ?? GEMINI_DEFAULT_MODEL;

  if (!apiKey || apiKey === "REPLACE_WITH_NEW_KEY_FROM_AI_STUDIO") {
    throw new Error("GEMINI_API_KEY not set in .env");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
      body,
      signal: AbortSignal.timeout(120_000),
    });

    if (res.status === 429) {
      if (attempt < MAX_RETRIES - 1) {
        // Short backoff — clears transient RPM rate limits
        await Bun.sleep(BACKOFF_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      // All retries exhausted — treat as quota exhaustion, not rate limit
      throw new QuotaExhaustedError();
    }

    const data = await res.json() as GeminiLiveResponse;

    if (data.error) {
      // RESOURCE_EXHAUSTED on first attempt = immediate quota signal
      if (data.error.status === "RESOURCE_EXHAUSTED") throw new QuotaExhaustedError();
      throw new Error(`Gemini API error ${data.error.code}: ${data.error.message}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned empty response");

    const queries = data.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? [];
    return { text, queries };
  }

  throw new Error("Gemini live: max retries exceeded");
}

// ─── Consent prompt ───────────────────────────────────────────────────────────

export async function promptPaidConsent(stateDir: string): Promise<"once" | "day" | "no"> {
  console.log("\nFree tier quota exhausted for live search.");
  console.log("Proceed to paid Gemini?");
  console.log("  [y]  Yes, this search only");
  console.log("  [a]  Yes, for all live searches today");
  console.log("  [n]  No — cancel");
  const answer = ((await promptLine("\nChoice [y/a/n]: ")) ?? "n").toLowerCase();

  if (answer === "a") {
    approvePaidForDay(stateDir);
    return "day";
  }
  if (answer === "y") return "once";
  return "no";
}

// ─── Main entry point (used by nl-cmd.ts) ────────────────────────────────────

export async function liveSearch(
  subject: string,
  stateDir: string,
  projectRoot: string,
): Promise<void> {
  const prompt = `Answer this question with current, real-time information using Google Search: ${subject}`;

  try {
    const { text, queries } = await callGeminiLive(prompt, projectRoot);
    if (queries.length) {
      console.log(`\nSearched: ${queries.join(" · ")}`);
    }
    console.log(`\n${text}`);
    return;
  } catch (e) {
    if (!(e instanceof QuotaExhaustedError)) throw e;
  }

  // Quota exhausted — check day approval or prompt
  if (isPaidApprovedToday(stateDir)) {
    console.log("[live] Day approval active — proceeding with paid search.");
  } else {
    const choice = await promptPaidConsent(stateDir);
    if (choice === "no") {
      console.log("Cancelled.");
      return;
    }
    // "once" or "day" — both proceed; "day" already saved approval file
  }

  // Retry after consent
  const { text, queries } = await callGeminiLive(prompt, projectRoot);
  if (queries.length) {
    console.log(`\nSearched: ${queries.join(" · ")}`);
  }
  console.log(`\n${text}`);
}
