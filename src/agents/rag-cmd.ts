#!/usr/bin/env bun
// wire ingest <file>           — ingest a file into the RAG store
// wire rag retrieve <query>    — semantic search over ingested docs
// wire rag list                — list all ingested files
// wire rag remove <file>       — remove a file's chunks

import { RagStore } from "./rag.js";
// ISS-031: sourced from config/paths.ts.
import { STATE_DIR } from "../config/paths.js";

const [, , subcmd, ...args] = process.argv;
const store = new RagStore(STATE_DIR);

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

// ─── ingest ───────────────────────────────────────────────────────────────────

if (subcmd === "ingest") {
  const filePath = args[0];
  if (!filePath) {
    console.error("Usage: wire ingest <file>");
    process.exit(1);
  }
  try {
    console.log(`Ingesting ${filePath}...`);
    const report = await store.ingest(filePath);
    console.log(`Done.`);
    console.log(`  Source:   ${report.sourceFile}`);
    console.log(`  Chunks:   ${report.chunks}`);
    console.log(`  Embedded: ${report.embedded}`);
    if (report.skipped > 0) console.log(`  Skipped (no embedding): ${report.skipped}`);
    if (report.replaced) console.log(`  Prior version replaced.`);
  } catch (e) {
    console.error(`Ingest failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

// ─── rag retrieve ─────────────────────────────────────────────────────────────

} else if (subcmd === "rag" && args[0] === "retrieve") {
  const flags = parseArgs(args.slice(1));
  const query = flags["query"] ?? flags["_"];
  if (!query) {
    console.error("Usage: wire rag retrieve <query> [--topk 5] [--file <path>]");
    process.exit(1);
  }
  const topK = parseInt(flags["topk"] ?? "5", 10);
  const results = await store.retrieve({ query, topK, sourceFile: flags["file"] });
  if (results.length === 0) {
    console.log("No results found.");
    process.exit(0);
  }
  console.log(`${results.length} result(s) for: "${query}"\n`);
  for (const r of results) {
    const score = (r.score * 100).toFixed(0);
    console.log(`[${score}%] ${r.source_file} chunk #${r.chunk_index}`);
    console.log(`  ${r.content.slice(0, 200).replace(/\n/g, " ")}${r.content.length > 200 ? "..." : ""}`);
    console.log();
  }

// ─── rag list ─────────────────────────────────────────────────────────────────

} else if (subcmd === "rag" && args[0] === "list") {
  const files = store.listFiles();
  if (files.length === 0) {
    console.log("No files ingested yet. Use: wire ingest <file>");
    process.exit(0);
  }
  console.log(`Ingested files (${files.length}):`);
  for (const f of files) {
    const date = new Date(f.ingestedAt).toISOString().slice(0, 10);
    console.log(`  ${f.chunks} chunks  ${date}  ${f.sourceFile}`);
  }

// ─── rag remove ───────────────────────────────────────────────────────────────

} else if (subcmd === "rag" && args[0] === "remove") {
  const filePath = args[1];
  if (!filePath) {
    console.error("Usage: wire rag remove <file>");
    process.exit(1);
  }
  const removed = store.remove(filePath);
  console.log(`Removed ${removed} chunks for ${filePath}`);

} else {
  console.log(`Usage:
  wire ingest <file>              Ingest a file into the RAG store
  wire rag retrieve <query>       Semantic search [--topk 5] [--file <path>]
  wire rag list                   List all ingested files
  wire rag remove <file>          Remove a file's chunks from the store`);
  process.exit(1);
}
