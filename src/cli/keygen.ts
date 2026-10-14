// wire keygen — generate Ed25519 + X25519 keypairs for a named agent.
//
// Inlined from the separate crypto package (Phase 47) so agent-wire has no local path
// dependency in package.json and CI can install cleanly. Uses node:crypto only.

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface GeneratedKeyPair {
  ed25519PrivateKeyPem: string;
  ed25519PublicKeyPem: string;
  x25519PrivateKeyPem: string;
  x25519PublicKeyPem: string;
}

function generateAgentKeyPair(): GeneratedKeyPair {
  const ed = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const x25519 = generateKeyPairSync("x25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return {
    ed25519PrivateKeyPem: ed.privateKey as string,
    ed25519PublicKeyPem: ed.publicKey as string,
    x25519PrivateKeyPem: x25519.privateKey as string,
    x25519PublicKeyPem: x25519.publicKey as string,
  };
}

function writeKeyPair(keysDir: string, agentId: string, kp: GeneratedKeyPair): void {
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  const write = (name: string, content: string, mode: number) =>
    writeFileSync(join(keysDir, name), content, { encoding: "utf8", mode });
  write(`${agentId}.ed25519.sk`, kp.ed25519PrivateKeyPem, 0o600);
  write(`${agentId}.x25519.sk`, kp.x25519PrivateKeyPem, 0o600);
  write(`${agentId}.ed25519.pk`, kp.ed25519PublicKeyPem, 0o644);
  write(`${agentId}.x25519.pk`, kp.x25519PublicKeyPem, 0o644);
}

export async function runKeygen(args: string[], keysDir?: string): Promise<void> {
  const agentId = args[0] ?? "agent";
  const dir = keysDir ?? ".keys";
  const kp = generateAgentKeyPair();
  writeKeyPair(dir, agentId, kp);
  console.log(`Key pair written to ${dir}/${agentId}.{ed25519,x25519}.{sk,pk}`);
}
