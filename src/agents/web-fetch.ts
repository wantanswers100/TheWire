// Web fetch agent — HTTP GET a URL, strip HTML, answer questions via Ollama
//
// No external parsing deps — regex-based HTML stripping only.
// Ollama is primary (free, local). Falls back to Gemini if unavailable.

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const OLLAMA = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
const FETCH_MODEL = "qwen3:4b";
const TIMEOUT_MS = 15_000;
const MAX_CONTEXT_CHARS = 6_000;

// ─── HTML stripping ───────────────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── HTTP fetch ───────────────────────────────────────────────────────────────

export async function fetchPageText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Wire/1.0; +local)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text")) {
    throw new Error(`Unsupported content-type: ${contentType}`);
  }
  const html = await res.text();
  return stripHtml(html);
}

// ─── Ollama Q&A ───────────────────────────────────────────────────────────────

async function askOllama(context: string, question: string): Promise<string> {
  const prompt = `You are answering a question based on the content of a web page.

Page content:
${context.slice(0, MAX_CONTEXT_CHARS)}

Question: ${question}

Answer directly and concisely. If the page content doesn't contain the answer, say so clearly.`;

  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: FETCH_MODEL,
      prompt,
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 512 },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
  const data = await res.json() as { response: string };
  return data.response?.trim() ?? "";
}

// ─── Gemini fallback ──────────────────────────────────────────────────────────

function loadEnv(projectRoot: string): Record<string, string> {
  const envPath = join(projectRoot, ".env");
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

async function askGemini(context: string, question: string, projectRoot: string): Promise<string> {
  const env = { ...loadEnv(projectRoot), ...process.env };
  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY not set — Ollama unavailable and no Gemini key");

  const model = env["GEMINI_MODEL"] ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const prompt = `Based on this web page content, answer the question.\n\nContent:\n${context.slice(0, MAX_CONTEXT_CHARS)}\n\nQuestion: ${question}\n\nAnswer directly:`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-goog-api-key": apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
  const data = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ─── Ollama availability check ────────────────────────────────────────────────

async function isOllamaUp(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function webFetch(
  url: string,
  question: string,
  projectRoot: string,
): Promise<void> {
  console.log(`Fetching: ${url}`);
  const text = await fetchPageText(url);
  const wordCount = text.split(/\s+/).length;
  console.log(`  ${wordCount} words extracted`);

  const ollamaUp = await isOllamaUp();

  if (ollamaUp) {
    const answer = await askOllama(text, question);
    console.log(`\n${answer}`);
  } else {
    console.warn("[wire] Ollama unavailable — falling back to Gemini");
    const answer = await askGemini(text, question, projectRoot);
    console.log(`\n${answer}`);
  }
}
