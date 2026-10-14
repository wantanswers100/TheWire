// Shell worker — controlled shell execution with mandatory HITL gate
//
// Every command must be explicitly approved before execution.
// No auto-run, no silent fallbacks. Non-TTY contexts fail hard.
//
// Also exports generateShellCommand() — asks Ollama to convert NL → shell command
// for use by nl-cmd.ts NL shell dispatch path.

import { guardPrompt } from "../security/prompt-guard.js";
import { promptYesNo } from "../cli/prompt.js";

const OLLAMA = process.env["OLLAMA_URL"] ?? "http://localhost:11434";

// ─── Safety blocklist ─────────────────────────────────────────────────────────
// Defense-in-depth: HITL already requires human approval, but refuse to even
// present commands that are categorically catastrophic regardless of approval.

const BLOCKED_PATTERNS = [
  /rm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$)/i,   // rm -rf /
  /:\s*\(\s*\)\s*\{.*\|.*&.*\}/,             // fork bomb
  /dd\s+if=\/dev\/zero\s+of=\/dev\//i,       // dd wipe disk
  /mkfs\./i,                                  // format filesystem
  />\s*\/dev\/(s|h|v|xv)d[a-z]/i,           // direct disk overwrite
  /shred\s+.*\/dev\//i,                      // shred disk device
  // rm with -r and -f in any flag form, aimed at /, /*, ~ or $HOME
  /\brm\s+(?=[^|;&]*-[a-z]*r)(?=[^|;&]*-[a-z]*f)(?:-[a-z]+\s+)+(?:\/\*?|~\/?|\$HOME\/?|\$\{HOME\}\/?)(?:\s|$)/i,
  /\bfind\s+\/\s.*-delete\b/i,               // find / -delete
  /\bdd\s+.*\bof=\/dev\//i,                  // dd onto any device
];

// Control characters (\r, ANSI escapes) can make the approval prompt show a
// different command than the one that runs. Render them visibly instead.
export function displaySafe(cmd: string): string {
  return cmd.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ch => {
    const named: Record<string, string> = { "\r": "\\r", "\t": "\\t", "\x1b": "\\x1b" };
    return named[ch] ?? `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

export function isBlocked(cmd: string): boolean {
  return BLOCKED_PATTERNS.some(p => p.test(cmd));
}

export interface ShellResult {
  cmd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  approved: boolean;
}

// ─── TTY guard ────────────────────────────────────────────────────────────────

export function requireTTY(): void {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Shell worker requires an interactive TTY. " +
      "Cannot prompt for HITL approval in non-interactive (piped/backgrounded) context."
    );
  }
}

// ─── HITL gate ────────────────────────────────────────────────────────────────

async function hitlGate(cmd: string, workdir: string): Promise<boolean> {
  const cwd = process.cwd();
  console.log("\nShell command to run:");
  console.log(`  $ ${displaySafe(cmd)}`);
  if (workdir !== cwd) console.log(`  dir: ${workdir}`);
  return promptYesNo("\nApprove?");
}

// ─── Command runner ───────────────────────────────────────────────────────────

export async function runShellCommand(
  cmd: string,
  workdir = process.cwd(),
  timeoutMs = 30_000,
): Promise<ShellResult> {
  requireTTY();

  if (isBlocked(cmd)) {
    throw new Error(`Command blocked by safety policy: ${cmd}`);
  }

  const approved = await hitlGate(cmd, workdir);
  if (!approved) {
    return { cmd, exitCode: -1, stdout: "", stderr: "", approved: false };
  }

  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let stdout: string, stderr: string, exitCode: number;
  try {
    [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timedOut,
    ]) as [string, string, number];
  } finally {
    clearTimeout(timer);  // otherwise the CLI lingers up to timeoutMs after a fast command
  }

  return { cmd, exitCode, stdout, stderr, approved: true };
}

// ─── NL → shell command generation ───────────────────────────────────────────
// Asks Ollama to convert a natural-language request into a single shell command.
// Returns null if Ollama is unavailable or output doesn't look like a command.

export async function generateShellCommand(nlRequest: string): Promise<string | null> {
  const safeRequest = guardPrompt(nlRequest, "shell NL request");
  const prompt = `Convert this natural language request into a single Linux shell command.
Output ONLY the shell command — no explanation, no markdown, no extra text.

Request: "${safeRequest}"

Command:`;

  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen3:4b",
        prompt,
        stream: false,
        think: false,
        options: { temperature: 0.1, num_predict: 64 },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;
    const data = await res.json() as { response: string };
    const cmd = data.response?.trim()
      .replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "")  // strip markdown fences
      .split("\n")[0]!                                       // first line only
      .trim();

    // Basic sanity: must look like a command (has a word char), not a sentence
    if (!cmd || cmd.length > 200 || /^[A-Z].*[.?!]$/.test(cmd)) return null;
    return cmd;
  } catch {
    return null;
  }
}
