import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMessage, serializeMessage, wireFilename } from "../envelope/encode.js";
import { validatePayload } from "../schema/validator.js";
import type { AgentId, MessageType, SkillType, Priority } from "../types.js";

// ─── Parse CLI flags ─────────────────────────────────────────────────────────

interface SendFlags {
  from?: AgentId;
  to?: AgentId;
  type?: MessageType;
  skill?: SkillType;
  ttl?: number;
  thread?: string;
  priority?: Priority;
}

function parseFlags(args: string[]): SendFlags {
  const flags: SendFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    switch (a) {
      case "--from":    flags.from = next as AgentId; i++; break;
      case "--to":      flags.to = next as AgentId; i++; break;
      case "--type":    flags.type = next as MessageType; i++; break;
      case "--skill":   flags.skill = next as SkillType; i++; break;
      case "--ttl":     flags.ttl = parseInt(next ?? "3600", 10); i++; break;
      case "--thread":  flags.thread = next; i++; break;
      case "--priority": flags.priority = parseInt(next ?? "3", 10) as Priority; i++; break;
    }
  }
  return flags;
}

// ─── send subcommand ─────────────────────────────────────────────────────────

export async function runSend(
  args: string[],
  _keysDir: string,
  _stateDir: string,
  inboxDir: string
): Promise<void> {
  const flags = parseFlags(args);

  const missing: string[] = [];
  if (!flags.from) missing.push("--from");
  if (!flags.to) missing.push("--to");
  if (!flags.type) missing.push("--type");
  if (!flags.skill) missing.push("--skill");

  if (missing.length > 0) {
    console.error(`Missing required flags: ${missing.join(", ")}`);
    console.error("Usage: wire send --from <id> --to <id> --type <type> --skill <skill> [--ttl <s>]");
    console.error("Reads WireSpec payload JSON from stdin.");
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const stdinText = Buffer.concat(chunks).toString("utf8").trim();

  if (!stdinText) {
    console.error("No payload provided. Pipe WireSpec JSON to stdin.");
    process.exit(1);
  }

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(stdinText);
  } catch {
    console.error("stdin is not valid JSON");
    process.exit(1);
  }

  const payloadResult = validatePayload(rawPayload);
  if (!payloadResult.ok) {
    console.error("Payload schema validation failed:");
    for (const e of payloadResult.errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const msg = await buildMessage({
    from: flags.from!,
    to: flags.to!,
    type: flags.type!,
    skill: flags.skill!,
    payload: payloadResult.data,
    priority: flags.priority,
    ttl: flags.ttl,
    thread: flags.thread,
  });

  const filename = wireFilename(msg);
  const outPath = join(inboxDir, filename);
  writeFileSync(outPath, serializeMessage(msg), { encoding: "utf8", mode: 0o644 });

  console.log(`Message written: ${outPath}`);
  console.log(`  id:       ${msg.id}`);
  console.log(`  from→to:  ${msg.from} → ${msg.to}`);
  console.log(`  type:     ${msg.type} / ${msg.skill}`);
  console.log(`  ttl:      ${msg.ttl}s`);

  // ISS-030: wire send addresses the envelope directly to whatever agent
  // --to names, the same pattern ISS-027 fixed for wire ask/wire task —
  // except this command is a deliberately low-level, arbitrary-message
  // protocol utility, not a "dispatch work and get an answer" convenience
  // command, so the fix there (always address "claude", route via
  // modelFilter) doesn't apply here. DispatchLoop's inbox watcher only ever
  // processes messages with to==="claude" (loop.ts's processFile()) — a
  // task-type message addressed to anything else will sit unprocessed with
  // no automatic consumer, which was exactly ISS-027's failure mode.
  if (msg.to !== "claude" && msg.type === "task") {
    console.warn(
      `\n[wire send] Warning: this task message is addressed to "${msg.to}", not "claude".\n` +
      `  The dispatch daemon only automatically processes messages addressed to "claude" (loop.ts processFile()).\n` +
      `  "wire agent pickup" does NOT read this — it only consumes .md handoff files, never .wire.json.\n` +
      `  Nothing currently consumes a task message addressed directly to another agent; it will sit\n` +
      `  in the inbox indefinitely. Use "wire task --to ${msg.to} ..." instead — it addresses "claude"\n` +
      `  and routes via modelFilter, so the dispatch daemon actually picks it up.`
    );
  }
}
