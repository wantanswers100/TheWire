import { readFileSync } from "node:fs";
import { decodeMessage, parseWireFile } from "../envelope/decode.js";
import type { AgentId } from "../types.js";

export async function runRecv(
  args: string[],
  _keysDir: string,
  _stateDir: string
): Promise<void> {
  const filePath = args.find((a) => !a.startsWith("--"));
  const asIdx = args.indexOf("--as");
  const recipientId: AgentId =
    asIdx !== -1 ? (args[asIdx + 1] as AgentId) : "claude";

  if (!filePath) {
    console.error("Usage: wire recv <file.wire.json> [--as <agentId>]");
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    console.error(`Cannot read file: ${filePath}`);
    process.exit(1);
  }

  const raw = parseWireFile(content);
  if (raw === null) {
    console.error("File is not valid JSON");
    process.exit(1);
  }

  const result = decodeMessage(raw, recipientId);

  if (!result.ok) {
    console.error(`Decode failed [${result.code}]: ${result.detail}`);
    process.exit(1);
  }

  const { message: msg, payload } = result;

  console.log("=== WireProtocol v1 Message ===");
  console.log(`id:       ${msg.id}`);
  console.log(`from:     ${msg.from}`);
  console.log(`to:       ${msg.to}`);
  if (msg.thread) console.log(`thread:   ${msg.thread}`);
  console.log(`type:     ${msg.type}`);
  console.log(`skill:    ${msg.skill}`);
  console.log(`priority: ${msg.priority}`);
  console.log(`ts:       ${new Date(msg.ts).toISOString()}`);
  console.log(`ttl:      ${msg.ttl}s`);
  console.log(`enc:      ${msg.enc}`);
  console.log("");
  console.log("=== Payload ===");
  console.log(JSON.stringify(payload, null, 2));
}
