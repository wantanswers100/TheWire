import { z, ZodError } from "zod";
import {
  WireMessageSchema,
  WirePayloadSchema,
} from "./wirespec.js";
import type { WireMessage, WirePayload } from "../types.js";

// ─── Validation result types ─────────────────────────────────────────────────

export type ValidationOk<T> = { ok: true; data: T };
export type ValidationErr = { ok: false; errors: string[] };
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

function formatZodError(err: ZodError): string[] {
  return err.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
}

function validate<T>(schema: z.ZodType<T>, input: unknown): ValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: formatZodError(result.error) };
}

// ─── Public validators ───────────────────────────────────────────────────────

export function validateWireMessage(input: unknown): ValidationResult<WireMessage> {
  return validate(WireMessageSchema as z.ZodType<WireMessage>, input);
}

export function validatePayload(input: unknown): ValidationResult<WirePayload> {
  return validate(WirePayloadSchema as z.ZodType<WirePayload>, input);
}
