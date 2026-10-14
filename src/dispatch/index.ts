import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeMessage, parseWireFile } from "../envelope/decode.js";
import { isLegacyFile, isWireFile, parseLegacyHandoff } from "./legacy.js";
import type { AgentId, WirePayload, SkillType, DispatchResult } from "../types.js";

// ─── Dispatcher ──────────────────────────────────────────────────────────────
// Reads ~/projects/inbox/, detects file format, and routes accordingly.
// WireProtocol v1 files (.wire.json): full decode + verify pipeline.
// Legacy Markdown files (.md): parse headers and log — no auto-dispatch from here.

export interface DispatchOptions {
  inboxDir: string;
  keysDir: string;
  stateDir: string;
  recipientId: AgentId;
  dryRun?: boolean;
}

export interface ScanResult {
  wire: WireDispatchItem[];
  legacy: LegacyDispatchItem[];
  errors: ErrorItem[];
}

export interface WireDispatchItem {
  filename: string;
  messageId: string;
  from: AgentId;
  to: AgentId;
  type: string;
  skill: SkillType;
  priority: number;
  payload: WirePayload;
  enc: boolean;
}

export interface LegacyDispatchItem {
  filename: string;
  from?: string;
  to?: string;
  target?: string;
  status?: string;
  workType?: string;
  body: string;
}

export interface ErrorItem {
  filename: string;
  error: string;
}

// ─── Scan inbox ───────────────────────────────────────────────────────────────

export function scanInbox(opts: DispatchOptions): ScanResult {

  const result: ScanResult = { wire: [], legacy: [], errors: [] };

  let entries: string[];
  try {
    entries = readdirSync(opts.inboxDir);
  } catch {
    result.errors.push({ filename: opts.inboxDir, error: "Cannot read inbox directory" });
    return result;
  }

  for (const filename of entries.sort()) {
    const filepath = join(opts.inboxDir, filename);

    try {
      if (!statSync(filepath).isFile()) continue;
    } catch (e) {
      result.errors.push({ filename, error: `stat failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    if (isWireFile(filename)) {
      const content = readFileSync(filepath, "utf8");
      const raw = parseWireFile(content);

      if (raw === null) {
        result.errors.push({ filename, error: "Not valid JSON" });
        continue;
      }

      const decoded = decodeMessage(raw, opts.recipientId);

      if (!decoded.ok) {
        result.errors.push({ filename, error: `[${decoded.code}] ${decoded.detail}` });
        continue;
      }

      const { message: msg, payload } = decoded;

      // Only route messages addressed to our recipient
      if (msg.to !== opts.recipientId) {
        // Not for us — skip without consuming nonce
        continue;
      }

      result.wire.push({
        filename,
        messageId: msg.id,
        from: msg.from,
        to: msg.to,
        type: msg.type,
        skill: msg.skill,
        priority: msg.priority,
        payload,
        enc: msg.enc,
      });
    } else if (isLegacyFile(filename)) {
      const content = readFileSync(filepath, "utf8");
      const parsed = parseLegacyHandoff(content);

      // Only surface pending messages
      if (parsed.status === "actioned") continue;

      result.legacy.push({
        filename,
        from: parsed.from,
        to: parsed.to,
        target: parsed.target,
        status: parsed.status,
        workType: parsed.workType,
        body: parsed.body.slice(0, 200), // truncate for display
      });
    }
  }

  // Sort wire messages by priority (1=critical first)
  result.wire.sort((a, b) => a.priority - b.priority);

  return result;
}

// ─── Print scan report ───────────────────────────────────────────────────────

export function printScanReport(result: ScanResult): void {
  const total = result.wire.length + result.legacy.length + result.errors.length;
  console.log(`\n=== Inbox Scan: ${total} file(s) ===`);

  if (result.wire.length > 0) {
    console.log(`\n-- WireProtocol v1 (${result.wire.length} verified) --`);
    for (const item of result.wire) {
      console.log(
        `  [p${item.priority}] ${item.filename}\n` +
        `       from=${item.from}  type=${item.type}  skill=${item.skill}  enc=${item.enc}\n` +
        `       payload.format=${(item.payload as unknown as Record<string, unknown>)["format"] ?? "?"}`
      );
    }
  }

  if (result.legacy.length > 0) {
    console.log(`\n-- Legacy Markdown (${result.legacy.length} pending) --`);
    for (const item of result.legacy) {
      console.log(
        `  ${item.filename}\n` +
        `    from=${item.from ?? "?"}  target=${item.target ?? "?"}  work_type=${item.workType ?? "?"}`
      );
    }
  }

  if (result.errors.length > 0) {
    console.log(`\n-- Errors (${result.errors.length}) --`);
    for (const item of result.errors) {
      console.log(`  ${item.filename}: ${item.error}`);
    }
  }

  if (total === 0) console.log("  (empty)");
}
