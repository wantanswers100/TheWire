#!/usr/bin/env bun
// eval-routing.ts — dispatch routing accuracy evaluator
//
// Evaluator-optimizer pattern: runs 20 test cases through the classifier,
// grades each with qwen3:1.7b (cheap evaluator), reports accuracy metrics.
//
// Usage:
//   bun run scripts/eval-routing.ts
//   bun run scripts/eval-routing.ts --verbose
//   bun run scripts/eval-routing.ts --model qwen3:4b  (compare a different classifier)

import { join } from "node:path";
import { classifyExtended, keywordClassify } from "../src/router/classifier.js";

const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://localhost:11434";
const GRADER_MODEL = "qwen3:1.7b";
const PROJECT_ROOT = join(import.meta.dir, "..");

// ─── Test set ─────────────────────────────────────────────────────────────────

interface TestCase {
  input: string;
  expectedSkill: string;
  expectedAgent?: string;  // optional — skill accuracy is primary metric
}

const TEST_CASES: TestCase[] = [
  { input: "summarize the README",                              expectedSkill: "summarize",   expectedAgent: "ollama" },
  { input: "debug the TypeError in router.ts",                  expectedSkill: "debug",       expectedAgent: "claude" },
  { input: "research UK housing policy trends",                 expectedSkill: "research",    expectedAgent: "gemini" },
  { input: "show me my disk usage",                             expectedSkill: "system",      expectedAgent: "system" },
  { input: "explain the dispatch loop",                         expectedSkill: "explain",     expectedAgent: "ollama" },
  { input: "refactor memory.ts to use a class",                 expectedSkill: "refactor",    expectedAgent: "claude" },
  { input: "write a test for FtsIndex",                         expectedSkill: "implement",   expectedAgent: "claude" },
  { input: "review the security of shell-worker.ts",            expectedSkill: "code_review", expectedAgent: "ollama" },
  { input: "what is eating my CPU?",                            expectedSkill: "system",      expectedAgent: "system" },
  { input: "scaffold a new CLI command for wire",               expectedSkill: "scaffold",    expectedAgent: "codex"  },
  { input: "audit the cron scheduler for race conditions",      expectedSkill: "audit",       expectedAgent: "claude" },
  { input: "verify the build passes",                           expectedSkill: "verify",      expectedAgent: "claude" },
  { input: "list open ports",                                   expectedSkill: "system",      expectedAgent: "system" },
  { input: "quick answer: what is BM25?",                       expectedSkill: "quick",       expectedAgent: "ollama" },
  { input: "wire message handoff to gemini",                    expectedSkill: "wire",        expectedAgent: "claude" },
  { input: "document the WireRouter class",                     expectedSkill: "implement",   expectedAgent: "claude" },
  { input: "what processes are listening on 31338?",            expectedSkill: "system",      expectedAgent: "system" },
  { input: "find the bug in dispatch loop.ts",                  expectedSkill: "debug",       expectedAgent: "claude" },
  { input: "give me a concise summary of ARCHITECTURE.md",      expectedSkill: "summarize",   expectedAgent: "ollama" },
  { input: "kill the process on port 8080",                     expectedSkill: "system",      expectedAgent: "system" },
];

// ─── LLM grader ───────────────────────────────────────────────────────────────
// Uses qwen3:1.7b — cheaper model grades classifier output (evaluator-optimizer)

