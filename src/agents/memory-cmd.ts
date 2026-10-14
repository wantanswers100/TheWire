#!/usr/bin/env bun
// wire memory <set|get|search|recent> [options]
//
// Examples:
//   wire memory set --key "project:agent-wire" --value "Phase 18 complete" --category project_state
//   wire memory get --key "project:agent-wire"
//   wire memory search "dispatch loop" --topk 5
//   wire memory recent --category task_log

import { MemoryStore } from "./memory.js";
import type { MemoryCategory } from "./memory.js";
// ISS-031: sourced from config/paths.ts.
import { STATE_DIR } from "../config/paths.js";

const VALID_CATEGORIES = new Set<MemoryCategory>([
  "conversation", "task_log", "project_state", "preference", "observation"
]);

const [, , subcmd, ...args] = process.argv;
const store = new MemoryStore(STATE_DIR);

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      out[a.slice(2)] = argv[++i]!;
    } else if (!a.startsWith("--")) {
      out["_"] = (out["_"] ? out["_"] + " " : "") + a;
    }
  }
  return out;
}

function validCategory(s: string | undefined): MemoryCategory | undefined {
  return s && VALID_CATEGORIES.has(s as MemoryCategory) ? (s as MemoryCategory) : undefined;
}

if (subcmd === "set") {
  const flags = parseArgs(args);
  const key = flags["key"];
  const value = flags["value"];
  if (!key || !value) { console.error("Usage: wire memory set --key <key> --value <value> [--category <cat>] [--tags <t1,t2>]"); process.exit(1); }
  const id = await store.set({
    key, value,
    category: validCategory(flags["category"]) ?? "observation",
    tags: flags["tags"] ? flags["tags"].split(",").map(t => t.trim()) : [],
  });
  console.log(`Stored id=${id} key="${key}"`);

} else if (subcmd === "get") {
  const flags = parseArgs(args);
  const key = flags["key"] ?? flags["_"];
  if (!key) { console.error("Usage: wire memory get --key <key>"); process.exit(1); }
  const entry = store.get(key, validCategory(flags["category"]));
  if (!entry) { console.log(`Not found: ${key}`); process.exit(0); }
  console.log(`[${entry.category}] ${entry.key}`);
  console.log(entry.value);
  console.log(`(updated ${new Date(entry.updated_at).toISOString()})`);

} else if (subcmd === "search") {
  const flags = parseArgs(args);
  const query = flags["query"] ?? flags["_"];
  if (!query) { console.error("Usage: wire memory search <query> [--topk 5] [--category <cat>]"); process.exit(1); }
  const topK = parseInt(flags["topk"] ?? "5", 10);
  const results = await store.search({ query, topK, category: validCategory(flags["category"]) });
  if (results.length === 0) { console.log("No results."); process.exit(0); }
  for (const r of results) {
    const score = (r.score * 100).toFixed(0);
    console.log(`[${r.category}] ${r.key} (${score}% match)`);
    console.log(`  ${r.value.slice(0, 120)}${r.value.length > 120 ? "..." : ""}`);
  }

} else if (subcmd === "recent") {
  const flags = parseArgs(args);
  const limit = parseInt(flags["limit"] ?? "10", 10);
  const results = store.recent(validCategory(flags["category"]), limit);
  if (results.length === 0) { console.log("No memory entries yet."); process.exit(0); }
  for (const r of results) {
    console.log(`[${r.category}] ${r.key}`);
    console.log(`  ${r.value.slice(0, 100)}${r.value.length > 100 ? "..." : ""}`);
  }

} else {
  console.log(`Usage: wire memory <set|get|search|recent> [options]

Commands:
  set     --key <k> --value <v> [--category <cat>] [--tags <t1,t2>]
  get     --key <k> [--category <cat>]
  search  <query> [--topk 5] [--category <cat>]
  recent  [--category <cat>] [--limit 10]

Categories: conversation | task_log | project_state | preference | observation`);
  process.exit(1);
}
