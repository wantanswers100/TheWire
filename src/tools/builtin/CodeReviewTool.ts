// CodeReviewTool — review a source file via qwen2.5-coder:14b

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { OLLAMA_URL, OLLAMA_SKILL_MODEL } from "../../config/models.js";
import type { ToolDefinition, ToolCallResult } from "../types.js";

const HOME = process.env["HOME"] ?? homedir();
const MODEL = OLLAMA_SKILL_MODEL["code_review"] ?? "qwen2.5-coder:14b";

export const CodeReviewTool: ToolDefinition = {
  name: "code_review",
  description: "Review a source file for bugs, style, and security issues using qwen2.5-coder:14b.",
  requiresHitl: false,
  enabled: true,
  parameters: {
    path: {
      type: "string",
      description: "Path to the source file to review",
      required: true,
    },
    focus: {
      type: "string",
      description: "Optional focus area: security|performance|style|correctness",
      required: false,
    },
  },
  async execute(args): Promise<ToolCallResult> {
    const rawPath = args["path"];
    if (typeof rawPath !== "string" || !rawPath.trim()) {
      return { ok: false, error: "code_review: path must be a non-empty string" };
    }

    const resolved = resolve(HOME, rawPath.startsWith("~") ? rawPath.replace(/^~/, HOME) : rawPath);
    if (!existsSync(resolved)) {
      return { ok: false, error: `code_review: file not found: ${resolved}` };
    }

    let realPath: string;
    try {
      realPath = realpathSync(resolved);
    } catch {
      return { ok: false, error: `code_review: cannot resolve real path for: ${resolved}` };
    }

    if (!realPath.startsWith(HOME + "/") && realPath !== HOME) {
      return { ok: false, error: `code_review: path outside allowed directory: ${realPath}` };
    }

    let code: string;
    try {
      code = readFileSync(realPath, "utf8").slice(0, 20_000);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const focus = typeof args["focus"] === "string" ? args["focus"] : "general";
    const prompt =
      `Review the following source file for ${focus} issues.\n` +
      `File: ${realPath}\n\n` +
      `\`\`\`\n${code}\n\`\`\`\n\n` +
      `List specific issues with line references where possible. Be concise.`;

    try {
      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { ok: false, error: `code_review: Ollama HTTP ${res.status}` };
      const data = await res.json() as { response?: string };
      return { ok: true, output: data.response?.trim() ?? "(no response)" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