async function grade(input: string, expected: string, classified: string): Promise<boolean> {
  const prompt =
    `You are grading a skill classifier. Given a task input, decide if the classification is correct.\n\n` +
    `Task: "${input}"\n` +
    `Expected skill: ${expected}\n` +
    `Classified skill: ${classified}\n\n` +
    `Reply with exactly one word: CORRECT or INCORRECT. No explanation. /no_think`;

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: GRADER_MODEL, prompt, stream: false, options: { num_predict: 8 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return classified === expected;  // fallback: exact match
    const data = await res.json() as { response?: string };
    return (data.response ?? "").trim().toUpperCase().startsWith("CORRECT");
  } catch {
    return classified === expected;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const verbose = process.argv.includes("--verbose");

console.log(`\n\x1b[1mWire Routing Eval Harness\x1b[0m`);
console.log(`\x1b[2mClassifier: qwen3:4b  |  Grader: ${GRADER_MODEL}  |  Cases: ${TEST_CASES.length}\x1b[0m\n`);

interface Result {
  input: string;
  expected: string;
  classified: string;
  confidence: number;
  graded: boolean;
  source: "qwen3" | "keyword";
  latencyMs: number;
}

const results: Result[] = [];

for (const tc of TEST_CASES) {
  const start = Date.now();

  let classified: string;
  let confidence: number;
  let source: "qwen3" | "keyword";

  try {
    const r = await classifyExtended(tc.input);
    classified = r?.skill ?? "unknown";
    confidence = r?.confidence ?? 0;
    source = "qwen3";
  } catch {
    const r = keywordClassify(tc.input);
    classified = r.skill;
    confidence = r.confidence;
    source = "keyword";
  }

  const latencyMs = Date.now() - start;
  const graded = await grade(tc.input, tc.expectedSkill, classified);

  results.push({
    input: tc.input,
    expected: tc.expectedSkill,
    classified,
    confidence,
    graded,
    source,
    latencyMs,
  });

  const icon = graded ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const confStr = `${Math.round(confidence * 100)}%`.padStart(4);
  const src = source === "qwen3" ? "" : " \x1b[33m[kw]\x1b[0m";
  if (verbose || !graded) {
    console.log(`  ${icon} ${icon === "\x1b[32m✓\x1b[0m" ? "" : "\x1b[2m"}${tc.input.slice(0, 50).padEnd(50)}\x1b[0m  ` +
      `\x1b[36m${classified.padEnd(12)}\x1b[0m  conf:${confStr}  ${latencyMs}ms${src}`);
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const correct = results.filter(r => r.graded).length;
const total = results.length;
const accuracy = correct / total;
const avgLatency = Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / total);
const highConfCorrect = results.filter(r => r.confidence >= 0.85 && r.graded).length;
const highConfTotal = results.filter(r => r.confidence >= 0.85).length;
const keywordCount = results.filter(r => r.source === "keyword").length;

const bar = (n: number, t: number, width = 20) => {
  const filled = Math.round((n / t) * width);
  return "\x1b[32m" + "█".repeat(filled) + "\x1b[2m" + "░".repeat(width - filled) + "\x1b[0m";
};

console.log(`\n\x1b[1m─── Results ────────────────────────────────────────────\x1b[0m`);
console.log(`  Skill accuracy  ${bar(correct, total)}  \x1b[1m${correct}/${total}\x1b[0m  (${Math.round(accuracy * 100)}%)`);
if (highConfTotal > 0) {
  console.log(`  High-conf (≥85%) ${bar(highConfCorrect, highConfTotal)}  ${highConfCorrect}/${highConfTotal}  (${Math.round(highConfCorrect/highConfTotal*100)}%)`);
}
console.log(`  Avg latency     ${avgLatency}ms`);
console.log(`  Keyword fallbacks: ${keywordCount}/${total}`);

if (accuracy >= 0.85) {
  console.log(`\n\x1b[32m✓ Accuracy ≥85% — classifier meets the bar\x1b[0m`);
} else if (accuracy >= 0.80) {
  console.log(`\n\x1b[33m⚠ Accuracy 80-84% — consider phi4-mini or Haiku upgrade (see DEC-011)\x1b[0m`);
} else {
  console.log(`\n\x1b[31m✗ Accuracy <80% — classifier upgrade required (see DEC-011)\x1b[0m`);
}

// Failed cases always printed
const failed = results.filter(r => !r.graded);
if (failed.length > 0 && !verbose) {
  console.log(`\n\x1b[2mFailed cases:\x1b[0m`);
  for (const r of failed) {
    console.log(`  \x1b[31m✗\x1b[0m "${r.input.slice(0, 50)}"  expected:\x1b[36m${r.expected}\x1b[0m  got:\x1b[33m${r.classified}\x1b[0m`);
  }
}

console.log("");
process.exit(accuracy >= 0.80 ? 0 : 1);
