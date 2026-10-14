import { z } from "zod";

// ─── Primitive validators ────────────────────────────────────────────────────

export const AgentIdSchema = z.enum([
  "claude",
  "gemini",
  "codex",
  "ollama",
  "system",
  "llama4",
  "deepseek",
  "antigravity",
]);

export const MessageTypeSchema = z.enum([
  "task",
  "result",
  "handoff",
  "ack",
  "error",
  "ping",
]);

export const SkillTypeSchema = z.enum([
  "quick",
  "summarize",
  "explain",
  "code_review",
  "debug",
  "research",
  "plan",
  "verify",
  "implement",
  "refactor",
  "architect",
  "scaffold",
  "classify",
  "audit",
  "wire",
  "url_review",
  "memory",
  "knowledge",
  "system",
]);

export const PrioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);

const UUIDv4 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Must be a UUID v4"
  );

const HexSHA256 = z.string().regex(/^[0-9a-f]{64}$/, "Must be 64 hex chars (SHA-256)");
const Hex32 = z.string().regex(/^[0-9a-f]{32}$/, "Must be 32 hex chars (16 bytes)");
const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, "Must be 64 hex chars (32 bytes)");

// Ed25519 signature: 64 bytes → base64 = 88 chars with padding → base64url (no padding) = 86 chars
const Base64urlSig = z.string().regex(/^[A-Za-z0-9_-]{86}$/, "Must be base64url Ed25519 signature (86 chars)");

// ─── OutputSpec ──────────────────────────────────────────────────────────────

export const OutputSpecSchema = z.object({
  format: z.enum(["structured", "ranked-list", "prose", "code", "table", "json"]),
  maxItems: z.number().int().positive().optional(),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  maxTokens: z.number().int().positive().optional(),
  language: z.string().optional(),
});

// ─── WireSpec payload schemas ────────────────────────────────────────────────

export const TaskSpecSchema = z.object({
  format: z.literal("task"),
  verb: z.enum([
    "query",
    "summarize",
    "implement",
    "review",
    "verify",
    "transform",
    "classify",
    "plan",
    "explain",
    "debug",
    "execute",
    "refactor",
    "audit",
    "scaffold",
  ]),
  domain: z.array(z.string()).min(1, "At least one domain required"),
  subject: z.string().optional(),
  constraints: z.record(z.union([z.string(), z.number().finite()])).optional(),
  output: OutputSpecSchema,
  fallback: z.enum(["best_effort", "fail", "escalate"]).optional(),
  urgency: z.enum(["now", "soon", "whenever"]).optional(),
  modelFilter: z.array(AgentIdSchema).optional(),
});

export const ResultSpecSchema = z.object({
  format: z.literal("result"),
  taskId: UUIDv4,
  status: z.enum(["success", "partial", "failed", "needs_clarification"]),
  confidence: z.number().min(0).max(1),
  data: z.unknown(),
  uncertainty: z.array(z.string()).optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  reasoningTrace: z.string().optional(),
});

export const HandoffSpecSchema = z.object({
  format: z.literal("handoff"),
  taskId: UUIDv4,
  reason: z.enum(["capacity", "specialization", "cost", "policy"]),
  contextSummary: z.string().min(1),
  artifacts: z.array(z.string()).optional(),
  resumePoint: z.string().optional(),
});

