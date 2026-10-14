import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMessage, serializeMessage, wireFilename } from "../envelope/encode.js";
import type { AgentId, SkillType, TaskVerb, OutputFormat, Priority, TaskSpec } from "../types.js";

// ─── task subcommand ──────────────────────────────────────────────────────────
// Shorthand for sending a TaskSpec without constructing JSON manually.
//
// Example:
//   wire task --to ollama --skill quick --verb summarize --subject "meeting notes"
//   wire task --to gemini --skill research --verb query --subject "climate policy 2026"

interface TaskFlags {
  to?: AgentId;
  from: AgentId;
  skill?: SkillType;
  verb?: TaskVerb;
  subject?: string;
  domain: string[];
  output: OutputFormat;
  ttl?: number;
  thread?: string;
  priority?: Priority;
  models?: string[];  // --models claude,deepseek — restrict to named agents
}

function parseFlags(args: string[]): TaskFlags {
  const flags: TaskFlags = {
    from: "claude",
    domain: ["general"],
    output: "prose",
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case "--from":     flags.from = next as AgentId; i++; break;
      case "--to":       flags.to = next as AgentId; i++; break;
      case "--skill":    flags.skill = next as SkillType; i++; break;
      case "--verb":     flags.verb = next as TaskVerb; i++; break;
      case "--subject":  flags.subject = next; i++; break;
      case "--domain":   flags.domain = (next ?? "general").split(","); i++; break;
      case "--output":   flags.output = next as OutputFormat; i++; break;
      case "--ttl":      flags.ttl = parseInt(next ?? "3600", 10); i++; break;
      case "--thread":   flags.thread = next; i++; break;
      case "--priority": flags.priority = parseInt(next ?? "3", 10) as Priority; i++; break;
      case "--models":   flags.models = (next ?? "").split(",").map(s => s.trim()).filter(Boolean); i++; break;
    }
  }
  return flags;
}

export async function runTask(
  args: string[],
  _keysDir: string,
  _stateDir: string,
  inboxDir: string
): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`wire task — send a task to an agent without constructing JSON manually

Usage: wire task --to <agent> --skill <skill> --verb <verb> [options]

Required:
  --to <agent>       Destination agent: ollama | gemini | codex | claude | system
  --skill <skill>    Skill: quick | research | knowledge | debug | code | general
  --verb <verb>      Action: query | summarize | implement | review | verify |
                             transform | classify | plan | explain | debug

Optional:
  --subject <text>   What the task is about (quoted string)
  --from <agent>     Sender identity (default: claude)
  --domain <a,b>     Comma-separated domain tags (default: general)
  --output <fmt>     Output format: prose | structured | code | json | table | ranked-list (default: prose)
  --encrypt          Encrypt payload (requires keypairs)
  --ttl <seconds>    Message TTL (default: 3600)
  --thread <uuid>    Thread ID for correlated messages
  --priority <1-5>   Priority level (default: 3)

Examples:
  wire task --to ollama --skill quick --verb summarize --subject "team standup notes"
  wire task --to gemini --skill research --verb query --subject "UK housing policy 2026"
  wire task --to codex --skill debug --verb debug --subject "TypeError in router.ts line 42"
`);
    return;
  }

  const flags = parseFlags(args);

  const missing: string[] = [];
  if (!flags.to) missing.push("--to");
  if (!flags.skill) missing.push("--skill");
  if (!flags.verb) missing.push("--verb");
  if (missing.length > 0) {
    console.error(`Missing required flags: ${missing.join(", ")}`);
    console.error("Run: wire task --help");
    process.exit(1);
  }

  // ISS-027: the envelope is always addressed to "claude" — DispatchLoop only
  // ever processes messages with to==="claude" (loop.ts processFile()) and
  // does its own agent selection via WireRouter + fallback chain. `--to
  // <agent>` previously addressed the envelope directly to that agent, which
  // nothing automatically consumed (agentPickup.ts's pickup mechanism only
  // reads .md handoff files, never .wire.json task messages) — so every
  // `wire task --to <not-claude>` call silently went nowhere. `--to` now
  // constrains routing via modelFilter (same mechanism `--models` already
  // used) instead of bypassing the daemon.
  const modelFilter = flags.models?.length ? flags.models : [flags.to!];

  const payload: TaskSpec = {
    format: "task",
    verb: flags.verb!,
    domain: flags.domain,
    output: { format: flags.output },
    ...(flags.subject ? { subject: flags.subject } : {}),
    ...(modelFilter.length ? { modelFilter: modelFilter as import("../types.js").AgentId[] } : {}),
  };

  const msg = await buildMessage({
    from: flags.from,
    to: "claude",
    type: "task",
    skill: flags.skill!,
    payload,
    priority: flags.priority,
    ttl: flags.ttl,
    thread: flags.thread,
  });

  const filename = wireFilename(msg);
  const outPath = join(inboxDir, filename);
  writeFileSync(outPath, serializeMessage(msg), { encoding: "utf8", mode: 0o644 });

  console.log(`Task queued: ${outPath}`);
  console.log(`  ${flags.from} → ${flags.to!}  [${flags.skill!}/${flags.verb!}]${flags.subject ? `  "${flags.subject}"` : ""}`);
  console.log(`  id: ${msg.id}`);
}
