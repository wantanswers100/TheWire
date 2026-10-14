// Per-installation settings that must never ship in the code: who may approve
// Codex EXECUTE handoffs, where a daily briefing lives. Read from
// .wire-state/local.json (gitignored); environment variables win.
//   { "approver": "Your Name", "briefingPath": "/path/to/briefing.md" }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";

interface LocalSettings { approver?: string; briefingPath?: string }

function readLocal(): LocalSettings {
  const file = join(STATE_DIR, "local.json");
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as LocalSettings;
    return typeof v === "object" && v !== null ? v : {};
  } catch (e) {
    console.warn(`[config] ignoring .wire-state/local.json: ${(e as Error).message}`);
    return {};
  }
}

// The name an EXECUTE handoff's `approved_by` must match. Default "owner".
export function approverName(): string {
  return process.env["WIRE_APPROVER"] ?? readLocal().approver ?? "owner";
}

// Optional daily briefing shown by `wire-up`; undefined means none.
export function briefingPath(): string | undefined {
  return process.env["WIRE_BRIEFING_PATH"] ?? readLocal().briefingPath;
}
