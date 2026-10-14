// Regression coverage for ISS-037/ISS-021 applied to the main dispatch path:
// qwen3/deepseek-r1 are thinking models with chain-of-thought enabled by
// default. runOllama() now appends /no_think for those models (matching the
// same fix already applied to SkillCompressor/ResultMerger/memory.ts after
// ISS-021) so a tight num_predict budget can't be entirely consumed by an
// invisible <think> block, and thinking tokens aren't wasted on the common
// case either.
//
// Asserts on the actual HTTP request body sent to Ollama — mocks global
// fetch rather than the Ollama server, since runOllama()'s only external
// dependency is the fetch call itself.

import { describe, test, expect, afterEach } from "bun:test";
import { runOllama } from "../src/dispatch/workers.js";

const realFetch = globalThis.fetch;
let capturedBody: Record<string, unknown> | null = null;

function mockFetchCapturing(response: string): void {
  capturedBody = null;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string);
    return new Response(JSON.stringify({ response, eval_count: 10, prompt_eval_count: 5 }), { status: 200 });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("runOllama() — /no_think guard for thinking models (ISS-037)", () => {
  test("qwen3 (quick skill) gets /no_think appended to the prompt", async () => {
    mockFetchCapturing("answer");
    await runOllama("quick", { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" });

    expect(capturedBody?.["model"]).toBe("qwen3:1.7b");
    expect(capturedBody?.["prompt"] as string).toContain("/no_think");
  });

  test("qwen2.5-coder (code_review skill) does NOT get /no_think appended — not a thinking model", async () => {
    mockFetchCapturing("answer");
    await runOllama("code_review", { format: "task", verb: "query", domain: ["general"], output: { format: "prose" }, subject: "x" });

    expect(capturedBody?.["model"]).toBe("qwen2.5-coder:14b");
    expect(capturedBody?.["prompt"] as string).not.toContain("/no_think");
  });

  test("num_predict still honors an explicit maxTokens override alongside the /no_think guard", async () => {
    mockFetchCapturing("answer");
    await runOllama("quick", { format: "task", verb: "query", domain: ["general"], output: { format: "prose", maxTokens: 16 }, subject: "x" });

    const options = capturedBody?.["options"] as Record<string, unknown>;
    expect(options["num_predict"]).toBe(16);
    expect(capturedBody?.["prompt"] as string).toContain("/no_think");
  });
});
