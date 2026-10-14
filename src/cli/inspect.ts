import { readFileSync } from "node:fs";
import { parseWireFile } from "../envelope/decode.js";

// inspect: human-readable dump of a .wire.json file.
// No crypto operations — safe to run on any file, including ones with invalid signatures.

export async function runInspect(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith("--"));

  if (!filePath) {
    console.error("Usage: wire inspect <file.wire.json>");
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

  if (typeof raw !== "object" || raw === null) {
    console.error("File is not a JSON object");
    process.exit(1);
  }

  const m = raw as Record<string, unknown>;

  console.log("=== Wire Inspect ===");
  console.log(`File:      ${filePath}`);
  console.log(`Protocol:  wire v${m["wire"] ?? "unknown"}`);
  console.log(`ID:        ${m["id"] ?? "missing"}`);
  console.log(`From:      ${m["from"] ?? "missing"}`);
  console.log(`To:        ${m["to"] ?? "missing"}`);
  if (m["thread"]) console.log(`Thread:    ${m["thread"]}`);
  console.log(`Type:      ${m["type"] ?? "missing"}`);
  console.log(`Skill:     ${m["skill"] ?? "missing"}`);
  console.log(`Priority:  ${m["priority"] ?? "missing"}`);

  const ts = typeof m["ts"] === "number" ? m["ts"] : null;
  const ttl = typeof m["ttl"] === "number" ? m["ttl"] : null;
  console.log(`Timestamp: ${ts ? new Date(ts).toISOString() : "missing"}`);
  console.log(`TTL:       ${ttl !== null ? `${ttl}s` : "missing"}`);
  if (ts !== null && ttl !== null) {
    const expiry = new Date(ts + ttl * 1000);
    const expired = Date.now() > ts + ttl * 1000;
    console.log(`Expires:   ${expiry.toISOString()} ${expired ? "(EXPIRED)" : "(valid)"}`);
  }

  console.log(`Nonce:     ${m["nonce"] ?? "missing"}`);
  console.log(`Encrypted: ${m["enc"] ?? "missing"}`);

  if (m["ctx"]) console.log(`Ctx:       ${m["ctx"]}`);
  if (Array.isArray(m["depends"]) && m["depends"].length > 0) {
    console.log(`Depends:   ${(m["depends"] as string[]).join(", ")}`);
  }

  console.log(`\nHMAC:      ${typeof m["hmac"] === "string" ? m["hmac"].slice(0, 16) + "..." : "missing"}`);
  console.log(`Sig:       ${typeof m["sig"] === "string" ? m["sig"].slice(0, 16) + "..." : "missing"}`);

  console.log("\n=== Payload ===");
  if (m["enc"] === true) {
    console.log("(encrypted — run 'wire recv' to decrypt)");
    const p = m["payload"] as Record<string, unknown> | undefined;
    if (p) {
      console.log(`  iv:         ${p["iv"] ?? "missing"}`);
      console.log(`  tag:        ${p["tag"] ?? "missing"}`);
      console.log(`  ciphertext: ${typeof p["ciphertext"] === "string" ? `${String(p["ciphertext"]).slice(0, 20)}... (${String(p["ciphertext"]).length} chars)` : "missing"}`);
    }
  } else {
    console.log(JSON.stringify(m["payload"], null, 2));
  }
}