export const ErrorSpecSchema = z.object({
  format: z.literal("error"),
  taskId: UUIDv4,
  code: z.enum([
    "schema_invalid",
    "sig_invalid",
    "hmac_invalid",
    "nonce_replay",
    "ttl_expired",
    "key_not_found",
    "decrypt_failed",
    "agent_unavailable",
    "unknown",
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const AckSpecSchema = z.object({
  format: z.literal("ack"),
  taskId: UUIDv4,
});

export const PingSpecSchema = z.object({
  format: z.literal("ping"),
});

// Key rotation payload schema — carries new public keys + continuity attestation (ISS-007)
export const KeyRotationSpecSchema = z.object({
  format: z.literal("key_rotation"),
  agentId: AgentIdSchema,
  newEd25519Pk: z.string().min(1).max(2048),
  newX25519Pk: z.string().min(1).max(2048),
  rotationTs: z.number().int().positive(),
  // rotationValidUntil: attestation expiry — verifier rejects after this timestamp.
  // Prevents indefinite replay of a captured key_rotation message (no rotationValidUntil = rotation replay attack).
  rotationValidUntil: z.number().int().positive(),
  // base64url Ed25519 signature: 64 bytes → ceil(64/3)*4 = 88 chars with padding → 86 chars base64url (no padding).
  // Must be exactly 86 chars — values of 87–88 would decode to 65–66 bytes which Ed25519 always rejects.
  continuitySignature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, "continuitySignature must be 86-char base64url Ed25519 sig (64 bytes)"),
});

export const WirePayloadSchema = z.discriminatedUnion("format", [
  TaskSpecSchema,
  ResultSpecSchema,
  HandoffSpecSchema,
  ErrorSpecSchema,
  AckSpecSchema,
  PingSpecSchema,
  KeyRotationSpecSchema,
]);

// ─── Encrypted payload ───────────────────────────────────────────────────────

// wire-v2 EncryptedPayload schema.
// Changes from wire-v1: added v (version discriminator), salt (decoupled HKDF salt), kc (key commitment).
// v1 had no v field and used the IV as HKDF salt — v2 treats IV and salt independently.
export const EncryptedPayloadSchema = z.object({
  v: z.literal("2"),
  iv: z.string().regex(/^[0-9a-f]{24}$/, "IV must be 24 hex chars (12 bytes)"),
  // salt: dedicated HKDF salt, independent of IV (ISS-001 fix). 32 bytes = 64 hex chars.
  salt: z.string().regex(/^[0-9a-f]{64}$/, "salt must be 64 hex chars (32 bytes)"),
  tag: z.string().regex(/^[0-9a-f]{32}$/, "Auth tag must be 32 hex chars (16 bytes)"),
  // Max 1MB ciphertext — prevents DoS via oversized authenticated payloads
  ciphertext: z.string().regex(/^[A-Za-z0-9+/=]+$/, "Ciphertext must be base64").min(1).max(1_048_576),
  // epk: ephemeral sender X25519 public key (SPKI DER, base64). X25519 SPKI DER = 44 bytes = 60 base64 chars.
  epk: z.string().regex(/^[A-Za-z0-9+/=]{60}$/, "epk must be 60-char base64 (X25519 SPKI DER = 44 bytes)"),
  // kc: key commitment tag — HMAC-SHA256(aesKey, "wire-v2-key-commit"), 32 bytes = 64 hex chars (ISS-003 fix).
  kc: z.string().regex(/^[0-9a-f]{64}$/, "kc must be 64 hex chars (HMAC-SHA256 = 32 bytes)"),
});

// ─── Full wire envelope ──────────────────────────────────────────────────────
// enc/payload correlation enforced: enc=true requires EncryptedPayload, enc=false requires WirePayload

const EncryptedEnvelope = z.object({
  wire: z.literal("1"),
  id: UUIDv4,
  from: AgentIdSchema,
  to: AgentIdSchema,
  thread: UUIDv4.optional(),
  ts: z.number().int().positive(),
  nonce: Hex32,
  ttl: z.number().int().min(60).max(86400),
  type: MessageTypeSchema,
  skill: SkillTypeSchema,
  priority: PrioritySchema,
  ctx: HexSHA256.optional(),
  depends: z.array(UUIDv4).optional(),
  enc: z.literal(true),
  payload: EncryptedPayloadSchema,
  hmac: Hex64.optional(),
  sig: Base64urlSig.optional(),
});

const PlaintextEnvelope = z.object({
  wire: z.literal("1"),
  id: UUIDv4,
  from: AgentIdSchema,
  to: AgentIdSchema,
  thread: UUIDv4.optional(),
  ts: z.number().int().positive(),
  nonce: Hex32,
  ttl: z.number().int().min(60).max(86400),
  type: MessageTypeSchema,
  skill: SkillTypeSchema,
  priority: PrioritySchema,
  ctx: HexSHA256.optional(),
  depends: z.array(UUIDv4).optional(),
  enc: z.literal(false),
  payload: WirePayloadSchema,
  hmac: Hex64.optional(),
  sig: Base64urlSig.optional(),
});

export const WireMessageSchema = z.discriminatedUnion("enc", [
  EncryptedEnvelope,
  PlaintextEnvelope,
]);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type WireMessageInput = z.input<typeof WireMessageSchema>;
