#!/usr/bin/env bun
// wire watch — live inbox monitor for the bottom tmux pane
// Polls claude's inbox every POLL_MS and prints new messages as they arrive.
// Designed to run continuously in the background pane.

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
// ISS-031: sourced from config/paths.ts.
import { KEYS_DIR, GATEWAY_URL as GATEWAY } from "../config/paths.js";

const POLL_MS = 8000;
const DIV = "─".repeat(58);

function readClaudeToken(): string | null {
  const path = join(KEYS_DIR, "gateway-tokens.json");
  if (!existsSync(path)) return null;
  try {
    const tokens = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    return tokens["claude"] ?? null;
  } catch {
    return null;
  }
}

async function checkGateway(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let consecutiveFetchFailures = 0;

async function fetchInbox(token: string): Promise<unknown[]> {
  try {
    const res = await fetch(`${GATEWAY}/inbox/claude?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      consecutiveFetchFailures++;
      if (consecutiveFetchFailures >= 3) {
        console.log(`[${ts()}] [warn] inbox fetch failing (${res.status}) — ${consecutiveFetchFailures} consecutive errors. Check gateway token.`);
      }
      return [];
    }
    consecutiveFetchFailures = 0;
    const data = await res.json() as { messages?: unknown[] };
    return data.messages ?? [];
  } catch (e) {
    consecutiveFetchFailures++;
    if (consecutiveFetchFailures >= 3) {
      console.log(`[${ts()}] [warn] gateway unreachable — ${consecutiveFetchFailures} consecutive errors: ${e instanceof Error ? e.message : String(e)}`);
    }
    return [];
  }
}

function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function fmtMessage(msg: Record<string, unknown>): string {
  const type  = String(msg["type"]  ?? "?").padEnd(9);
  const from  = `from=${msg["from"]  ?? "?"}`.padEnd(18);
  const skill = `skill=${msg["skill"] ?? "?"}`.padEnd(20);
  const msgTs = msg["ts"] ? new Date(msg["ts"] as number).toLocaleTimeString("en-US", { hour12: false }) : "";
  return `  ${type}${from}${skill}${msgTs}`;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const token = readClaudeToken();
if (!token) {
  console.error("Token not found. Run: bun run bootstrap");
  process.exit(1);
}

// Track which message IDs we've already shown
const seen = new Set<string>();
let lastGwState = false;
let pollCount = 0;

console.log(`${DIV}`);
console.log(`  Wire Watch  |  inbox polling every ${POLL_MS / 1000}s`);
console.log(`${DIV}`);

while (true) {
  pollCount++;
  const gwUp = await checkGateway();

  // Report gateway state changes
  if (gwUp !== lastGwState) {
    const state = gwUp ? "gateway up" : "gateway down";
    console.log(`[${ts()}]  ${state}`);
    lastGwState = gwUp;
  }

  if (gwUp) {
    const messages = await fetchInbox(token);
    const newMsgs = messages.filter(m => {
      const id = (m as Record<string, unknown>)["messageId"] as string | undefined;
      return id && !seen.has(id);
    });

    for (const msg of newMsgs) {
      const m = msg as Record<string, unknown>;
      const id = m["messageId"] as string;
      seen.add(id);
      console.log(`[${ts()}]  new message`);
      console.log(fmtMessage(m));
    }

    // Periodic heartbeat every ~60s (every 8 polls)
    if (pollCount % 8 === 0) {
      const count = messages.length;
      const label = count === 0 ? "inbox empty" : `${count} pending`;
      console.log(`[${ts()}]  ${label}`);
    }
  }

  await Bun.sleep(POLL_MS);
}
