// Regression coverage for the 2026-09-30 empty-`response` incident.
//
// The installed Ollama (0.18.2) does not honor the `/no_think` prompt suffix:
// qwen3 models can put their whole output in `thinking` and return
// `response: ""` (latent — models and Ollama unchanged since July). That made
// the qwen3:4b classifier throw "JSON Parse error: Unexpected EOF" on every
// attempt, dropped NL dispatch to the qwen3:1.7b tier (which then silently
// sent "weather in 75001" to Claude at 0.95 confidence), and turned the
// PhaseGate judge into a silent always-pass. Mocks global fetch — the only
// external dependency of each path — and asserts on request bodies and on
// what an empty `response` is allowed to produce.

import { describe, test, expect, afterEach } from "bun:test";
import { runOllama } from "../src/dispatch/workers.js";
import { classifyExtended } from "../src/router/classifier.js";
import { PhaseGate } from "../src/dispatch/PhaseGate.js";
import { WEATHER_INTENT } from "../src/cli/nl-cmd.js";
import type { EvalStore } from "../src/dispatch/EvalStore.js";

// runOllama/classifyExtended queue on the process-wide Ollama lock (ollamaGate.ts).
// In a full-suite run another test file's unmocked, fire-and-forget Ollama call can
// hold that lock for several seconds (seen 1 in 4 runs, 2026-09-30), so these get an
// explicit bound instead of bun's 5s default. Follow-up: find and mock that caller.
const LOCK_BOUND_MS = 30_000;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Body = Record<string, unknown>;

/** Mock fetch: each call gets the next queued Ollama `response` string. */
function mockOllama(responses: string[]): Body[] {
  const bodies: Body[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string));
    const response = responses[Math.min(bodies.length - 1, responses.length - 1)];
    return new Response(JSON.stringify({ response, eval_count: 1, prompt_eval_count: 1 }), { status: 200 });
  }) as typeof fetch;
  return bodies;
}

describe("think:false is sent on Ollama requests", () => {
  test("runOllama sends think:false for qwen3 and non-thinking models alike", async () => {
    const bodies = mockOllama(["answer"]);
    const payload = { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" };
    await runOllama("quick", payload);
    await runOllama("code_review", payload);
    // Every captured request, not an exact count: in a full-suite run, stray
    // async Ollama work from earlier test files can also land in this mock.
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies.every(b => b["think"] === false)).toBe(true);
    expect(bodies.map(b => b["model"])).toEqual(expect.arrayContaining(["qwen3:1.7b", "qwen2.5-coder:14b"]));
  }, LOCK_BOUND_MS);
});

describe("classifyExtended — empty qwen3:4b response", () => {
  test("every classifier request disables thinking", async () => {
    const bodies = mockOllama([`{"skill":"quick","verb":"query","domains":["general"],"confidence":0.9}`]);
    await classifyExtended("think-off request body check 1");
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every(b => b["think"] === false)).toBe(true);
  }, LOCK_BOUND_MS);

  test("1.7b fallback tier can never reach the 0.85 silent-dispatch gate", async () => {
    // Two empty 4b responses (the incident), then the 1.7b tier's real answer.
    mockOllama(["", "", `{"skill":"audit","verb":"classify","confidence":0.95}`]);
    const result = await classifyExtended("weather in 75001 regression case");
    expect(result?.skill).toBe("audit");
    expect(result!.confidence).toBeLessThan(0.85);
  }, LOCK_BOUND_MS);
});

describe("PhaseGate judge — empty or malformed response is skip, not pass", () => {
  function store(): { store: EvalStore; verdicts: string[] } {
    const verdicts: string[] = [];
    const s = { record: (_t: string, step: string, _score: number, meta?: { verdict?: string }) => {
      if (step === "judge") verdicts.push(meta?.verdict ?? "?");
    } } as unknown as EvalStore;
    return { store: s, verdicts };
  }
  const worker = async () => ({ text: "The capital of France is Paris.", tokensUsed: 1, model: "m" });

  test("empty response records skip", async () => {
    const bodies = mockOllama([""]);
    const { store: s, verdicts } = store();
    const r = await new PhaseGate().runWithGuardrails("t-empty", "quick", "capital of France", worker, s);
    expect(r.verdict).toBe("pass");
    expect(verdicts).toEqual(["skip"]);
    expect(bodies[0]!["think"]).toBe(false);
    expect(bodies[0]!["format"]).toBeDefined();
  });

  test("JSON verdict is honored", async () => {
    mockOllama([`{"verdict":"pass","reason":"correct"}`]);
    const { store: s, verdicts } = store();
    const r = await new PhaseGate().runWithGuardrails("t-json", "quick", "capital of France", worker, s);
    expect(r.verdict).toBe("pass");
    expect(verdicts).toEqual(["pass"]);
  });

  test("JSON fail verdict fails", async () => {
    mockOllama([`{"verdict":"fail","reason":"off topic"}`]);
    const { store: s, verdicts } = store();
    await new PhaseGate().runWithGuardrails("t-fail", "quick", "capital of France", worker, s);
    expect(verdicts[0]).toBe("fail");
  });

  test("legacy two-line format still parses", async () => {
    mockOllama(["verdict: pass\nreason: fine"]);
    const { store: s, verdicts } = store();
    await new PhaseGate().runWithGuardrails("t-lines", "quick", "capital of France", worker, s);
    expect(verdicts).toEqual(["pass"]);
  });
});

describe("WEATHER_INTENT — deterministic weather intercept", () => {
  const loc = (s: string) => {
    const m = WEATHER_INTENT.exec(s);
    return m ? (m[1] ?? m[2] ?? "") : null;
  };

  test.each([
    ["weather in 75001", "75001"],
    ["weather", ""],
    ["what's the weather in Dallas?", "Dallas"],
    ["forecast for London", "London"],
    ["show me the weather near Austin, TX", "Austin, TX"],
    ["check weather 75001", "75001"],
  ])("matches %p", (input, expected) => {
    expect(loc(input)).toBe(expected);
  });

  test.each([
    "research weather patterns in climate models",
    "weather impact on crop yields analysis",
    "explain why weather forecasts fail",
    "weather in the context of our last sprint planning review",
  ])("does not hijack %p", (input) => {
    expect(loc(input)).toBeNull();
  });
});
