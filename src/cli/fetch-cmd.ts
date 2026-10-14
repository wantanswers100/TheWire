// wire fetch — fetch a URL and answer a question about its content
//
// Usage:
//   wire fetch "<url>" "<question>"
//   wire fetch "https://launchpad.net/ubuntu" "what milestones are open?"

import { join } from "node:path";
import { webFetch } from "../agents/web-fetch.js";

const PROJECT_ROOT = join(import.meta.dir, "../..");

export async function runFetch(args: string[]): Promise<void> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(`wire fetch — fetch a URL and answer a question about its content

Usage: wire fetch "<url>" "<question>"

Uses Ollama (free, local) to answer. Falls back to Gemini if Ollama is unavailable.
Does not execute JavaScript — works best on static/server-rendered pages.

Examples:
  wire fetch "https://launchpad.net/ubuntu" "what milestones are currently open?"
  wire fetch "https://launchpad.net/ubuntu/+bugs" "how many critical bugs are open?"
  wire fetch "https://releases.ubuntu.com" "what is the latest LTS release?"`);
    process.exit(args.length ? 0 : 1);
  }

  const url = args[0]!;
  const question = args.slice(1).join(" ").trim() || "Summarize the key information on this page.";

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    console.error(`[wire fetch] URL must start with http:// or https://`);
    process.exit(1);
  }

  try {
    await webFetch(url, question, PROJECT_ROOT);
  } catch (e) {
    console.error(`[wire fetch] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
