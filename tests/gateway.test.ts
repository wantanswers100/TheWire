import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GatewayAuth, extractToken, extractAgentId } from "../src/gateway/auth.js";
import { GatewayContext } from "../src/gateway/routes.js";
import { handleHealth, handleSend, handleInbox } from "../src/gateway/routes.js";
import { randomBytes } from "node:crypto";

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeDirs(): { keysDir: string; stateDir: string; inboxDir: string } {
  const base = mkdtempSync(join(tmpdir(), "wire-gw-test-"));
  const keysDir = join(base, ".keys");
  const stateDir = join(base, ".wire-state");
  const inboxDir = join(base, "inbox");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(inboxDir, { recursive: true });
  return { keysDir, stateDir, inboxDir };
}

function makeTokens(keysDir: string): Record<string, string> {
  const agents = ["claude", "gemini", "codex", "ollama", "system"];
  const tokens: Record<string, string> = {};
  for (const a of agents) tokens[a] = randomBytes(32).toString("hex");
  tokens["admin"] = randomBytes(32).toString("hex");
  writeFileSync(join(keysDir, "gateway-tokens.json"), JSON.stringify(tokens), {
    encoding: "utf8",
    mode: 0o600,
  });
  return tokens;
}

function makeContext(dirs: ReturnType<typeof makeDirs>, tokens: Record<string, string>): GatewayContext {
  void tokens; // tokens already written to keysDir by makeTokens
  const auth = new GatewayAuth(dirs.keysDir);
  return { keysDir: dirs.keysDir, stateDir: dirs.stateDir, inboxDir: dirs.inboxDir, auth };
}

// ─── GatewayAuth ─────────────────────────────────────────────────────────────

describe("GatewayAuth", () => {
  test("verifies correct agent + token", () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const auth = new GatewayAuth(dirs.keysDir);
    expect(auth.verifyAgent("claude", tokens["claude"]!)).toBe(true);
    expect(auth.verifyAgent("gemini", tokens["gemini"]!)).toBe(true);
  });

  test("rejects wrong token", () => {
    const dirs = makeDirs();
    makeTokens(dirs.keysDir);
    const auth = new GatewayAuth(dirs.keysDir);
    expect(auth.verifyAgent("claude", "wrongtoken")).toBe(false);
  });

  test("rejects unknown agent", () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const auth = new GatewayAuth(dirs.keysDir);
    expect(auth.verifyAgent("unknown-bot", tokens["claude"]!)).toBe(false);
  });

  test("verifies admin token", () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const auth = new GatewayAuth(dirs.keysDir);
    expect(auth.verifyAdmin(tokens["admin"]!)).toBe(true);
    expect(auth.verifyAdmin("wrongadmin")).toBe(false);
  });
});

// ─── Route: /health ───────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("unauthenticated: returns ok without agent list", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/health");
    const res = handleHealth(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["version"]).toBe("1");
    expect(body["agents"]).toBeUndefined();
  });

  test("authenticated: returns ok with agent list", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const claudeToken = tokens["claude"];
    const req = new Request("http://localhost:31338/health", {
      headers: { "X-Agent-Id": "claude", "X-Agent-Token": claudeToken ?? "" },
    });
    const res = handleHealth(req, ctx);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["version"]).toBe("1");
    expect(Array.isArray(body["agents"])).toBe(true);
  });
});

// ─── Route: POST /send ────────────────────────────────────────────────────────

describe("POST /send", () => {
  test("rejects missing auth", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-Id": "gemini", "X-Agent-Token": "badtoken" },
      body: JSON.stringify({ to: "claude", type: "task", skill: "research", payload: { format: "ping" } }),
    });

    const res = await handleSend(req, ctx);
    expect(res.status).toBe(401);
  });

  test("rejects invalid payload schema", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "gemini",
        "X-Agent-Token": tokens["gemini"]!,
      },
      body: JSON.stringify({
        to: "claude",
        type: "task",
        skill: "research",
        payload: { format: "task" }, // missing verb, domain, output
      }),
    });

    const res = await handleSend(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(false);
    expect(String(body["error"])).toContain("schema invalid");
  });

  test("sends valid message and writes to inbox", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "gemini",
        "X-Agent-Token": tokens["gemini"]!,
      },
      body: JSON.stringify({
        to: "claude",
        type: "task",
        skill: "research",
        payload: {
          format: "task",
          verb: "query",
          domain: ["python"],
          output: { format: "structured" },
        },
      }),
    });

    const res = await handleSend(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(typeof body["messageId"]).toBe("string");
    expect(body["from"]).toBe("gemini");
    expect(body["to"]).toBe("claude");

    const filename = body["filename"] as string;
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dirs.inboxDir, filename))).toBe(true);
  });
});

