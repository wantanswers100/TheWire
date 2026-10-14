// codexProjectState.ts — reads a target project's STATUS.md to check whether
// its `**Active session:**` field is clear before a codex dispatch proceeds.
//
// Fail-closed by design: missing file, missing field, unreadable file, or any
// value that doesn't match bounded "none" semantics all refuse. There is no
// default-to-pass path anywhere in this module.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ActiveSessionCheckResult {
  clear: boolean;
  reason: string;
  rawValue?: string;
}

// Bounded "none" match: the value must start with "none" (case-insensitive)
// and the character immediately after it must be whitespace or end-of-string.
// This accepts "none", "None", "none — prior run complete", "none - done"
// and rejects "none-ish", "nonexistent" — anything where "none" is a prefix
// of a longer word rather than a standalone token.
const NONE_PATTERN = /^none(\s|$)/i;

export function isBoundedNone(value: string): boolean {
  return NONE_PATTERN.test(value.trim());
}

/**
 * Extract the `**Active session:**` value from STATUS.md content.
 * Returns null if the field is absent or the line can't be parsed —
 * callers must treat null as "not clear," never as "assume none."
 */
export function extractActiveSession(statusMdContent: string): string | null {
  const match = statusMdContent.match(/\*\*Active session:\*\*\s*(.+)/);
  if (!match) return null;
  const value = match[1]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Check whether the target project's STATUS.md reports a clear (bounded-none)
 * Active session. Fail-closed on every error path — no STATUS.md, unreadable
 * STATUS.md, and a missing/malformed field are all "not clear," not "assume ok."
 */
export function checkActiveSessionClear(canonicalProjectPath: string): ActiveSessionCheckResult {
  const statusPath = join(canonicalProjectPath, "STATUS.md");

  if (!existsSync(statusPath)) {
    return { clear: false, reason: "STATUS.md not found — cannot verify Active session, refusing" };
  }

  let content: string;
  try {
    content = readFileSync(statusPath, "utf8");
  } catch (e) {
    return { clear: false, reason: `cannot read STATUS.md: ${e instanceof Error ? e.message : String(e)}` };
  }

  const rawValue = extractActiveSession(content);
  if (rawValue === null) {
    return { clear: false, reason: "STATUS.md has no '**Active session:**' field — refusing (fail closed)" };
  }

  if (!isBoundedNone(rawValue)) {
    return { clear: false, reason: `Active session is not clear: "${rawValue}"`, rawValue };
  }

  return { clear: true, reason: `Active session clear: "${rawValue}"`, rawValue };
}
