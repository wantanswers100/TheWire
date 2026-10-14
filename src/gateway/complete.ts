// POST /complete — a single, generic LLM-completion endpoint for OTHER PROJECTS
// (not just Wire's own CLI), added 2026-09-17 per the owner's explicit direction:
// "no alternatives should be present, only the wire" — projects should hold no
// provider API keys of their own and make no direct provider calls; Wire owns
// the credentials and decides Gemini vs. Ollama.
//
// Deliberately NOT built on top of runGemini()/runOllama() in dispatch/workers.ts:
// those are shaped around Wire's own TaskSpec (verb/domain/subject/constraints),
// which has no slot for a raw system_prompt/user_prompt pair or a JSON response
// schema — both of which the trading client's structured-output call sites
// (TradeProposal, ConsensusReport, etc.) require. Forcing that shape would be a
// lossy translation for zero benefit. This is a separate, minimal, purpose-built
// function that calls the same underlying provider APIs directly, the same way
// runGemini/runOllama do (fetch with a timeout — no CLI spawn, unlike runClaude/
// runCodex; see ISS-064 for that distinction).
//
// Auth: a single shared-secret header (X-API-Key), not Wire's per-agent Ed25519
// token system — this endpoint isn't a WireProtocol message, it's a direct
// completion proxy for external callers, so it uses the same simple pattern
// the trading client's own server.py already uses for its API, rather than
// forcing this into Wire's typed AgentId system for no real benefit.

import { withOllamaLock } from "../router/ollamaGate.js";
import { OLLAMA_URL, GROQ_API_BASE } from "../config/models.js";
import { loadEnv } from "../dispatch/workers.js";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config/paths.js";

