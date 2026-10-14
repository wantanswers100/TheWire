// WireProtocol v1 — canonical TypeScript types
// All interfaces match PROTOCOL.md exactly. Any deviation is a bug.

export const WIRE_VERSION = "1" as const;

// ─── Agent identities ───────────────────────────────────────────────────────

export type AgentId = "claude" | "gemini" | "codex" | "ollama" | "system" | "llama4" | "deepseek" | "antigravity";

export const AGENT_IDS: AgentId[] = [
  "claude",
  "gemini",
  "codex",
  "ollama",
  "system",
  "llama4",
  "deepseek",
  "antigravity",
];

// ─── Message classification ──────────────────────────────────────────────────

export type MessageType =
  | "task"
  | "result"
  | "handoff"
  | "ack"
  | "error"
  | "ping";

export type SkillType =
  | "quick"
  | "summarize"
  | "explain"
  | "code_review"
  | "debug"
  | "research"
  | "plan"
  | "verify"
  | "implement"
  | "architect"
  | "scaffold"
  | "classify"
  | "audit"
  | "wire"
  | "url_review"
  | "memory"
  | "knowledge"
  | "system"
  | "refactor";

export type Priority = 1 | 2 | 3 | 4;

// ─── WireSpec payload types ──────────────────────────────────────────────────

export type TaskVerb =
  | "query"
  | "summarize"
  | "implement"
  | "review"
  | "verify"
  | "transform"
  | "classify"
  | "plan"
  | "explain"
  | "debug"
  | "execute"
  | "refactor"
  | "audit"
  | "scaffold";

export type OutputFormat =
  | "structured"
  | "ranked-list"
  | "prose"
  | "code"
  | "table"
  | "json";

export type ResultStatus =
  | "success"
  | "partial"
  | "failed"
  | "needs_clarification";

export type HandoffReason =
  | "capacity"
  | "specialization"
  | "cost"
  | "policy";

export type ErrorCode =
  | "schema_invalid"
  | "sig_invalid"
  | "hmac_invalid"
  | "nonce_replay"
  | "ttl_expired"
  | "key_not_found"
  | "decrypt_failed"
  | "agent_unavailable"
  | "hitl_delivery_failed"
  | "unknown";

export type Fallback = "best_effort" | "fail" | "escalate";
export type Urgency = "now" | "soon" | "whenever";

// ─── Output specification ────────────────────────────────────────────────────

export interface OutputSpec {
  format: OutputFormat;
  maxItems?: number;
  include?: string[];
  exclude?: string[];
  maxTokens?: number;
  language?: string;
}

// ─── WireSpec payload variants ───────────────────────────────────────────────

export interface ParallelContext {
  group: string;          // parent task ID grouping subtasks
  parentTaskId: string;
  subtaskIndex: number;   // 0-based within the group
  expectedSubtasks: number;
}

export interface TaskSpec {
  format: "task";
  verb: TaskVerb;
  domain: string[];
  subject?: string;
  constraints?: Record<string, string | number>;
  output: OutputSpec;
  fallback?: Fallback;
  urgency?: Urgency;
  /** Optional: restrict dispatch to only these agent IDs. Default routing unchanged when absent. */
  modelFilter?: AgentId[];
  /** Parallel dispatch context — set by ParallelDispatcher, not by callers directly */
  parallelContext?: ParallelContext;
}

export interface ResultSpec {
  format: "result";
  taskId: string;
  status: ResultStatus;
  confidence: number;
  data: unknown;
  uncertainty?: string[];
  tokensUsed?: number;
  reasoningTrace?: string;
}

export interface HandoffSpec {
  format: "handoff";
  taskId: string;
  reason: HandoffReason;
  contextSummary: string;
  artifacts?: string[];
  resumePoint?: string;
}

