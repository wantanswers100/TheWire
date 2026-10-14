// wire shell — direct shell execution with mandatory HITL gate
//
// Usage:
//   wire shell "ls -la ~/projects"
//   wire shell "git status"
//   wire shell "df -h"
//
// Every command prints the exact command and requires [y/N] approval.
// Non-interactive (piped/backgrounded) contexts fail hard — cannot approve.

import { runShellCommand } from "../agents/shell-worker.js";

export async function runShell(args: string[]): Promise<void> {
  const cmd = args.join(" ").trim();

  if (!cmd || args[0] === "--help" || args[0] === "-h") {
    console.log(`wire shell — run a shell command with HITL approval gate

Usage: wire shell "<command>"

Every command is printed and requires explicit [y/N] approval.
Output (stdout + stderr) is printed directly. Exit code is propagated.

Examples:
  wire shell "ls -la ~/projects"
  wire shell "git status"
  wire shell "df -h"
  wire shell "ollama list"

Note: wire shell requires an interactive terminal. It cannot run in
      piped or backgrounded contexts where approval cannot be given.`);
    process.exit(cmd ? 0 : 1);
  }

  try {
    const result = await runShellCommand(cmd);

    if (!result.approved) {
      console.log("Cancelled.");
      return;
    }

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  } catch (e) {
    console.error(`[wire shell] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
