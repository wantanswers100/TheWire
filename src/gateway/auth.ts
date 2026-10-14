import { readFileSync, existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { AgentId } from "../types.js";
import { AGENT_IDS } from "../types.js";

// Gateway token store: .keys/gateway-tokens.json
// Maps agentId → 64-char hex token (32 bytes random).
// Constant-time comparison to prevent timing attacks.

export class GatewayAuth {
  private readonly tokens: Record<string, string>;

  constructor(keysDir: string) {
    const tokenPath = join(keysDir, "gateway-tokens.json");
    if (!existsSync(tokenPath)) {
      throw new Error(`Gateway tokens not found at ${tokenPath} — run 'bun run scripts/bootstrap.ts' first`);
    }
    const raw = JSON.parse(readFileSync(tokenPath, "utf8")) as Record<string, string>;
    // Validate every token is a 64-char hex string (32 bytes) at load time
    const HEX64 = /^[0-9a-f]{64}$/;
    for (const [id, tok] of Object.entries(raw)) {
      if (!HEX64.test(tok)) {
        throw new Error(`CRITICAL: token for '${id}' in gateway-tokens.json is malformed — re-run bootstrap`);
      }
    }
    this.tokens = raw;
  }

  // Verify an agent's token. Returns true only if agentId is valid and token matches.
  verifyAgent(agentId: string, token: string): agentId is AgentId {
    if (!AGENT_IDS.includes(agentId as AgentId)) return false;
    const expected = this.tokens[agentId];
    if (!expected) return false;
    // Use timingSafeEqual — Buffer.equals() short-circuits and leaks timing info
    const tokenBuf = Buffer.from(token, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (tokenBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(tokenBuf, expectedBuf);
  }

  // Verify admin token (for /keygen endpoint).
  verifyAdmin(token: string): boolean {
    const expected = this.tokens["admin"];
    if (!expected) return false;
    const tokenBuf = Buffer.from(token, "utf8");
    const expectedBuf = Buffer.from(expected, "utf8");
    if (tokenBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(tokenBuf, expectedBuf);
  }

  // Read a single agent's token (for displaying during bootstrap).
  getToken(agentId: AgentId): string {
    return this.tokens[agentId] ?? "";
  }
}

// Extract token from request: X-Agent-Token header or Authorization: Bearer header only.
// Query-parameter fallback (?token=) was intentionally removed — tokens in query params
// appear verbatim in HTTP access logs, reverse-proxy logs, and Referer headers.
// All callers must send tokens via header.
export function extractToken(req: Request): string {
  return req.headers.get("x-agent-token") ?? req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
}

// Extract agentId from X-Agent-Id header.
export function extractAgentId(req: Request): string {
  return req.headers.get("x-agent-id") ?? "";
}
