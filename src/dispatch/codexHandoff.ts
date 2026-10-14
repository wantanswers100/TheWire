// codexHandoff.ts — parse and validate codex_execution_request.md-shaped handoff files.
//
// Handoff files are markdown with a YAML-lite frontmatter block (delimited by
// `---` lines) followed by a free-text body. The frontmatter is the trusted,
// validated contract; the body is untrusted task input (see prompt-guard.ts
// for how the body must be sanitized before ever reaching an LLM prompt —
// this module does not sanitize, it only parses and validates structure).
//
// No YAML library — Zod is the only permitted external dependency workspace-wide,
// and this frontmatter shape (flat key: value pairs + simple `- item` lists) is
// simple enough that a hand-rolled parser is the leaner choice, matching the
// existing convention of manual arg/format parsing elsewhere in this CLI.

import { approverName } from "../config/local.js";
import { readFileSync } from "node:fs";

export type CodexActionType = "read" | "write" | "modify";

export interface CodexHandoffRequest {
  from: string;
  to: string;
  target: string;
  date?: string;
  project: string;
  project_path: string;
  status?: string;
  work_type?: string;
  task_type: string;
  trust_level?: string;
  requires_validation?: boolean;
  approved_by?: string;
  approval_date?: string;
  action_type: CodexActionType;
  delete_allowed?: boolean;
  no_delete?: boolean;
  no_auto_write?: boolean;
  allowed_files: string[];
  forbidden_actions: string[];
  /** Raw markdown body after the frontmatter block. UNTRUSTED — never pass to
   *  an LLM prompt without running it through security/prompt-guard.ts first. */
  body: string;
  /** Absolute path to the handoff file this was parsed from. */
  sourceFile: string;
}

export interface HandoffValidationError {
  field: string;
  message: string;
}

export type HandoffParseResult =
  | { ok: true; request: CodexHandoffRequest }
  | { ok: false; errors: HandoffValidationError[] };

interface RawFrontmatter {
  [key: string]: string | string[];
}

// ─── Frontmatter parsing ────────────────────────────────────────────────────

/**
 * Split a handoff file's content into its frontmatter block and body.
 * Frontmatter is delimited by a `---` line at the very start and another
 * `---` line closing it. Returns null if the file has no frontmatter block.
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return null;

  const frontmatter = lines.slice(1, endIdx).join("\n");
  const body = lines.slice(endIdx + 1).join("\n").replace(/^\n+/, "");
  return { frontmatter, body };
}

/**
 * Parse a flat YAML-lite frontmatter block: `key: value` lines, plus simple
 * indented `  - item` lists directly under a `key:` line with no inline value.
 * Not a general YAML parser — deliberately narrow to what the handoff
 * templates actually use.
 */
export function parseFrontmatter(frontmatter: string): RawFrontmatter {
  const raw: RawFrontmatter = {};
  const lines = frontmatter.split("\n");
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentListKey) {
      const item = listMatch[1]!.trim();
      const existing = raw[currentListKey];
      if (Array.isArray(existing)) existing.push(item);
      else raw[currentListKey] = [item];
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1]!;
      const value = kvMatch[2]!.trim();
      if (value === "") {
        // Key with no inline value — likely a list starts on following lines.
        currentListKey = key;
        raw[key] = [];
      } else {
        currentListKey = null;
        raw[key] = value;
      }
      continue;
    }

    // Unrecognized line inside frontmatter — ignore rather than fail the
    // whole parse; validation below catches missing required fields anyway.
    currentListKey = null;
  }

  return raw;
}

function asString(raw: RawFrontmatter, key: string): string | undefined {
  const v = raw[key];
  return typeof v === "string" ? v : undefined;
}

