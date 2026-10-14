#!/usr/bin/env bun
// wire route — ask the router what agent it would pick for a given task
//
// Usage:
//   bun run wire route --skill research --verb query --domain python,sqlite
//   bun run wire route --skill summarize
//   bun run wire route --skill implement --domain typescript --cost free-first

import { WireRouter } from "./index.js";
// ISS-031: sourced from config/paths.ts.
import { STATE_DIR } from "../config/paths.js";

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key?.startsWith("--") && val && !val.startsWith("--")) {
      out[key.slice(2)] = val;
      i++;
    }
  }
  return out;
}

export async function runRoute(args: string[], stateDir = STATE_DIR): Promise<void> {
  const opts = parseArgs(args);
  const skill = opts["skill"] ?? "research";
  const verb  = opts["verb"];
  const domains = opts["domain"] ? opts["domain"].split(",").map(s => s.trim()) : [];
  const cost = (opts["cost"] === "free-first") ? "free-first" as const : "quality-first" as const;

  const router = new WireRouter(stateDir);
  const decision = await router.route({ skill, verb, domains, type: "task", costPreference: cost });

  console.log("\nRouting decision:");
  console.log(`  skill    : ${skill}`);
  if (verb)           console.log(`  verb     : ${verb}`);
  if (domains.length) console.log(`  domains  : ${domains.join(", ")}`);
  console.log(`  cost pref: ${cost}`);
  console.log("");
  console.log(`  -> agent : ${decision.agent}${decision.ollamaModel ? ` (${decision.ollamaModel})` : ""}`);
  console.log(`  -> rule  : ${decision.rule}`);
  console.log(`  -> cost  : ${decision.costTier}`);
  if (decision.fallbacksAvailable.length) {
    console.log(`  -> fallbacks: ${decision.fallbacksAvailable.join(", ")}`);
  }

  const weights = router.weightSummary(skill, domains);
  if (Object.keys(weights).length > 0) {
    console.log("\n  Learned weight adjustments:");
    for (const [agent, w] of Object.entries(weights)) {
      const sign = w >= 0 ? "+" : "";
      console.log(`    ${agent}: ${sign}${w}`);
    }
  }
  console.log("");
}
