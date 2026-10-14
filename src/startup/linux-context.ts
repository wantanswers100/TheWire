// linux-context.ts — capture and persist the current Linux machine state
//
// Called by wire-start on every run. Writes docs/LINUX_CONTEXT.md with:
//   - WSL2 / OS info
//   - PATH and key tool versions
//   - Ollama models installed
//   - Running processes relevant to the Wire Platform
//   - Disk usage on the external drive (if mounted)
//   - Last updated timestamp
//
// This file is the agent's "eyes" on the Linux environment.
// Any session can read it to know what the machine looks like right now.

import { join } from "node:path";
import { writeFileSync } from "node:fs";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");
const CONTEXT_PATH = join(PROJECT_ROOT, "docs", "LINUX_CONTEXT.md");
const OLLAMA = "http://localhost:11434";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function run(cmd: string): Promise<string> {
  const proc = Bun.spawn(["bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return out.trim();
}

async function tryRun(cmd: string, fallback = "unavailable"): Promise<string> {
  try { return (await run(cmd)) || fallback; }
  catch { return fallback; }
}

async function ollamaModels(): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return "Ollama not running";
    const data = await res.json() as { models?: Array<{ name: string; size: number }> };
    if (!data.models?.length) return "No models installed";
    return data.models.map(m => {
      const gb = (m.size / 1e9).toFixed(1);
      return `- ${m.name} (${gb} GB)`;
    }).join("\n");
  } catch {
    return "Ollama not running";
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function updateLinuxContext(): Promise<void> {
  const now = new Date();
  const ts = now.toISOString();

  const [
    osRelease,
    kernelVersion,
    bunVersion,
    nodeVersion,
    gitVersion,
    curlVersion,
    diskHome,
    diskExternal,
    wireProcRunning,
    ollamaRunning,
    models,
    whoami,
    hostname,
  ] = await Promise.all([
    tryRun("grep PRETTY_NAME /etc/os-release | cut -d= -f2 | tr -d '\"'"),
    tryRun("uname -r"),
    tryRun("bun --version"),
    tryRun("node --version"),
    tryRun("git --version | head -1"),
    tryRun("curl --version | head -1 | awk '{print $1,$2}'"),
    tryRun("df -h ~ | awk 'NR==2{print $3\" used of \"$2\" (\"$5\" full)\"}'"),
    tryRun("df -h /mnt/d 2>/dev/null | awk 'NR==2{print $3\" used of \"$2\" (\"$5\" full)\"}' || echo 'not mounted'"),
    tryRun("pgrep -f 'wire/src/gateway/server.ts' > /dev/null && echo 'running' || echo 'stopped'"),
    tryRun("pgrep -x ollama > /dev/null && echo 'running' || echo 'stopped'"),
    ollamaModels(),
    tryRun("whoami"),
    tryRun("hostname"),
  ]);

  const content = `# Linux Context — Wire Platform

**Last updated:** ${ts}
**Host:** ${whoami}@${hostname}
**Updated by:** wire-start (auto-refresh on every startup)

---

## OS / Kernel

| Field | Value |
|-------|-------|
| OS | ${osRelease} |
| Kernel | ${kernelVersion} |
| Platform | WSL2 (Windows Subsystem for Linux) |

---

## Tool Versions

| Tool | Version |
|------|---------|
| bun | ${bunVersion} |
| node | ${nodeVersion} |
| git | ${gitVersion} |
| curl | ${curlVersion} |

---

## Disk

| Location | Usage |
|----------|-------|
| Home (~) | ${diskHome} |
| External (/mnt/d) | ${diskExternal} |

---

## Wire Platform Processes

| Process | Status |
|---------|--------|
| Gateway (:31338) | ${wireProcRunning} |
| Ollama | ${ollamaRunning} |

---

## Ollama Models

${models}

---

## Key Paths

| Purpose | Path |
|---------|------|
| agent-wire project | \`~/projects/active/agent-wire/\` |
| Keys | \`~/projects/active/agent-wire/.keys/\` |
| State / nonces | \`~/projects/active/agent-wire/.wire-state/\` |
| Inbox | \`~/projects/inbox/\` |
| bin commands | \`~/.local/bin/wire-up\` |

---

## Notes

- This file is overwritten on every \`wire-start\` run — do not edit manually.
- To check machine state mid-session: \`cat docs/LINUX_CONTEXT.md\`
- External drive path assumes \`/mnt/d\`; adjust if mounted elsewhere.
`;

  writeFileSync(CONTEXT_PATH, content, { encoding: "utf8" });
}