function asStringArray(raw: RawFrontmatter, key: string): string[] {
  const v = raw[key];
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

function asBoolean(raw: RawFrontmatter, key: string): boolean | undefined {
  const v = asString(raw, key);
  if (v === undefined) return undefined;
  const lower = v.toLowerCase();
  if (lower === "yes" || lower === "true") return true;
  if (lower === "no" || lower === "false") return false;
  return undefined;
}

// ─── Validation ──────────────────────────────────────────────────────────────

const VALID_ACTION_TYPES: CodexActionType[] = ["read", "write", "modify"];

/**
 * Validate a raw parsed frontmatter + body into a CodexHandoffRequest.
 * Pure function — no filesystem access, no scope resolution (see codexScope.ts
 * for path canonicalization, which runs separately after this passes).
 */
export function validateHandoffFields(
  raw: RawFrontmatter,
  body: string,
  sourceFile: string
): HandoffParseResult {
  const errors: HandoffValidationError[] = [];

  const from = asString(raw, "from");
  const to = asString(raw, "to");
  const target = asString(raw, "target");
  const project = asString(raw, "project");
  const project_path = asString(raw, "project_path");
  const task_type = asString(raw, "task_type");
  const action_type_raw = asString(raw, "action_type");

  if (!from) errors.push({ field: "from", message: "required field missing" });
  if (!to) errors.push({ field: "to", message: "required field missing" });
  else if (to !== "codex") errors.push({ field: "to", message: `expected "codex", got "${to}"` });

  if (!target) errors.push({ field: "target", message: "required field missing" });
  else if (target !== "codex") errors.push({ field: "target", message: `expected "codex", got "${target}"` });

  if (!project) errors.push({ field: "project", message: "required field missing" });
  if (!project_path) errors.push({ field: "project_path", message: "required field missing" });
  if (!task_type) errors.push({ field: "task_type", message: "required field missing" });

  let action_type: CodexActionType | undefined;
  if (!action_type_raw) {
    errors.push({ field: "action_type", message: "required field missing" });
  } else if (!VALID_ACTION_TYPES.includes(action_type_raw as CodexActionType)) {
    errors.push({ field: "action_type", message: `must be one of ${VALID_ACTION_TYPES.join(" | ")}, got "${action_type_raw}"` });
  } else {
    action_type = action_type_raw as CodexActionType;
  }

  const allowed_files = asStringArray(raw, "allowed_files");
  const forbidden_actions = asStringArray(raw, "forbidden_actions");

  const approved_by = asString(raw, "approved_by");
  const approval_date = asString(raw, "approval_date");

  // EXECUTE-specific gate — the document gate from the design spec.
  if (task_type?.toUpperCase() === "EXECUTE") {
    const approver = approverName();
    if (!approved_by || approved_by !== approver) {
      errors.push({ field: "approved_by", message: `EXECUTE requires approved_by: ${approver} — got "${approved_by ?? "(missing)"}"` });
    }
    if (!approval_date) {
      errors.push({ field: "approval_date", message: "EXECUTE requires approval_date to be present" });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // At this point every field validated above is guaranteed present.
  const request: CodexHandoffRequest = {
    from: from!,
    to: to!,
    target: target!,
    date: asString(raw, "date"),
    project: project!,
    project_path: project_path!,
    status: asString(raw, "status"),
    work_type: asString(raw, "work_type"),
    task_type: task_type!,
    trust_level: asString(raw, "trust_level"),
    requires_validation: asBoolean(raw, "requires_validation"),
    approved_by,
    approval_date,
    action_type: action_type!,
    delete_allowed: asBoolean(raw, "delete_allowed"),
    no_delete: asBoolean(raw, "no_delete"),
    no_auto_write: asBoolean(raw, "no_auto_write"),
    allowed_files,
    forbidden_actions,
    body, // untrusted — caller must guardPrompt() this before any LLM use
    sourceFile,
  };

  return { ok: true, request };
}

/**
 * Read and validate a handoff file from disk.
 */
export function parseHandoffFile(filePath: string): HandoffParseResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, errors: [{ field: "sourceFile", message: `cannot read file: ${e instanceof Error ? e.message : String(e)}` }] };
  }

  const split = splitFrontmatter(content);
  if (!split) {
    return { ok: false, errors: [{ field: "frontmatter", message: "no frontmatter block found (expected --- ... --- at top of file)" }] };
  }

  const raw = parseFrontmatter(split.frontmatter);
  return validateHandoffFields(raw, split.body, filePath);
}
