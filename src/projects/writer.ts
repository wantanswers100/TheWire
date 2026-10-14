// writer.ts — safe patch-based writes to project context files
//
// Supports two modes:
//   overwrite — replace entire file content (expected_version checked if manifest present)
//   append    — append content to existing file
//
// Path is validated by security.ts before any write occurs.
// Version conflict → throws with current version so agent can re-read.

import { existsSync, readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import { validateWritePath } from "./security.js";

export interface WriteResult {
  project: string;
  path: string;
  mode: "overwrite" | "append";
  bytes_written: number;
  previous_version: number | null;
  conflict: boolean;
}

export function writeProjectFile(
  projectId: string,
  projectRoot: string,
  relativePath: string,
  content: string,
  mode: "overwrite" | "append" = "overwrite",
  expectedVersion?: number,
): WriteResult {
  const absolutePath = validateWritePath(projectRoot, relativePath);

  // Optimistic locking via MANIFEST.json version
  const manifestPath = join(projectRoot, "context", "MANIFEST.json");
  let currentVersion: number | null = null;

  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: number };
      currentVersion = manifest.version ?? null;
    } catch { /* ignore */ }
  }

  if (expectedVersion !== undefined && currentVersion !== null && currentVersion !== expectedVersion) {
    throw new Error(
      `project_write: version conflict — expected ${expectedVersion}, current is ${currentVersion}. Re-read project context before writing.`
    );
  }

  // Ensure directory exists
  const dir = dirname(absolutePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o755 });

  let finalContent = content;
  if (mode === "append" && existsSync(absolutePath)) {
    const existing = readFileSync(absolutePath, "utf8");
    finalContent = existing + (existing.endsWith("\n") ? "" : "\n") + content;
  }

  // O_NOFOLLOW: a symlink swapped in after validation makes the open fail
  // instead of redirecting the write.
  const fd = openSync(absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try { writeSync(fd, finalContent, null, "utf8"); } finally { closeSync(fd); }

  // Bump manifest version if it exists
  if (existsSync(manifestPath)) {
    try {
      validateWritePath(projectRoot, "context/MANIFEST.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest["version"] = (typeof manifest["version"] === "number" ? manifest["version"] : 0) + 1;
      manifest["updated_at"] = new Date().toISOString();
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch { /* non-fatal — version tracking best-effort */ }
  }

  return {
    project: projectId,
    path: relativePath,
    mode,
    bytes_written: Buffer.byteLength(finalContent, "utf8"),
    previous_version: currentVersion,
    conflict: false,
  };
}
