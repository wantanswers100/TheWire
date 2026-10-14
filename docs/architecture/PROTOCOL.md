# WireProtocol v1 — Specification

**Version:** 1.0.0
**Date:** 2026-06-30
**Status:** Implemented
**Scope:** Local filesystem IPC between Wire Platform agents (Claude, Gemini, Codex, Ollama, system)

---

## 1. Overview

WireProtocol v1 replaces the loose Markdown handoff file format used in `~/projects/inbox/` with a typed, signed, optionally-encrypted message envelope. Every message is:

1. **Schema-validated** — Zod enforces field types at both sender and receiver
2. **Signed** — Ed25519 signature proves which agent sent it and that the body was not modified
3. **Replay-resistant** — nonce + timestamp + TTL; dispatcher rejects stale or duplicate nonces
4. **Optionally encrypted** — AES-256-GCM payload encryption for confidential messages

The physical transport channel remains the filesystem (`~/projects/inbox/`). WireProtocol defines the message format on top of that channel, not a new transport.

---

## 2. Message Envelope

Every WireProtocol v1 message is a JSON object with the following fields. All fields are required unless marked optional.

```
{
  "wire": "1",                    // protocol version — fixed string, must be "1"
  "id": "<uuid-v4>",             // unique message ID
  "from": "<AgentId>",           // sender identity
  "to": "<AgentId>",             // recipient identity (single agent)
  "thread": "<uuid-v4>",         // optional: links messages in a multi-turn sequence
  "ts": <unix-ms>,               // send timestamp, Unix milliseconds
  "nonce": "<hex-32>",           // 16 random bytes, hex-encoded — replay prevention
  "ttl": <seconds>,              // message expires ts + ttl*1000 ms from now
  "type": "<MessageType>",       // message class
  "skill": "<SkillType>",        // task category for routing
  "priority": <1|2|3|4>,        // 1=critical, 2=high, 3=normal, 4=background
  "ctx": "<sha256-hex>",         // optional: SHA-256 hash of shared context artifact
  "depends": ["<uuid>", ...],    // optional: message IDs that must be processed first
  "enc": <boolean>,              // true = payload is AES-256-GCM encrypted
  "payload": { ... },            // WireSpec payload (see Section 3)
  "hmac": "<hex-64>",            // HMAC-SHA256 over canonical form (without hmac and sig fields)
  "sig": "<base64>"              // Ed25519 signature over canonical form (without sig field)
}
```

### 2.1 Field constraints

| Field | Type | Constraint |
|-------|------|-----------|
| `wire` | string | Must equal `"1"` |
| `id` | string | UUID v4 format |
| `from` | AgentId | One of: `claude`, `gemini`, `codex`, `ollama`, `system` |
| `to` | AgentId | One of: `claude`, `gemini`, `codex`, `ollama`, `system` |
| `thread` | string? | UUID v4 format if present |
| `ts` | number | Unix ms, must be within ±300s of receiver's clock |
| `nonce` | string | Exactly 32 hex chars (16 bytes) |
| `ttl` | number | 60–86400 (1 minute to 24 hours) |
| `type` | MessageType | See Section 2.2 |
| `skill` | SkillType | See Section 2.3 |
| `priority` | number | Integer 1, 2, 3, or 4 |
| `ctx` | string? | Exactly 64 hex chars (SHA-256) if present |
| `depends` | string[]? | Array of UUID v4 strings if present |
| `enc` | boolean | Required |
| `payload` | object | WireSpec payload — see Section 3 |
| `hmac` | string | Exactly 64 hex chars (32 bytes) |
| `sig` | string | Base64url-encoded Ed25519 signature (88 chars) |

### 2.2 MessageType values

| Value | Meaning |
|-------|---------|
| `task` | Sender is requesting the recipient to perform work |
| `result` | Recipient returning the output of a prior `task` |
| `handoff` | Sender is transferring a task to a different agent |
| `ack` | Lightweight confirmation of receipt (no payload data required) |
| `error` | Processing failed — payload contains ErrorSpec |
| `ping` | Liveness check — recipient should respond with `ack` |

### 2.3 SkillType values

| Value | Auto-dispatch | Default agent |
|-------|--------------|--------------|
| `quick` | yes | ollama:phi3:mini |
| `summarize` | yes | ollama:phi3:mini |
| `explain` | yes | ollama:mistral:7b |
| `code_review` | yes | ollama:qwen2.5-coder:7b |
| `debug` | yes | ollama:qwen2.5-coder:7b |
| `research` | yes | gemini |
| `plan` | yes | gemini |
| `verify` | yes | gemini |
| `implement` | no (manual) | claude |
| `architect` | no (manual) | claude |
| `scaffold` | no (manual) | codex |
| `wire` | no (manual) | gemini |
| `url_review` | no (manual) | gemini |

---

## 3. WireSpec Payload

