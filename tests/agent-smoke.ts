// Agent smoke test — calls each worker directly, reports pass/fail + latency.
// Run: bun run tests/agent-smoke.ts
// Skips codex (requires codex CLI installed separately).

import { runOllama, runGemini, runLlama4, runSystem } from "../src/dispatch/workers.js";

const PAYLOAD = {
  verb: "query",
  domain: ["general"],
  subject: "Reply with exactly: AGENT_OK",
  output: { format: "prose", maxTokens: 20 },
};

type Result = { agent: string; model: string; ok: boolean; ms: number; snippet: string; error?: string };

async function test(label: string, fn: () => Promise<{ text: string; model?: string }>): Promise<Result> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    const snippet = r.text.replace(/\s+/g, " ").trim().slice(0, 60);
    return { agent: label, model: r.model ?? "?", ok: true, ms, snippet };
  } catch (e) {
    return { agent: label, model: "—", ok: false, ms: Date.now() - t0, snippet: "", error: String(e).slice(0, 120) };
  }
}

// Run sequentially — Ollama loads one model at a time, avoids 12GB RAM pressure
const results: Result[] = [];
for (const [label, fn] of [
  ["ollama (qwen3:1.7b)",        () => runOllama("quick",      PAYLOAD)],
  ["ollama (qwen3:4b)",          () => runOllama("explain",    PAYLOAD)],
  ["ollama (qwen2.5-coder:14b)", () => runOllama("code_review",PAYLOAD)],
  ["gemini (2.0-flash)",         () => runGemini("research",   PAYLOAD)],
  ["groq (llama-3.1-8b-instant)",() => runLlama4("explain",   PAYLOAD)],
  ["groq (llama-3.3-70b)",       () => runLlama4("plan",       PAYLOAD)],
  ["system",                     () => runSystem({ verb:"execute", domain:["shell"], subject:"echo AGENT_OK" })],
] as [string, () => Promise<{ text: string; model?: string }>][]) {
  results.push(await test(label, fn));
}

console.log("\n── Agent Smoke Test ─────────────────────────────────────────────");
for (const r of results) {
  const status = r.ok ? "✓ PASS" : "✗ FAIL";
  const ms = `${r.ms}ms`.padStart(7);
  console.log(`${status}  ${ms}  ${r.agent}`);
  if (r.ok)    console.log(`         model: ${r.model}`);
  if (r.ok)    console.log(`         reply: ${r.snippet}`);
  if (!r.ok)   console.log(`         error: ${r.error}`);
}

const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} agents OK`);
console.log("─────────────────────────────────────────────────────────────────\n");
process.exit(passed === results.length ? 0 : 1);
