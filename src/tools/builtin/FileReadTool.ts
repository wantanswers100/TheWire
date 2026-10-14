// FileReadTool — read a local file with two-stage path traversal guard
// Never reads outside the user's home directory or allowed workspace paths.

import { readFileSync, realpathSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { ToolDefinition, ToolCallResult } from "../types.js";

const HOME = process.env["HOME"] ?? homedir();
const MAX_BYTES = 64 * 1024; // 64 KB max to prevent context flooding

export const FileReadTool: ToolDefinition = {
  name: "file_read",
  description: "Read a local file. Limited to the user's home directory. Max 64 KB.",
  requiresHitl: false,
  enabled: true,
  parameters: {
    path: {
      type: "string",
      description: "Absolute or home-relative file path",
      required: true,
    },
    maxLines: {
      type: "number",
      description: "Maximum lines to return (default: unlimited within 64 KB)",
      required: false,
    },
  },
  async execute(args): Promise<ToolCallResult> {
    const rawPath = args["path"];
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { ok: false, error: "file_read: path must be a non-empty string" };
    }

    // Stage 1: resolve to absolute path
    const resolved = resolve(HOME, rawPath.startsWith("~") ? rawPath.replace(/^~/, HOME) : rawPath);

    // Stage 2: check it exists, then realpathSync to follow symlinks
    if (!existsSync(resolved)) {
      return { ok: false, error: `file_read: file not found: ${resolved}` };
    }

    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      return { ok: false, error: `file_read: cannot resolve real path for: ${resolved}` };
    }

    // Guard: must stay within HOME
    if (!realPath.startsWith(HOME + "/") && realPath !== HOME) {
      return { ok: false, error: `file_read: path outside allowed directory: ${realPath}` };
    }

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(realPath);
    } catch {
      return { ok: false, error: `file_read: cannot stat: ${realPath}` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `file_read: not a regular file: ${realPath}` };
    }

    let content: string;
    try {
      const buffer = readFileSync(realPath);
      const truncated = buffer.subarray(0, MAX_BYTES);
      content = truncated.toString("utf8");
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const maxLines = typeof args["maxLines"] === "number" ? args["maxLines"] : null;
    if (maxLines !== null) {
      content = content.split("\n").slice(0, maxLines).join("\n");
    }

    const wasTruncated = stat.size > MAX_BYTES;
    return {
      ok: true,
      output: wasTruncated ? `${content}\n[truncated at 64 KB — file is ${stat.size} bytes]` : content,
    };
  },
};