export interface ErrorSpec {
  format: "error";
  taskId: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface AckSpec {
  format: "ack";
  taskId: string;
}

export interface PingSpec {
  format: "ping";
}

// ─── Key rotation payload (ISS-007) ─────────────────────────────────────────
// Sent as a wire message (type="task", skill="wire") when an agent rotates its
// Ed25519 signing key. The message itself is signed with the OLD private key,
// proving key continuity: the old key holder authorized the new public key.
//
// Recipients must:
// 1. Verify the wire message signature (old key — this is normal decode pipeline)
// 2. Verify continuitySignature = Ed25519(oldSk, canonical({agentId, newEd25519Pk, newX25519Pk, rotationTs}))
// 3. Replace .keys/{agentId}.ed25519.pk with newEd25519Pk (out-of-band, operator-approved)
export interface KeyRotationSpec {
  format: "key_rotation";
  agentId: AgentId;
  newEd25519Pk: string;        // PEM SPKI — new Ed25519 public key
  newX25519Pk: string;         // PEM SPKI — new X25519 public key
  rotationTs: number;          // Unix ms timestamp of rotation event
  rotationValidUntil: number;  // Unix ms — attestation expires after this; prevents indefinite replay
  continuitySignature: string; // base64url Ed25519 sig over canonical({agentId, newEd25519Pk, newX25519Pk, rotationTs, rotationValidUntil}) using OLD private key
}

export type WirePayload =
  | TaskSpec
  | ResultSpec
  | HandoffSpec
  | ErrorSpec
  | AckSpec
  | PingSpec
  | KeyRotationSpec;

// ─── Encrypted payload wrapper ───────────────────────────────────────────────

// When enc=true, the payload field contains this instead of a WirePayload.
// Wire-v2 format (2026-07-23):
//   v:   format version discriminator — "2" for this format (wire-v1 had no v field)
//   iv:  GCM nonce only — 12 bytes random, hex-encoded. NOT used as HKDF salt (decoupled in v2).
//   salt: explicit HKDF salt — 32 bytes random, hex-encoded. Decoupled from IV so IV collision
//         no longer implies AES key collision. (ISS-001: HKDF salt decoupling)
//   tag: AES-256-GCM authentication tag — 16 bytes, hex-encoded.
//   ciphertext: encrypted payload, base64-encoded.
//   epk: ephemeral sender X25519 public key (SPKI DER, base64) for forward secrecy.
//   kc:  key commitment tag — HMAC-SHA256(aesKey, "wire-v2-key-commit"), hex-encoded.
//        Prevents GCM key-commitment attacks where a crafted ciphertext authenticates
//        under two different keys. (ISS-003: GCM key commitment)
export interface EncryptedPayload {
  v: "2";
  iv: string;
  salt: string;
  tag: string;
  ciphertext: string;
  epk: string;
  kc: string;
}

// ─── Wire envelope ───────────────────────────────────────────────────────────

export interface WireMessage {
  wire: typeof WIRE_VERSION;
  id: string;
  from: AgentId;
  to: AgentId;
  thread?: string;
  ts: number;
  nonce: string;
  ttl: number;
  type: MessageType;
  skill: SkillType;
  priority: Priority;
  ctx?: string;
  depends?: string[];
  enc: boolean;
  payload: WirePayload | EncryptedPayload;
  hmac?: string;
  sig?: string;
}

// ─── Dispatch result ─────────────────────────────────────────────────────────

export type DispatchResult =
  | { ok: true; messageId: string; to: AgentId }
  | { ok: false; error: ErrorCode; detail: string };

// ─── Outcome record — emitted after every dispatch, injected via LoopConfig ──
// Lives here (not in src/skills/) to prevent circular imports from loop.ts.

export interface OutcomeRecord {
  taskId: string;
  skill: string;
  subject?: string;
  agentUsed: AgentId;
  status: "success" | "failed";
  resultSummary: string;
  tokensUsed?: number;
  model?: string;
  createdAt: number;
}

