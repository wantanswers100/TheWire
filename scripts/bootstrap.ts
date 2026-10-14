#!/usr/bin/env bun
// Bootstrap: generate all agent keypairs + gateway tokens in one shot.
// Run once to initialize the key store before any agents can communicate.
//
// Usage: bun run scripts/bootstrap.ts [--force]
//   --force  overwrite existing keys (dangerous — invalidates all prior signed messages)
//
// Phase 50 repair: this script imported `../src/crypto/keygen.js`, which was
// deleted in Phase 43 when the crypto layer moved to a separate crypto package.
// `bun run bootstrap` had therefore been dead since then — while
// src/startup/index.ts and src/startup/watch.ts both still tell the user to
// run it when a gateway token is missing, making the documented recovery path
// a crash. It went unnoticed because tsconfig's `include` omitted scripts/,
// so nothing typechecked this file. Both are fixed in Phase 50.
//
// Keypair generation now delegates to runKeygen() in src/cli/keygen.ts — the
// implementation Phase 47 inlined from the separate crypto package — instead of
// keeping a second copy here. HMAC key generation was dropped: agent-wire
// envelopes have been unsigned since Phase 43 and nothing under src/ reads
// .keys/wire.hmac.key, so it was writing a credential no code consumed.

import { existsSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { runKeygen } from "../src/cli/keygen.js";
import { AGENT_IDS } from "../src/types.js";

const PROJECT_ROOT = join(import.meta.dir, "..");
const KEYS_DIR = join(PROJECT_ROOT, ".keys");
const STATE_DIR = join(PROJECT_ROOT, ".wire-state");

const FORCE = process.argv.includes("--force");

// ─── Setup dirs ──────────────────────────────────────────────────────────────

mkdirSync(KEYS_DIR, { recursive: true });
chmodSync(KEYS_DIR, 0o700);
mkdirSync(STATE_DIR, { recursive: true });
chmodSync(STATE_DIR, 0o700);

// ─── Generate keypairs ────────────────────────────────────────────────────────

console.log("\n=== agent-wire bootstrap ===\n");
console.log("Generating keypairs for all agents...\n");

for (const agentId of AGENT_IDS) {
  const skPath = join(KEYS_DIR, `${agentId}.ed25519.sk`);
  if (existsSync(skPath) && !FORCE) {
    console.log(`  ${agentId.padEnd(8)} — SKIP (keys exist, use --force to regenerate)`);
    continue;
  }
  // runKeygen writes ed25519 + x25519 keypairs and logs its own confirmation.
  await runKeygen([agentId], KEYS_DIR);
}

// ─── Gateway tokens ───────────────────────────────────────────────────────────
// One token per agent. Used by the gateway to authenticate who is sending.
// Stored in .keys/gateway-tokens.json (mode 600).

const tokenPath = join(KEYS_DIR, "gateway-tokens.json");
let tokens: Record<string, string> = {};

if (existsSync(tokenPath) && !FORCE) {
  // Read via readFileSync rather than a JSON import: an import is cached for
  // the process lifetime and resolves relative to the module graph, which
  // makes it fragile for a runtime-located path outside the project tree.
  tokens = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, string>;
  console.log("\n  gateway-tokens.json — SKIP (exists)");
} else {
  for (const agentId of AGENT_IDS) {
    tokens[agentId] = randomBytes(32).toString("hex");
  }
  // Admin token for gateway management endpoints
  tokens["admin"] = randomBytes(32).toString("hex");

  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { encoding: "utf8", mode: 0o600 });
  console.log("\n  gateway-tokens.json — OK  (per-agent + admin tokens)");
}

// ─── Gateway config ───────────────────────────────────────────────────────────

const configPath = join(KEYS_DIR, "gateway-config.json");
const gatewayConfig = {
  port: 31338,
  inboxDir: join(process.env["HOME"] ?? homedir(), "projects", "inbox"),
  keysDir: KEYS_DIR,
  stateDir: STATE_DIR,
};
writeFileSync(configPath, JSON.stringify(gatewayConfig, null, 2), { encoding: "utf8", mode: 0o600 });
console.log("  gateway-config.json — OK");

// ─── Summary report ───────────────────────────────────────────────────────────

console.log("\n=== Key store contents ===\n");
console.log(`Directory: ${KEYS_DIR}`);
console.log("");

for (const agentId of AGENT_IDS) {
  const hasSk = existsSync(join(KEYS_DIR, `${agentId}.ed25519.sk`));
  const hasPk = existsSync(join(KEYS_DIR, `${agentId}.ed25519.pk`));
  const hasX = existsSync(join(KEYS_DIR, `${agentId}.x25519.sk`));
  console.log(`  ${agentId.padEnd(8)}  ed25519.sk=${hasSk ? "YES" : "NO"}  ed25519.pk=${hasPk ? "YES" : "NO"}  x25519=${hasX ? "YES" : "NO"}`);
}

// Tokens are printed truncated — never in full — so a shared terminal or a
// pasted log can't leak a working gateway credential.
console.log("\n=== Gateway tokens ===\n");
for (const [agent, token] of Object.entries(tokens)) {
  console.log(`  ${agent.padEnd(8)}  ${token.slice(0, 8)}...${token.slice(-4)}`);
}

console.log("\n=== Next steps ===\n");
console.log("1. Start the gateway:    bun run wire-gateway");
console.log("2. Test it:              curl http://localhost:31338/health");
console.log("3. Gemini adapter:       adapters/gemini.sh (reads token from env)");
