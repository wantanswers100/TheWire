#!/usr/bin/env bun
// wire classify — classify a free-text task description using qwen3:4b (Layer 2)
//
// Usage:
//   bun run wire classify "refactor the auth module to use TypeScript strict mode"
//   bun run wire classify "summarize yesterday's debug session" --cost free-first
//   echo "debug the failing test" | bun run wire classify

import { WireRouter } from "./index.js";
import { isClassifierAvailable } from "./classifier.js";
// ISS-031: sourced from config/paths.ts.
import { STATE_DIR } from "../config/paths.js";

export async function runClassify(args: string[], stateDir = STATE_DIR): Promise<void> {
  // Collect task text — join non-flag args, or read stdin
  const textArgs = args.filter(a => !a.startsWith("--"));
  const cost = args.includes("--cost") && args[args.indexOf("--cost") + 1] === "free-first"
    ? "free-first" as const
    : "quality-first" as const;

  let taskText = textArgs.join(" ").trim();

  if (!taskText && !process.stdin.isTTY) {
    taskText = await new Response(Bun.stdin.stream()).text();
    taskText = taskText.trim();
  }

  if (!taskText) {
    console.error('Usage: wire classify "<task description>" [--cost free-first]');
    process.exit(1);
  }

  // Check qwen3:4b is available
  const available = await isClassifierAvailable();
  if (!available) {
    console.error("qwen3:4b not available. Is Ollama running? Try: ollama serve");
    console.error("Then pull the model: ollama pull qwen3:4b");
    process.exit(1);
  }

  console.log(`\nClassifying: "${taskText.slice(0, 80)}${taskText.length > 80 ? "..." : ""}"`);
  console.log("Model: qwen3:4b (Layer 2 semantic classifier)");
  console.log("");

  const router = new WireRouter(stateDir);
  const decision = await router.classifyAndRoute(taskText, { costPreference: cost });

  if (decision.classifierResult) {
    const cr = decision.classifierResult;
    console.log("Classification:");
    console.log(`  skill      : ${cr.skill}`);
    console.log(`  verb       : ${cr.verb}`);
    if (cr.domains.length) console.log(`  domains    : ${cr.domains.join(", ")}`);
    console.log(`  confidence : ${Math.round(cr.confidence * 100)}%`);
  } else {
    console.log("Classification: [qwen3:4b parse failed — used Layer 1 fallback]");
  }

  console.log("");
  console.log("Routing decision:");
  console.log(`  -> agent   : ${decision.agent}${decision.ollamaModel ? ` (${decision.ollamaModel})` : ""}`);
  console.log(`  -> rule    : ${decision.rule}`);
  console.log(`  -> cost    : ${decision.costTier}`);
  if (decision.fallbacksAvailable.length) {
    console.log(`  -> fallbacks: ${decision.fallbacksAvailable.join(", ")}`);
  }
  console.log("");
}
