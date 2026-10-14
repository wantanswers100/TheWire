// agentHandoff.ts — generic markdown handoff parser for the all-agent
// visibility layer.
//
// This intentionally validates only the shared Markdown handoff contract from
// the handoff protocol. Agent-specific execution contracts (for example Codex
// project_path/task_type/action_type/allowed_files gates) stay in their own
// parser modules until a separately approved dispatch-adapter phase.

import { readFileSync } from "node:fs";
import { parseFrontmatter, splitFrontmatter } from "./codexHandoff.js";

export const KNOWN_AGENT_TOKENS = ["claude", "codex", "gemini", "ollama", "antigravity"] as const;
export type MarkdownAgentToken = typeof KNOWN_AGENT_TOKENS[number];

const KNOWN_AGENT_SET = new Set<string>(KNOWN_AGENT_TOKENS);
const VALID_STATUS = new Set(["pending", "actioned"]);

export interface AgentHandoffRequest {
  from: MarkdownAgentToken;
  to: MarkdownAgentToken;
  target: MarkdownAgentToken;
  date: string;
  project: string;
  status: "pending" | "actioned";
  work_type: string;
  task_type?: string;
  allow_online_fallback?: boolean;
  body: string;
  sourceFile: string;
}

export interface AgentHandoffValidationError {
  field: string;
  message: string;
}

export type AgentHandoffParseResult =
  | { ok: true; request: AgentHandoffRequest }
  | { ok: false; errors: AgentHandoffValidationError[] };

type RawFrontmatter = ReturnType<typeof parseFrontmatter>;

function asString(raw: RawFrontmatter, key: string): string | undefined {
  const v = raw[key];
  return typeof v === "string" ? v : undefined;
}

function isKnownAgent(value: string | undefined): value is MarkdownAgentToken {
  return value !== undefined && KNOWN_AGENT_SET.has(value);
}

export function isKnownAgentToken(value: string): value is MarkdownAgentToken {
  return KNOWN_AGENT_SET.has(value);
}

function asBoolean(raw: RawFrontmatter, key: string): boolean | undefined {
  const v = asString(raw, key);
  if (v === undefined) return undefined;
  if (v.toLowerCase() === "true") return true;
  if (v.toLowerCase() === "false") return false;
  return undefined;
}

export function validateAgentHandoffFields(
  raw: RawFrontmatter,
  body: string,
  sourceFile: string,
): AgentHandoffParseResult {
  const errors: AgentHandoffValidationError[] = [];

  const from = asString(raw, "from");
  const to = asString(raw, "to");
  const target = asString(raw, "target");
  const date = asString(raw, "date");
  const project = asString(raw, "project");
  const status = asString(raw, "status");
  const workType = asString(raw, "work_type");

  if (!from) errors.push({ field: "from", message: "required field missing" });
  else if (!isKnownAgent(from)) errors.push({ field: "from", message: `unknown agent token "${from}"` });

  if (!to) errors.push({ field: "to", message: "required field missing" });
  else if (!isKnownAgent(to)) errors.push({ field: "to", message: `unknown agent token "${to}"` });

  if (!target) errors.push({ field: "target", message: "required field missing" });
  else if (!isKnownAgent(target)) errors.push({ field: "target", message: `unknown agent token "${target}"` });

  if (to && target && to !== target) {
    errors.push({ field: "target", message: `must match to (${to}) — got "${target}"` });
  }

  if (!date) errors.push({ field: "date", message: "required field missing" });
  if (!project) errors.push({ field: "project", message: "required field missing" });

  if (!status) errors.push({ field: "status", message: "required field missing" });
  else if (!VALID_STATUS.has(status)) errors.push({ field: "status", message: `must be pending or actioned — got "${status}"` });

  if (!workType) errors.push({ field: "work_type", message: "required field missing" });

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    request: {
      from: from as MarkdownAgentToken,
      to: to as MarkdownAgentToken,
      target: target as MarkdownAgentToken,
      date: date!,
      project: project!,
      status: status as "pending" | "actioned",
      work_type: workType!,
      task_type: asString(raw, "task_type"),
      allow_online_fallback: asBoolean(raw, "allow_online_fallback"),
      body,
      sourceFile,
    },
  };
}

export function parseAgentHandoffContent(content: string, sourceFile: string): AgentHandoffParseResult {
  const split = splitFrontmatter(content);
  if (!split) {
    return { ok: false, errors: [{ field: "frontmatter", message: "no frontmatter block found (expected --- ... --- at top of file)" }] };
  }

  const raw = parseFrontmatter(split.frontmatter);
  return validateAgentHandoffFields(raw, split.body, sourceFile);
}

export function parseAgentHandoffFile(filePath: string): AgentHandoffParseResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    return { ok: false, errors: [{ field: "sourceFile", message: `cannot read file: ${e instanceof Error ? e.message : String(e)}` }] };
  }

  return parseAgentHandoffContent(content, filePath);
}

export function rawFrontmatterAgentIntent(content: string): { to?: string; target?: string } | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  const raw = parseFrontmatter(split.frontmatter);
  return {
    to: asString(raw, "to"),
    target: asString(raw, "target"),
  };
}
