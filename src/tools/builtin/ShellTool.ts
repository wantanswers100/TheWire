// ShellTool — execute shell commands via the HITL gate
// requiresHitl: true — caller must obtain approval before ToolRegistry.dispatch()

import type { ToolDefinition, ToolCallResult } from "../types.js";

export const ShellTool: ToolDefinition = {
  name: "shell",
  description: "Execute a shell command on the local machine. Requires HITL approval before execution.",
  requiresHitl: true,
  // Disabled: execute() below runs bash -c without a HITL gate of its own and a
  // weaker blocklist than shell-worker. No caller wires it today; if one ever
  // does, route it through runShellCommand() first.
  enabled: false,
  parameters: {
    command: {
      type: "string",
      description: "The shell command to run",
      required: true,
    },
    timeout: {
      type: "number",
      description: "Timeout in milliseconds (default: 30000)",
      required: false,
    },
  },
  async execute(args): Promise<ToolCallResult> {
    const command = args["command"];
    if (typeof command !== "string" || !command.trim()) {
      return { ok: false, error: "shell: command must be a non-empty string" };
    }

    // Safety blocklist — mirror of shell-worker.ts
    const blocked = [
      /rm\s+-rf\s+\//,
      /mkfs/,
      /dd\s+if=/,
      /:\(\)\{.*\}.*:/,   // fork bomb
      /shred/,
    ];
    for (const pattern of blocked) {
      if (pattern.test(command)) {
        return { ok: false, error: `shell: command blocked by safety filter` };
      }
    }

    const timeoutMs = typeof args["timeout"] === "number" ? args["timeout"] : 30_000;

    try {
      const proc = Bun.spawn(["bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      clearTimeout(timer);
      if (timedOut) {
        return { ok: false, error: `shell: command timed out after ${timeoutMs}ms` };
      }
      const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
      if (proc.exitCode !== 0) {
        return { ok: false, error: `shell: exited ${proc.exitCode}${combined ? `\n${combined}` : ""}`.slice(0, 4000) };
      }
      return { ok: true, output: combined.slice(0, 4000) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