// ─── Route: GET /inbox/:agentId ───────────────────────────────────────────────

describe("GET /inbox/:agentId", () => {
  test("rejects bad token", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/inbox/claude", {
      headers: { "X-Agent-Token": "badtoken", "X-Agent-Id": "claude" },
    });
    const res = handleInbox(req, "claude", ctx);
    expect(res.status).toBe(401);
  });

  test("returns messages after send", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const sendReq = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "gemini",
        "X-Agent-Token": tokens["gemini"]!,
      },
      body: JSON.stringify({
        to: "claude",
        type: "task",
        skill: "research",
        payload: { format: "task", verb: "query", domain: ["sqlite"], output: { format: "json" } },
      }),
    });
    const sendRes = await handleSend(sendReq, ctx);
    expect(sendRes.status).toBe(200);

    const recvReq = new Request("http://localhost:31338/inbox/claude", {
      headers: { "X-Agent-Token": tokens["claude"]!, "X-Agent-Id": "claude" },
    });
    const recvRes = handleInbox(recvReq, "claude", ctx);
    expect(recvRes.status).toBe(200);

    const body = await recvRes.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["count"]).toBe(1);
    const messages = body["messages"] as unknown[];
    expect(messages.length).toBe(1);
    expect((messages[0] as Record<string, unknown>)["from"]).toBe("gemini");
  });
});

describe("ISS-009: gateway error oracle — detail strings omitted from inbox errors", () => {
  test("decode error response has code but no detail field", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const { writeFileSync: wf } = await import("node:fs");
    const { join: j } = await import("node:path");
    wf(j(dirs.inboxDir, "claude_gemini_20260101000000_deadbeef.wire.json"), JSON.stringify({ garbage: true, to: "claude" }), "utf8");

    const recvReq = new Request("http://localhost:31338/inbox/claude", {
      headers: { "X-Agent-Token": tokens["claude"]!, "X-Agent-Id": "claude" },
    });
    const recvRes = handleInbox(recvReq, "claude", ctx);
    expect(recvRes.status).toBe(200);
    const body = await recvRes.json() as Record<string, unknown>;
    const errors = body["errors"] as Record<string, unknown>[];
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toHaveProperty("code");
    expect(errors[0]).not.toHaveProperty("detail");
  });
});

describe("ISS-010: handleSend rejects malformed thread/depends before writing to disk", () => {
  test("malformed thread UUID is rejected with 400", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "gemini",
        "X-Agent-Token": tokens["gemini"]!,
      },
      body: JSON.stringify({
        to: "claude",
        type: "task",
        skill: "research",
        payload: { format: "task", verb: "query", domain: ["test"], output: { format: "json" } },
        thread: "not-a-uuid",
      }),
    });
    const res = await handleSend(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect((body["error"] as string).toLowerCase()).toContain("thread");
  });

  test("valid thread UUID v4 is accepted", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "gemini",
        "X-Agent-Token": tokens["gemini"]!,
      },
      body: JSON.stringify({
        to: "claude",
        type: "task",
        skill: "research",
        payload: { format: "task", verb: "query", domain: ["test"], output: { format: "json" } },
        thread: "550e8400-e29b-41d4-a716-446655440000",
      }),
    });
    const res = await handleSend(req, ctx);
    expect(res.status).toBe(200);
  });
});

describe("ISS-013: unknown agentId rejected at handleInbox", () => {
  test("unknown agentId returns 400 from handleInbox", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/inbox/unknownbot", {
      method: "GET",
      headers: { "X-Agent-Token": tokens["claude"]! },
    });
    const res = await handleInbox(req, "unknownbot", ctx);
    expect(res.status).toBe(400);
  });
});

describe("ISS-015: key_rotation payload requires skill=wire", () => {
  test("key_rotation payload with non-wire skill returns 400", async () => {
    const dirs = makeDirs();
    const tokens = makeTokens(dirs.keysDir);
    const ctx = makeContext(dirs, tokens);

    const req = new Request("http://localhost:31338/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": "gemini",
        "X-Agent-Token": tokens["gemini"]!,
      },
      body: JSON.stringify({
        to: "claude",
        type: "task",
        skill: "research", // wrong — must be "wire"
        payload: {
          format: "key_rotation",
          agentId: "claude",
          newEd25519Pk: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAtest\n-----END PUBLIC KEY-----",
          newX25519Pk: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEAtest\n-----END PUBLIC KEY-----",
          rotationTs: Date.now(),
          rotationValidUntil: Date.now() + 3_600_000,
          continuitySignature: "A".repeat(86),
        },
      }),
    });
    const res = await handleSend(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect((body["error"] as string).toLowerCase()).toContain("skill");
  });
});
