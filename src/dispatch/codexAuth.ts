// codexAuth.ts — shared, side-effect-free Codex auth *presence* check.
//
// Checks existence/readability/size/mtime of auth signals only. Never reads
// or parses ~/.codex/auth.json's contents, never returns a secret value,
// never logs one. `configured` is true if ANY of three signals are present:
// OPENAI_API_KEY, OPENAI_SESSION_TOKEN, or a readable non-empty auth.json —
// the codex CLI's real auth mode (ChatGPT session) uses the file, not the
// env vars, so the env-only check this replaces was incomplete, not wrong.

import { existsSync, statSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface CodexAuthStatus {
  envApiKeyPresent: boolean;
  envSessionTokenPresent: boolean;
  authFilePresent: boolean;
  authFileAgeDays?: number;   // informational only, derived from mtime — never from content
  configured: boolean;        // OR of all three signals above
}

export function defaultAuthFilePath(): string {
  return join(process.env["HOME"] ?? homedir(), ".codex", "auth.json");
}

/**
 * Existence + readability + non-zero size + mtime only. Never opens the file
 * for reading, never parses it. Any error (permission denied, race between
 * exists/access/stat, etc.) is treated as "not present" — fail closed, never
 * "assume configured because the file is probably fine."
 */
function checkAuthFile(path: string): { present: boolean; ageDays?: number } {
  if (!existsSync(path)) return { present: false };
  try {
    accessSync(path, constants.R_OK); // readability check only — does not open/read content
    const stat = statSync(path);       // metadata only — size and mtime, never bytes
    if (stat.size === 0) return { present: false }; // zero-byte file treated as absent
    const ageDays = Math.max(0, (Date.now() - stat.mtimeMs) / 86_400_000);
    return { present: true, ageDays };
  } catch {
    return { present: false };
  }
}

export function checkCodexAuth(
  env: Record<string, string | undefined>,
  authFilePath: string = defaultAuthFilePath()
): CodexAuthStatus {
  const envApiKeyPresent = !!env["OPENAI_API_KEY"];
  const envSessionTokenPresent = !!env["OPENAI_SESSION_TOKEN"];
  const file = checkAuthFile(authFilePath);

  return {
    envApiKeyPresent,
    envSessionTokenPresent,
    authFilePresent: file.present,
    ...(file.ageDays !== undefined ? { authFileAgeDays: file.ageDays } : {}),
    configured: envApiKeyPresent || envSessionTokenPresent || file.present,
  };
}
