#!/usr/bin/env bun
// Wire Gateway — HTTP server that lets all agents send/receive WireProtocol v1 messages
// without running the wire CLI directly. The gateway holds all private keys and signs
// on behalf of the requesting agent (after token authentication).
//
// Usage: bun run src/gateway/server.ts [--port 31338]
// Or:    bun run wire-gateway

import { GatewayAuth } from "./auth.js";
import { AGENT_IDS } from "../types.js";
import {
  handleHealth,
  handleSend,
  handleInbox,
  handleLegacyInbox,
  handleKeygen,
  handleAgentCard,
  type GatewayContext,
} from "./routes.js";
import { handleComplete } from "./complete.js";
import { CronDaemon } from "../cron/CronDaemon.js";
// ISS-031: sourced from config/paths.ts. The gateway is a second front door
// onto the same physical inbox the dispatch daemon watches (handleSend
// writes into it, handleInbox reads from it) — an independent copy here was
// a 4th place this exact value could silently drift, the same bug class as
// ISS-026.
import { KEYS_DIR, STATE_DIR, INBOX_DIR } from "../config/paths.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const portArg = process.argv.indexOf("--port");
const PORT = portArg !== -1 ? parseInt(process.argv[portArg + 1] ?? "31338", 10) : 31338;

// ─── Build context (shared across requests) ───────────────────────────────────

let ctx: GatewayContext;
try {
  const auth = new GatewayAuth(KEYS_DIR);
  ctx = { keysDir: KEYS_DIR, stateDir: STATE_DIR, inboxDir: INBOX_DIR, auth };
} catch (e) {
  console.error(`Gateway startup failed: ${e instanceof Error ? e.message : e}`);
  console.error("Run: bun run scripts/bootstrap.ts");
  process.exit(1);
}

// ─── Request router ───────────────────────────────────────────────────────────

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS headers for potential future web clients (local only)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "http://localhost",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Agent-Id, X-Agent-Token, Authorization, X-Force",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let response: Response;

  if (method === "GET" && path === "/.well-known/agent.json") {
    response = handleAgentCard();
  } else if (method === "GET" && path === "/health") {
    response = handleHealth(req, ctx);
  } else if (method === "POST" && path === "/send") {
    response = await handleSend(req, ctx);
  } else if (method === "GET" && path.startsWith("/inbox/")) {
    const parts = path.split("/").filter(Boolean);
    const agentId = parts[1] ?? "";
    const sub = parts[2];
    if (sub === "legacy") {
      response = handleLegacyInbox(req, agentId, ctx);
    } else {
      response = handleInbox(req, agentId, ctx);
    }
  } else if (method === "POST" && path.startsWith("/keygen/")) {
    const agentId = path.split("/").filter(Boolean)[1] ?? "";
    response = await handleKeygen(req, agentId, ctx);
  } else if (method === "POST" && path === "/complete") {
    response = await handleComplete(req);
  } else {
    response = new Response(JSON.stringify({
      ok: false,
      error: "Not found",
    }), { status: 404, headers: { "Content-Type": "application/json" } });
  }

  // Attach CORS headers to all responses
  for (const [k, v] of Object.entries(corsHeaders)) {
    response.headers.set(k, v);
  }
  return response;
}

// ─── Start server ─────────────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  maxRequestBodySize: 1 * 1024 * 1024, // 1MB — above any valid Wire message; prevents unauthenticated body DoS
  fetch: route,
});

console.log(`Wire Gateway v1 running on http://127.0.0.1:${server.port}`);
console.log(`Inbox:    ${INBOX_DIR}`);
console.log(`Keys:     ${KEYS_DIR}`);
console.log(`Agents:   ${AGENT_IDS.join(", ")}`);
console.log("");
console.log("Endpoints:");
console.log("  GET  /.well-known/agent.json  (A2A Agent Card)");
console.log("  GET  /health");
console.log("  POST /send");
console.log("  GET  /inbox/:agentId");
console.log("  GET  /inbox/:agentId/legacy");
console.log("  POST /keygen/:agentId  (admin)");
console.log("  POST /complete  (generic LLM completion, X-API-Key auth — external projects)");
console.log("");
console.log("Press Ctrl+C to stop.");

// ─── Cron daemon ──────────────────────────────────────────────────────────────

const cronDaemon = new CronDaemon({ stateDir: STATE_DIR, inboxDir: INBOX_DIR });
cronDaemon.start();
console.log("[cron] scheduler started (60s poll)");

const shutdown = () => {
  cronDaemon.stop();
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
