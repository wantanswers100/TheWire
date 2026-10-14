import { randomUUID, randomBytes } from "node:crypto";
import type {
  AgentId,
  MessageType,
  SkillType,
  Priority,
  WireMessage,
  WirePayload,
} from "../types.js";

// ─── Message builder options ─────────────────────────────────────────────────

export interface BuildOptions {
  from: AgentId;
  to: AgentId;
  type: MessageType;
  skill: SkillType;
  payload: WirePayload;
  priority?: Priority;
  ttl?: number;
  thread?: string;
  ctx?: string;
  depends?: string[];
}

// ─── Build a WireMessage envelope (unsigned) ─────────────────────────────────

export async function buildMessage(opts: BuildOptions): Promise<WireMessage> {
  const now = Date.now();
  const HIGH_CONSEQUENCE_SKILLS = new Set(["system", "implement", "refactor", "architect", "scaffold", "wire"]);
  const MAX_CONSEQUENCE_TTL_S = 3600;
  const requestedTtl = opts.ttl ?? 3600;
  if (HIGH_CONSEQUENCE_SKILLS.has(opts.skill) && requestedTtl > MAX_CONSEQUENCE_TTL_S) {
    throw new Error(
      `buildMessage: TTL ${requestedTtl}s exceeds maximum ${MAX_CONSEQUENCE_TTL_S}s for high-consequence skill '${opts.skill}'`
    );
  }

  return {
    wire: "1",
    id: randomUUID(),
    from: opts.from,
    to: opts.to,
    ts: now,
    nonce: randomBytes(16).toString("hex"),
    ttl: requestedTtl,
    type: opts.type,
    skill: opts.skill,
    priority: opts.priority ?? 3,
    enc: false,
    payload: opts.payload,
    ...(opts.thread !== undefined && { thread: opts.thread }),
    ...(opts.ctx !== undefined && { ctx: opts.ctx }),
    ...(opts.depends !== undefined && { depends: opts.depends }),
  };
}

// ─── Serialize to disk format ────────────────────────────────────────────────

export function serializeMessage(msg: WireMessage): string {
  return JSON.stringify(msg, null, 2);
}

// ─── Filename generation ─────────────────────────────────────────────────────

export function wireFilename(msg: WireMessage): string {
  const ts = new Date(msg.ts)
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const idPrefix = msg.id.replace(/-/g, "").slice(0, 8);
  return `${msg.from}_${msg.to}_${ts}_${idPrefix}.wire.json`;
}
