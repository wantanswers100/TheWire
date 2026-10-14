// HMAC and Ed25519 signature verification has moved to a separate crypto package.

export async function runVerify(_args: string[], _keysDir?: string, _stateDir?: string): Promise<void> {
  console.log("Signature verification is no longer part of agent-wire.");
  console.log("Signature verification is not part of Wire (it moved to a separate crypto package in Phase 43).");
  process.exit(0);
}