export interface GatewayContext {
  keysDir: string;
  stateDir: string;
  inboxDir: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth: any;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

const OLLAMA_TIMEOUT_MS = 45_000;
const GEMINI_TIMEOUT_MS = 20_000;
const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
const DEFAULT_OLLAMA_MODEL = "qwen3:4b";
// 2026-09-17: gemini-2.5-flash/-pro were deprecated by Google ("no longer
// available to new users") — verified via direct API calls: 2.5-flash/2.5-pro
// return 404 NOT_FOUND naming these exact replacements; 3.6-flash returns 200,
// 3.1-pro-preview returns 429 (quota, not 404 — confirms it's a real model,
// same key). Not an API key problem; the key was never broken.
// 2026-09-22: research/long_context were on gemini-3.1-pro-preview, which is
// now returning 429 quota-exhausted (verified via direct curl, not assumed)
// -- confirmed a real, current outage while investigating why
// the trading client's decision cycles were failing with "All providers
// failed." Switched to gemini-3.6-flash (confirmed live, 200, via `wire
// status`) matching primary/critic/coding, until 3.1-pro-preview's quota
// resets or a paid tier is set up. Quality tradeoff for research/long_context
// tasks specifically is accepted as the cost of restoring basic function.
export const GEMINI_MODEL_BY_ROLE: Record<string, string> = {
  primary: "gemini-3.6-flash",
  critic: "gemini-3.6-flash",
  research: "gemini-3.6-flash",
  long_context: "gemini-3.6-flash",
  coding: "gemini-3.6-flash",
};
const OLLAMA_MODEL_BY_ROLE: Record<string, string> = {
  primary: "qwen3:4b",
  critic: "deepseek-r1:8b",
  research: "qwen3:4b",
  long_context: "qwen2.5-coder:14b",
  coding: "qwen2.5-coder:14b",
};
const GROQ_TIMEOUT_MS = 15_000;
// 2026-09-17: switched from openai/gpt-oss-20b to groq/compound-mini after
// live-tracing a recurring CPU/pipeline-lag issue back to its root cause.
// Verified via real x-ratelimit-* response headers: gpt-oss-20b has an
// 8,000-token budget resetting every ~26-30s and burns tokens on every call
// regardless of prompt size (always emits reasoning, even for a trivial
// prompt). the trading client's real decision-cycle cadence is ~15s per
// symbol across a wide watchlist (confirmed from live cycle_events
// timestamps) -- roughly 2x faster than that budget refills, a structural
// mismatch, not an occasional collision. Result: calls routinely exhausted
// Groq's budget and fell through to local Ollama, which is both the CPU/fan
// source AND -- the actual priority raised -- a pipeline-latency problem,
// since Ollama on CPU is far slower than a cloud completion.
// groq/compound-mini has a 70,000-token budget resetting in <1s (verified
// live) and confirmed compatible with the JSON-mode structured-output path
// below. Caveat, stated plainly: it is a composite/agentic system internally
// (routes through llama-3.3-70b-versatile + openai/gpt-oss-120b per its own
// usage_breakdown), not a single plain model -- accepted tradeoff since it
// directly fixes the verified root cause and keeps completions on fast
// cloud infra instead of falling back to slow local hardware.
// 2026-09-22: groq/compound-mini now returns 404 "does not exist or you do
// not have access to it" -- verified via direct curl to /v1/models on this
// account (it's no longer in the list at all; likely was a preview/beta
// model this account's access to has ended). This is a real, current outage,
// found while investigating the trading client's "All providers failed"
// decision-cycle crashes -- not a theoretical concern.
//
// IMPORTANT CAVEAT, not glossed over: swapping to any other currently-
// available model does NOT by itself fix the original 2026-09-17 problem
// this file documents above (compound-mini was chosen specifically for its
// 70k-token/<1s-reset budget). Checked every text-capable model this
// account's key can currently see (openai/gpt-oss-120b, openai/gpt-oss-20b,
// qwen/qwen3.8-27b, allam-2-7b): all report the same
// x-ratelimit-limit-tokens: 8000 header, which appears to be an
// ACCOUNT-TIER limit, not a model-specific one -- meaning the 8k/window
// mismatch against the trading client's ~15s decision cadence that caused
// the original CPU/fallback problem may recur with any of them. A single
// snapshot of x-ratelimit-reset-tokens (observed sub-second on two models
// tested) is time-until-reset-from-current-usage, not a measured window
// length -- NOT the same rigor as the original fix's live multi-call
// characterization, and not claimed to be. Chose openai/gpt-oss-120b (larger
// than the originally-problematic 20b variant) as the least-bad currently-
// available option to restore basic function; the real fix (relying on
// Groq less, or a paid tier) is a separate, not-yet-decided follow-up.
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
export const GROQ_MODEL_BY_ROLE: Record<string, string> = {
  primary: "openai/gpt-oss-120b",
  critic: "openai/gpt-oss-120b",
  research: "openai/gpt-oss-120b",
  long_context: "openai/gpt-oss-120b",
  coding: "openai/gpt-oss-120b",
};

type Provider = "gemini" | "ollama" | "groq";
const ALL_PROVIDERS: Provider[] = ["gemini", "ollama", "groq"];

// Added 2026-09-17 per the owner's explicit direction: this box is CPU-only, no GPU,
// 8 cores — local Ollama inference genuinely competes with everything else
// running on it, confirmed repeatedly this session (the trading client's own
// ISS-018/019 CPU-runaway investigations). Cloud providers (Gemini, Groq) don't
// touch this machine's CPU at all and can run in real parallel with local work.
// Default order deliberately puts Ollama LAST — a config choice, not a code
// change, so it's trivial to flip back (e.g. WIRE_COMPLETE_PROVIDER_ORDER=
// ollama,gemini,groq) if the hardware situation changes (more cores, a GPU) or
// if a caller specifically wants local-only for cost/privacy reasons via the
// existing explicit `provider` override.
function defaultProviderOrder(): Provider[] {
  const raw = process.env["WIRE_COMPLETE_PROVIDER_ORDER"];
  if (!raw) return ["groq", "gemini", "ollama"];
  const parsed = raw.split(",").map(s => s.trim()).filter((s): s is Provider => ALL_PROVIDERS.includes(s as Provider));
  return parsed.length > 0 ? parsed : ["groq", "gemini", "ollama"];
}

interface CompleteRequestBody {
  system_prompt: string;
  user_prompt: string;
  role?: string;           // one of GEMINI_MODEL_BY_ROLE's keys — selects the model
  provider?: Provider;     // explicit override; default follows defaultProviderOrder()
  temperature?: number;
  response_schema?: Record<string, unknown>; // raw JSON schema, e.g. Pydantic's model_json_schema()
  deadline_ms?: number;    // caller's own timeout budget; also accepted as X-Deadline-Ms header
}

// ─── Per-request log ──────────────────────────────────────────────────────────
// One JSONL line per /complete request. Before this, nothing per-request was
// logged, so the trading client's 89-100% failure rate on 2026-09-22 (ISS-041)
// was invisible from Wire's side. Error text is redacted: Gemini's request
// URL carries the API key as a query parameter.

interface AttemptLog { provider: Provider; ms: number; ok: boolean; error?: string }

function redact(text: string): string {
  return text
    .replace(/([?&]key=)[^&\s"']+/gi, "$1REDACTED")
    .replace(/\b(AIza[0-9A-Za-z_-]{6,}|gsk_[0-9A-Za-z]+|sk-[0-9A-Za-z_-]{8,})/g, "REDACTED")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1REDACTED");
}

const LOG_ROTATE_BYTES = 10 * 1024 * 1024; // keep one rotated generation (.1) — bounded disk use
const MAX_DEADLINE_MS = 300_000;            // setTimeout overflows past ~2^31 ms (Bun turns it into ~1ms)

function logRequest(entry: Record<string, unknown>): void {
  const path = process.env["WIRE_COMPLETE_LOG_PATH"] ?? join(STATE_DIR, "complete-requests.jsonl");
  try {
    if (existsSync(path) && statSync(path).size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    console.warn(`[complete] request log write failed: ${(e as Error).message}`);
  }
  const attempts = (entry["attempts"] as AttemptLog[] | undefined) ?? [];
  console.log(`[complete] ${entry["status"]} caller=${entry["caller"]} ${entry["total_ms"]}ms ${attempts.map(a => `${a.provider}:${a.ok ? "ok" : "fail"}`).join(",")}`);
}

function parseDeadline(req: Request, body: CompleteRequestBody): number | undefined {
  const raw = body.deadline_ms ?? Number(req.headers.get("X-Deadline-Ms") ?? NaN);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_DEADLINE_MS) : undefined;
}

class DeadlineExceeded extends Error {}

async function callGroq(body: CompleteRequestBody): Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }> {
  const env = { ...loadEnv(), ...process.env };
  const apiKey = env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY not set in agent-wire's .env");

  const model = GROQ_MODEL_BY_ROLE[body.role ?? "primary"] ?? DEFAULT_GROQ_MODEL;
  const messages: Array<Record<string, string>> = [
    { role: "system", content: body.system_prompt },
    { role: "user", content: body.user_prompt },
  ];
  // Groq's OpenAI-compatible API doesn't accept a raw JSON-schema object the
  // way Gemini/Ollama do here — basic JSON mode plus an explicit schema
  // instruction in the prompt (same technique this project's own pre-Wire
  // ollama_chat() used) is the safe, broadly-supported choice rather than
  // assuming every Groq-hosted model supports strict schema-constrained output.
  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature: body.temperature ?? 0.3,
  };
  if (body.response_schema) {
    messages[0]!.content += `\n\nYou MUST respond with valid JSON matching this exact schema:\n${JSON.stringify(body.response_schema)}\nOutput JSON only. No markdown, no explanation.`;
    requestBody["response_format"] = { type: "json_object" };
  }

  const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GROQ_TIMEOUT_MS),
  });
  if (res.status === 429) throw new Error("Groq rate limit");
  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Groq returned an empty response");
  return { text, model, inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens };
}

