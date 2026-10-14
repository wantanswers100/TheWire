import { validateWireMessage, validatePayload } from "../schema/validator.js";
import type { WirePayload, ErrorCode } from "../types.js";

// ─── Decode result ────────────────────────────────────────────────────────────

export type DecodeOk = {
  ok: true;
  message: import("../types.js").WireMessage;
  payload: WirePayload;
};

export type DecodeErr = {
  ok: false;
  code: ErrorCode;
  detail: string;
};

export type DecodeResult = DecodeOk | DecodeErr;

// ISS-006: 30s clock skew tolerance — sufficient for local WSL2 filesystem IPC
const MAX_CLOCK_SKEW_MS = 30_000;

// ─── Decode pipeline (schema + routing + TTL; no signature verification) ────

export function decodeMessage(raw: unknown, recipientId: string): DecodeResult {
  // Step 1: Schema validation
  const schemaResult = validateWireMessage(raw);
  if (!schemaResult.ok) {
    return { ok: false, code: "schema_invalid", detail: schemaResult.errors.join("; ") };
  }
  const msg = schemaResult.data;

  // Step 1b: Routing check
  if (msg.to !== recipientId) {
    return {
      ok: false,
      code: "schema_invalid",
      detail: `Message addressed to '${msg.to}', not '${recipientId}'`,
    };
  }

  // Step 2: Clock skew + TTL check
  const now = Date.now();
  if (Math.abs(now - msg.ts) > MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: "ttl_expired", detail: `Clock skew ${Math.abs(now - msg.ts)}ms exceeds ${MAX_CLOCK_SKEW_MS / 1000}s limit` };
  }
  if (now > msg.ts + msg.ttl * 1000) {
    return { ok: false, code: "ttl_expired", detail: `Message expired at ${new Date(msg.ts + msg.ttl * 1000).toISOString()}` };
  }

  // Step 2b: TTL ceiling for high-consequence skills
  const HIGH_CONSEQUENCE_SKILLS = new Set(["system", "implement", "refactor", "architect", "scaffold", "wire"]);
  if (HIGH_CONSEQUENCE_SKILLS.has(msg.skill) && msg.ttl > 3600) {
    return {
      ok: false,
      code: "ttl_expired",
      detail: `TTL ${msg.ttl}s exceeds maximum 3600s for high-consequence skill '${msg.skill}'`,
    };
  }

  // Step 3: Encrypted messages cannot be decoded without the separate crypto package
  if (msg.enc) {
    return {
      ok: false,
      code: "decrypt_failed",
      detail: "Encrypted messages require the separate crypto package for decryption (agent-wire no longer bundles crypto)",
    };
  }

  // Step 4: Validate plaintext payload schema
  const payloadResult = validatePayload(msg.payload);
  if (!payloadResult.ok) {
    return {
      ok: false,
      code: "schema_invalid",
      detail: `Payload schema invalid: ${payloadResult.errors.join("; ")}`,
    };
  }

  return { ok: true, message: msg, payload: payloadResult.data };
}

// ─── Parse JSON file content ─────────────────────────────────────────────────

export function parseWireFile(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error(`[decode] parseWireFile: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
