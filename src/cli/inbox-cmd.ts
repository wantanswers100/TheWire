// wire inbox — scan ~/projects/inbox/ and display grouped file inventory
//
// Usage:
//   wire inbox

import { readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
// ISS-031: sourced from config/paths.ts, not redefined locally. This file's
// own definition skipped the process.env["HOME"] override every other copy
// used (join(homedir(), ...) only) — a real, live divergence risk under
// sudo/containers/service managers with a different HOME, silently coincidental
// with the canonical value only because HOME happened to match on this machine.
import { INBOX_DIR } from "../config/paths.js";

type Category = "wire_message" | "document" | "junk" | "other";

interface InboxFile {
  name: string;
  path: string;
  category: Category;
  sizeBytes: number;
}

function ok(s: string): string   { return `\x1b[32m${s}\x1b[0m`; }
function warn(s: string): string  { return `\x1b[33m${s}\x1b[0m`; }
function dim(s: string): string   { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string): string  { return `\x1b[1m${s}\x1b[0m`; }

function categorize(name: string): Category {
  if (name.includes(":Zone.Identifier")) return "junk";
  const ext = extname(name).toLowerCase();
  if (name.endsWith(".wire.json"))          return "wire_message";
  if ([".md", ".txt", ".pdf", ".json", ".yaml", ".yml", ".csv", ".html"].includes(ext)) return "document";
  return "other";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function scanInbox(): InboxFile[] {
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = readdirSync(INBOX_DIR, { withFileTypes: true }) as unknown as { isDirectory(): boolean; name: string }[];
  } catch {
    return [];
  }

  const files: InboxFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith(".")) continue;
    if (name === "README.md") continue;

    const path = join(INBOX_DIR, name);
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(path).size;
    } catch { /* ignore */ }

    files.push({ name, path, category: categorize(name), sizeBytes });
  }
  return files;
}

function printGroup(label: string, files: InboxFile[], hint?: string): void {
  if (files.length === 0) return;
  console.log(bold(`\n${label}`) + dim(` (${files.length})`));
  for (const f of files) {
    const size = dim(formatSize(f.sizeBytes).padStart(6));
    console.log(`  ${size}  ${f.name}`);
  }
  if (hint) console.log(dim(`  ${hint}`));
}

export function runInbox(_args: string[]): void {
  const files = scanInbox();

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${bold("Wire Inbox")}  ${dim(ts)}`);
  console.log(dim(`${INBOX_DIR}`));
  console.log(dim("─".repeat(60)));

  if (files.length === 0) {
    console.log(ok("  Inbox is clear."));
    console.log();
    return;
  }

  const wire      = files.filter(f => f.category === "wire_message");
  const documents = files.filter(f => f.category === "document");
  const other     = files.filter(f => f.category === "other");
  const junk      = files.filter(f => f.category === "junk");

  printGroup("Wire Messages", wire,      "Dispatch with: wire recv <file>");
  printGroup("Documents",     documents, "Review with: wire explain-file <file>  or  wire work <project> \"process <file>\"");
  printGroup("Other",         other);
  printGroup("Junk",          junk,      "Safe to delete: Zone.Identifier metadata files");

  console.log();
  console.log(dim(`Total: ${files.length} file${files.length === 1 ? "" : "s"}  |  path: ${INBOX_DIR}`));
  console.log();
}