The `payload` field contains a WireSpec object. WireSpec is the agent-native task language: typed primitives that agents generate and consume without parsing English prose.

### 3.1 TaskSpec (type: "task")

```json
{
  "format": "task",
  "verb": "<TaskVerb>",
  "domain": ["<string>", ...],
  "subject": "<string>",
  "constraints": { "<key>": "<value>", ... },
  "output": {
    "format": "<OutputFormat>",
    "maxItems": <number>,
    "include": ["<facet>", ...],
    "maxTokens": <number>,
    "language": "<string>"
  },
  "fallback": "best_effort | fail | escalate",
  "urgency": "now | soon | whenever"
}
```

**TaskVerb values:** `query`, `summarize`, `implement`, `review`, `verify`, `transform`, `classify`, `plan`, `explain`, `debug`

**OutputFormat values:** `structured`, `ranked-list`, `prose`, `code`, `table`, `json`

### 3.2 ResultSpec (type: "result")

```json
{
  "format": "result",
  "taskId": "<uuid-v4>",
  "status": "success | partial | failed | needs_clarification",
  "confidence": <0.0–1.0>,
  "data": "<any>",
  "uncertainty": ["<item>", ...],
  "tokensUsed": <number>,
  "reasoningTrace": "<string>"
}
```

### 3.3 HandoffSpec (type: "handoff")

```json
{
  "format": "handoff",
  "taskId": "<uuid-v4>",
  "reason": "capacity | specialization | cost | policy",
  "contextSummary": "<string>",
  "artifacts": ["<path>", ...],
  "resumePoint": "<string>"
}
```

### 3.4 ErrorSpec (type: "error")

```json
{
  "format": "error",
  "taskId": "<uuid-v4>",
  "code": "<ErrorCode>",
  "message": "<string>",
  "retryable": <boolean>
}
```

**ErrorCode values:** `schema_invalid`, `sig_invalid`, `hmac_invalid`, `nonce_replay`, `ttl_expired`, `key_not_found`, `decrypt_failed`, `agent_unavailable`, `unknown`

---

## 4. Canonical Form

Signing and HMAC require a deterministic byte representation of the message. The canonical form is:

1. Take the full message object
2. Remove the `sig` field (for Ed25519 computation) and `hmac` field (for HMAC computation, remove both)
3. Sort all object keys alphabetically, recursively (nested objects also sorted)
4. Serialize to JSON with no whitespace (`JSON.stringify` equivalent, no spaces)
5. Encode as UTF-8 bytes

The HMAC field is computed over the canonical form with both `sig` and `hmac` removed.
The signature field is computed over the canonical form with only `sig` removed (but `hmac` present).

This ordering ensures: sign(canonical(msg_without_sig)) → sig, then hmac is over the canonical form that includes sig.

---

## 5. File Format on Disk

WireProtocol v1 messages are stored as `.wire.json` files in `~/projects/inbox/`. The filename format:

```
{from}_{to}_{timestamp}_{id-prefix}.wire.json
```

Example:
```
claude_gemini_20260630_143022_a3f2b1c4.wire.json
```

Legacy Markdown files (`.md`) coexist in the same inbox. The dispatcher detects format by extension:
- `.wire.json` → WireProtocol v1 path
- `.md` → legacy Markdown path

---

## 6. Message Lifecycle

```
[Sender]
  1. Build WireSpec payload (TaskSpec / ResultSpec / HandoffSpec)
  2. If enc=true: encrypt payload with recipient's X25519 public key → AES-256-GCM ciphertext
  3. Assemble envelope fields (id, from, to, ts, nonce, ttl, type, skill, priority, payload, enc=true/false)
  4. Compute canonical form (without hmac and sig)
  5. Compute HMAC-SHA256 with shared secret → set hmac field
  6. Compute canonical form (without sig, but with hmac)
  7. Sign with sender's Ed25519 private key → set sig field
  8. Write to ~/projects/inbox/{from}_{to}_{ts}_{id-prefix}.wire.json

[Dispatcher / Receiver]
  1. Read file, parse JSON
  2. Check wire === "1"
  3. Validate schema (Zod)
  4. Check TTL: ts + ttl*1000 > Date.now() — reject if expired
  5. Check nonce: not in replay store — reject if seen before; add to store
  6. Verify HMAC: recompute over canonical (without hmac and sig), compare
  7. Verify Ed25519 sig: recompute canonical (without sig), verify with sender's public key
  8. If enc=true: decrypt payload with recipient's X25519 private key
  9. Validate payload schema (WireSpec type-specific Zod schema)
  10. Route to appropriate agent handler
```

---

## 7. Backwards Compatibility

WireProtocol v1 is additive. The dispatcher supports both formats simultaneously. Existing `.md` handoff files in `inbox/` continue to work unchanged. New messages from WireProtocol-aware agents use `.wire.json`. The protocol version field (`wire: "1"`) allows future version negotiation.
