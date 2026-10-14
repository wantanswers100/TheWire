import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { GatewayAuth, extractToken, extractAgentId } from "./auth.js";
import { buildMessage, serializeMessage, wireFilename } from "../envelope/encode.js";
import { decodeMessage, parseWireFile } from "../envelope/decode.js";
import { validatePayload } from "../schema/validator.js";
import { AgentIdSchema, MessageTypeSchema, SkillTypeSchema, PrioritySchema } from "../schema/wirespec.js";
import { isWireFile, isLegacyFile, parseLegacyHandoff } from "../dispatch/legacy.js";
import type { AgentId, MessageType, SkillType, Priority, WirePayload } from "../types.js";
import { AGENT_IDS } from "../types.js";

export interface GatewayContext {
  keysDir: string;
  stateDir: string;
  inboxDir: string;
  auth: GatewayAuth;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

// ─── GET /.well-known/agent.json — A2A Agent Card ────────────────────────────

const AGENT_CARD_PATH = join(import.meta.dir, "../../docs/a2a-agent-card.json");

export function handleAgentCard(): Response {
  if (!existsSync(AGENT_CARD_PATH)) {
    return new Response(JSON.stringify({ ok: false, error: "Agent card not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const card = readFileSync(AGENT_CARD_PATH, "utf8");
  return new Response(card, {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── GET /health ──────────────────────────────────────────────────────────────
// Auth-gated: requires any valid agent token. Strips agent enumeration from
// the response when called without auth (returns minimal liveness signal only).

export function handleHealth(req: Request, ctx: GatewayContext): Response {
  const token = extractToken(req);
  const agentId = extractAgentId(req);
  const authenticated = token && ctx.auth.verifyAgent(agentId, token);
  if (authenticated) {
    return json({
      ok: true,
      version: "1",
      protocol: "WireProtocol v1",
      agents: AGENT_IDS,
    });
  }
  // Unauthenticated: return liveness only — no agent enumeration.
  return json({ ok: true, version: "1", protocol: "WireProtocol v1" });
}

// ─── POST /send ───────────────────────────────────────────────────────────────

export async function handleSend(req: Request, ctx: GatewayContext): Promise<Response> {
  const agentId = extractAgentId(req);
  const token = extractToken(req);

  if (!ctx.auth.verifyAgent(agentId, token)) {
    return err("Unauthorized: invalid agent ID or token", 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return err("Request body must be valid JSON");
  }

  const { to, type, skill, payload, ttl, thread, priority, depends } = body;

  if (!to || !type || !skill || !payload) {
    return err("Missing required fields: to, type, skill, payload");
  }

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (thread !== undefined && (typeof thread !== "string" || !UUID_V4.test(thread))) {
    return err("'thread' must be a valid UUID v4");
  }
  if (depends !== undefined) {
    if (!Array.isArray(depends)) return err("'depends' must be an array of UUID v4 strings");
    const badDep = (depends as unknown[]).find((d) => typeof d !== "string" || !UUID_V4.test(d as string));
    if (badDep !== undefined) return err(`'depends' contains invalid UUID: ${String(badDep)}`);
  }

  const toResult = AgentIdSchema.safeParse(to);
  if (!toResult.success) return err(`Invalid 'to': ${toResult.error.issues[0]?.message ?? "unknown"}`);

  const typeResult = MessageTypeSchema.safeParse(type);
  if (!typeResult.success) return err(`Invalid 'type': ${typeResult.error.issues[0]?.message ?? "unknown"}`);

  const skillResult = SkillTypeSchema.safeParse(skill);
  if (!skillResult.success) return err(`Invalid 'skill': ${skillResult.error.issues[0]?.message ?? "unknown"}`);

  const priorityResult = PrioritySchema.safeParse(typeof priority === "number" ? priority : 3);
  if (!priorityResult.success) return err(`Invalid 'priority': must be 1–4`);

  const payloadResult = validatePayload(payload);
  if (!payloadResult.ok) {
    return err(`Payload schema invalid: ${payloadResult.errors.join("; ")}`);
  }

  if ((payloadResult.data as unknown as Record<string, unknown>)["format"] === "key_rotation" && skillResult.data !== "wire") {
    return err("key_rotation payloads must use skill: 'wire'");
  }

  let msg;
  try {
    msg = await buildMessage({
      from: agentId as AgentId,
      to: toResult.data,
      type: typeResult.data,
      skill: skillResult.data,
      payload: payloadResult.data,
      ttl: typeof ttl === "number" ? ttl : 3600,
      thread: typeof thread === "string" ? thread : undefined,
      priority: priorityResult.data,
      depends: Array.isArray(depends) ? depends as string[] : undefined,
    });
  } catch (e) {
    console.error("[gateway/send] buildMessage failed:", e);
    return err("Failed to build message: internal error", 500);
  }

  const filename = wireFilename(msg);
  const filepath = join(ctx.inboxDir, filename);

  try {
    writeFileSync(filepath, serializeMessage(msg), { encoding: "utf8", mode: 0o644 });
  } catch (e) {
    console.error("[gateway/send] inbox write failed:", e);
    return err("Failed to write to inbox: storage error", 500);
  }

  return json({
    ok: true,
    messageId: msg.id,
    filename,
    from: msg.from,
    to: msg.to,
    type: msg.type,
    skill: msg.skill,
    enc: msg.enc,
  });
}

// ─── GET /inbox/:agentId ──────────────────────────────────────────────────────

export function handleInbox(req: Request, agentId: string, ctx: GatewayContext): Response {
  const token = extractToken(req);
  if (!AGENT_IDS.includes(agentId as AgentId)) return err(`Unknown agent ID: ${agentId}`, 400);
  if (!ctx.auth.verifyAgent(agentId, token)) {
    return err("Unauthorized", 401);
  }

  let entries: string[];
  try {
    entries = readdirSync(ctx.inboxDir);
  } catch {
    return err("Cannot read inbox directory", 500);
  }

  const messages: unknown[] = [];
  const errors: unknown[] = [];

  for (const filename of entries.sort()) {
    if (!isWireFile(filename)) continue;
    const filepath = join(ctx.inboxDir, filename);

    try {
      if (!statSync(filepath).isFile()) continue;
    } catch (e) {
      console.error(`[gateway/inbox] stat failed for ${filename}:`, e);
      errors.push({ filename, error: "stat failed" });
      continue;
    }

    const content = readFileSync(filepath, "utf8");
    const raw = parseWireFile(content);
    if (!raw) { errors.push({ filename, error: "not valid JSON" }); continue; }

    const result = decodeMessage(raw, agentId as AgentId);
    if (!result.ok) {
      const rawObj = raw as Record<string, unknown>;
      if (rawObj["to"] === agentId) {
        console.error(`[gateway/inbox] decode error for ${filename}: [${result.code}] ${result.detail}`);
        errors.push({ filename, code: result.code });
      }
      continue;
    }

    if (result.message.to !== agentId) continue;

    messages.push({
      filename,
      messageId: result.message.id,
      from: result.message.from,
      to: result.message.to,
      type: result.message.type,
      skill: result.message.skill,
      priority: result.message.priority,
      thread: result.message.thread,
      ts: result.message.ts,
      enc: result.message.enc,
      payload: result.payload,
    });
  }

  return json({ ok: true, agentId, count: messages.length, messages, errors });
}

// ─── GET /inbox/:agentId/legacy ───────────────────────────────────────────────

export function handleLegacyInbox(req: Request, agentId: string, ctx: GatewayContext): Response {
  const token = extractToken(req);
  if (!AGENT_IDS.includes(agentId as AgentId)) return err(`Unknown agent ID: ${agentId}`, 400);
  if (!ctx.auth.verifyAgent(agentId, token)) return err("Unauthorized", 401);

  let entries: string[];
  try { entries = readdirSync(ctx.inboxDir); } catch { return err("Cannot read inbox", 500); }

  const handoffs: unknown[] = [];
  const legacyErrors: unknown[] = [];

  for (const filename of entries.sort()) {
    if (!isLegacyFile(filename)) continue;
    try {
      const content = readFileSync(join(ctx.inboxDir, filename), "utf8");
      const parsed = parseLegacyHandoff(content);
      if (parsed.status === "actioned") continue;
      const addressedToUs =
        parsed.to === agentId ||
        parsed.target === agentId ||
        (agentId === "claude" && !parsed.to && !parsed.target);
      if (!addressedToUs) continue;
      handoffs.push({ filename, ...parsed });
    } catch (e) {
      console.error(`[gateway/legacy] parse failed for ${filename}:`, e);
      legacyErrors.push({ filename, error: "parse failed" });
    }
  }

  return json({ ok: true, agentId, count: handoffs.length, handoffs, errors: legacyErrors });
}

// ─── POST /keygen/:agentId — stubbed (moved to a separate crypto package) ────────────────

export async function handleKeygen(req: Request, agentId: string, ctx: GatewayContext): Promise<Response> {
  const token = extractToken(req);
  if (!ctx.auth.verifyAdmin(token)) return err("Unauthorized: admin token required", 401);
  if (!AGENT_IDS.includes(agentId as AgentId)) {
    return err(`Unknown agent ID: ${agentId}. Must be one of: ${AGENT_IDS.join(", ")}`, 400);
  }
  return err("Key generation is not served by the gateway; use `wire keygen <agentId>` locally.", 501);
}