async function callGemini(body: CompleteRequestBody): Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }> {
  const env = { ...loadEnv(), ...process.env };
  const apiKey = env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY not set in agent-wire's .env");

  const model = GEMINI_MODEL_BY_ROLE[body.role ?? "primary"] ?? DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const generationConfig: Record<string, unknown> = {
    temperature: body.temperature ?? 0.3,
  };
  if (body.response_schema) {
    generationConfig["responseMimeType"] = "application/json";
    generationConfig["responseSchema"] = body.response_schema;
  }
  if (/^gemini-[3-9]/.test(model)) {
    generationConfig["thinkingConfig"] = { thinkingBudget: 0 };
  }

  const requestBody = {
    contents: [{ parts: [{ text: body.user_prompt }] }],
    systemInstruction: { parts: [{ text: body.system_prompt }] },
    generationConfig,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status} ${await res.text().catch(() => "")}`);
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error("Gemini returned an empty response");
  return {
    text, model,
    inputTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount,
  };
}

async function callOllama(body: CompleteRequestBody): Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }> {
  const model = OLLAMA_MODEL_BY_ROLE[body.role ?? "primary"] ?? DEFAULT_OLLAMA_MODEL;
  const messages = [
    { role: "system", content: body.system_prompt },
    { role: "user", content: body.user_prompt },
  ];
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: false, think: false,
    options: { temperature: body.temperature ?? 0.3 },
  };
  if (body.response_schema) payload["format"] = body.response_schema;

  // Same lock Wire's own runOllama() uses — serializes with Wire's own Ollama
  // traffic too, not just calls made through this endpoint. This is the exact
  // mechanism the trading client built its own local semaphore for
  // (agents/ollama_client.py, 2026-09-16) before this endpoint existed; once
  // trading calls through here instead, that local semaphore becomes redundant
  // and should be removed rather than stacked on top of this one.
  const data = await withOllamaLock(async () => {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
    return res.json() as Promise<{
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    }>;
  });

  const text = data.message?.content ?? "";
  if (!text) throw new Error("Ollama returned an empty response");
  return { text, model, inputTokens: data.prompt_eval_count, outputTokens: data.eval_count };
}

export async function handleComplete(req: Request): Promise<Response> {
  const t0 = Date.now();
  const caller = (req.headers.get("X-Caller") ?? "unknown").replace(/[^\w.-]/g, "").slice(0, 40) || "unknown";
  const done = (res: Response, extra: Record<string, unknown> = {}): Response => {
    logRequest({ caller, status: res.status, total_ms: Date.now() - t0, ...extra });
    return res;
  };

  const expectedKey = process.env["WIRE_COMPLETE_API_KEY"];
  if (!expectedKey) {
    return done(err("Gateway misconfigured: WIRE_COMPLETE_API_KEY not set in agent-wire's .env", 500));
  }
  const providedKey = req.headers.get("X-API-Key");
  if (providedKey !== expectedKey) {
    return done(err("Unauthorized: invalid or missing X-API-Key", 401));
  }

  let body: CompleteRequestBody;
  try {
    body = await req.json() as CompleteRequestBody;
  } catch {
    return done(err("Request body must be valid JSON"));
  }
  if (!body.system_prompt || !body.user_prompt) {
    return done(err("Missing required fields: system_prompt, user_prompt"));
  }

  // Deliberately NOT routing "claude"/"codex" here — those are CLI-spawn-based
  // in this codebase today (300s timeout, measured ~40% historical failure rate
  // per ISS-064), unsuitable for a synchronous completion endpoint. Callers that
  // need those should use the existing async wire ask/wire task dispatch instead.
  const callers: Record<Provider, () => Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number }>> = {
    gemini: () => callGemini(body),
    ollama: () => callOllama(body),
    groq: () => callGroq(body),
  };

  if (body.provider && !ALL_PROVIDERS.includes(body.provider)) {
    return done(err(`Unknown provider: ${body.provider}`, 400));
  }
  const order: Provider[] = body.provider ? [body.provider] : defaultProviderOrder();

  // Caller deadline (ISS-041): the sequential chain can take ~80s worst case
  // while the trading client gives up at 50s. With a deadline, stop trying
  // further providers and answer 504 before the caller times out.
  const deadlineMs = parseDeadline(req, body);
  const meta = { role: String(body.role ?? "primary").slice(0, 40), deadline_ms: deadlineMs, order };

  const attempts: AttemptLog[] = [];
  const errors: string[] = [];
  let deadlineHit = false;
  for (const provider of order) {
    const remaining = deadlineMs === undefined ? Infinity : deadlineMs - (Date.now() - t0);
    if (remaining <= 0) { deadlineHit = true; break; }
    const a0 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const call = callers[provider]();
      // Note: on deadline the provider call is abandoned, not cancelled — it runs to
      // its own timeout in the background (follow-up: propagate an AbortSignal).
      const result = remaining === Infinity ? await call : await Promise.race([
        call,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeadlineExceeded(`deadline of ${deadlineMs}ms reached`)), remaining); }),
      ]);
      attempts.push({ provider, ms: Date.now() - a0, ok: true });
      return done(json({ ok: true, ...result, provider }), { ...meta, attempts, provider, model: result.model });
    } catch (e) {
      const msg = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
      attempts.push({ provider, ms: Date.now() - a0, ok: false, error: msg });
      errors.push(msg);
      if (e instanceof DeadlineExceeded) { deadlineHit = true; break; }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (deadlineHit) {
    return done(err(`Deadline of ${deadlineMs}ms reached before any provider succeeded: ${errors.join(" | ")}`, 504), { ...meta, attempts });
  }
  return done(err(`All providers failed: ${errors.join(" | ")}`, 502), { ...meta, attempts });
}
