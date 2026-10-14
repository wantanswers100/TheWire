import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { PROJECT_ROOT } from "../config/paths.js";

// Keys every Wire install may hold. Names found in Wire's own .env are added
// at call time, because Bun loads .env into process.env when Wire runs from
// its repo dir, and every child would otherwise inherit all of them.
const WIRE_SECRET_KEYS = [
  "GEMINI_API_KEY", "GROQ_API_KEY", "WIRE_COMPLETE_API_KEY", "PERPLEXITY_API_KEY",
  "OPENAI_API_KEY", "OPENAI_SESSION_TOKEN", "ANTHROPIC_API_KEY",
];

// Each vendor CLI keeps its own credentials; nothing else crosses over.
const OWN_KEYS: Record<string, string[]> = {
  claude: ["ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY", "OPENAI_SESSION_TOKEN"],
};

function wireEnvFileKeys(): string[] {
  const p = join(PROJECT_ROOT, ".env");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => l.slice(0, l.indexOf("=")).trim());
}

export function childEnvFor(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  secretKeys: string[] = [...WIRE_SECRET_KEYS, ...wireEnvFileKeys()],
): NodeJS.ProcessEnv {
  const keep = new Set(OWN_KEYS[basename(command)] ?? []);
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of secretKeys) if (!keep.has(k)) delete out[k];
  return out;
}

export interface SpawnAsyncOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  shell?: boolean;
  input?: string;
}

export interface SpawnAsyncResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export async function spawnAsync(
  command: string,
  args: string[],
  options: SpawnAsyncOptions = {}
): Promise<SpawnAsyncResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      env: options.env ?? childEnvFor(command),
      shell: options.shell ?? false
    });
    
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;

    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.stdout.on("data", (data) => {
      stdout += data.toString("utf8");
      if (options.maxBuffer && stdout.length > options.maxBuffer) {
        child.kill("SIGKILL");
        error = new Error(`maxBuffer size exceeded (${options.maxBuffer} bytes)`);
      }
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString("utf8");
    });

    child.on("error", (err) => {
      error = err;
    });

    let timeoutId: NodeJS.Timeout | undefined;
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        child.kill("SIGTERM");
        error = new Error("ETIMEDOUT");
        (error as any).code = "ETIMEDOUT";
      }, options.timeout);
    }

    child.on("close", (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, status: code, signal, error });
    });
  });
}
