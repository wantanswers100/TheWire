// Tests for classifyExtended and the extended schema — NL dispatch layer
//
// These tests cover: schema validation, extractJson edge cases, subject
// fallback in nl-cmd, and the confidence gate logic. They do NOT require
// Ollama (all LLM calls are simulated via schema parsing tests).

import { describe, test, expect } from "bun:test";
import { z } from "zod";

// ─── Re-export internals for testing via a test shim ──────────────────────────
// We test the schema and extraction logic directly, not via live Ollama calls.

const KNOWN_SKILLS = [
  "implement", "refactor", "debug", "research", "scaffold", "summarize",
  "explain", "code_review", "verify", "audit", "quick", "wire",
] as const;

const KNOWN_VERBS = [
  "implement", "debug", "refactor", "query", "plan", "scaffold",
  "summarize", "explain", "review", "verify", "audit", "classify",
] as const;

const KNOWN_DOMAINS = [
  "typescript", "bun", "node", "python", "react", "frontend",
  "backend", "api", "security", "crypto", "gcp", "firebase",
  "database", "local", "large-context",
] as const;

const ExtendedClassifierOutputSchema = z.object({
  skill: z.enum(KNOWN_SKILLS),
  verb: z.enum(KNOWN_VERBS),
  domains: z.array(z.enum(KNOWN_DOMAINS)).max(4),
  subject: z.string().max(80).optional(),
  preferredAgent: z.enum(["claude", "gemini", "codex", "ollama"]).optional(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(200).optional(),
});

const MinimalClassifierOutputSchema = z.object({
  skill: z.enum(KNOWN_SKILLS),
  verb: z.enum(KNOWN_VERBS),
  confidence: z.number().min(0).max(1),
});

// Mirror of extractJson from classifier.ts
function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) return raw.trim();

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return raw.slice(start).trim();
}

// ─── extractJson ─────────────────────────────────────────────────────────────

describe("extractJson", () => {
  test("extracts clean JSON object", () => {
    const raw = `{"skill":"debug","verb":"debug","confidence":0.9}`;
    expect(extractJson(raw)).toBe(raw);
  });

  test("strips markdown fences and trailing text", () => {
    const raw = "```json\n{\"skill\":\"research\",\"verb\":\"query\",\"confidence\":0.8}\n```\nSome explanation here.";
    const result = extractJson(raw);
    expect(result).toContain('"skill":"research"');
    expect(result).not.toContain("```");
    expect(result).not.toContain("explanation");
  });

  test("handles phi3.5 trailing garbage after closing brace", () => {
    const raw = `{"skill":"debug","verb":"debug","confidence":0.9} extra trailing content`;
    const result = extractJson(raw);
    expect(result).toBe(`{"skill":"debug","verb":"debug","confidence":0.9}`);
  });

  test("handles string values containing braces", () => {
    const raw = `{"skill":"debug","subject":"TypeError: {value} is undefined","confidence":0.9,"domains":[]}`;
    const result = extractJson(raw);
    const parsed = JSON.parse(result);
    expect(parsed.subject).toContain("{value}");
  });

  test("returns trimmed input when no { found", () => {
    expect(extractJson("no json here")).toBe("no json here");
  });

  test("handles escaped quotes inside strings", () => {
    const raw = `{"skill":"explain","subject":"the \\"main\\" function","confidence":0.85,"domains":[]}`;
    const result = extractJson(raw);
    const parsed = JSON.parse(result);
    expect(parsed.subject).toBe('the "main" function');
  });
});

// ─── Extended schema validation ───────────────────────────────────────────────

describe("ExtendedClassifierOutputSchema", () => {
  test("accepts valid full result", () => {
    const input = {
      skill: "research",
      verb: "query",
      domains: ["typescript"],
      subject: "UK housing policy trends",
      preferredAgent: "gemini",
      confidence: 0.92,
      reasoning: "Research task with policy topic.",
    };
    const result = ExtendedClassifierOutputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe("UK housing policy trends");
      expect(result.data.preferredAgent).toBe("gemini");
    }
  });

  test("accepts result without subject or preferredAgent", () => {
    const input = {
      skill: "debug",
      verb: "debug",
      domains: [],
      confidence: 0.88,
    };
    const result = ExtendedClassifierOutputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBeUndefined();
      expect(result.data.preferredAgent).toBeUndefined();
    }
  });

  test("rejects unknown skill", () => {
    const input = { skill: "hacking", verb: "debug", domains: [], confidence: 0.9 };
    expect(ExtendedClassifierOutputSchema.safeParse(input).success).toBe(false);
  });

  test("rejects confidence > 1", () => {
    const input = { skill: "debug", verb: "debug", domains: [], confidence: 1.5 };
    expect(ExtendedClassifierOutputSchema.safeParse(input).success).toBe(false);
  });

  test("rejects unknown preferredAgent", () => {
    const input = { skill: "debug", verb: "debug", domains: [], confidence: 0.9, preferredAgent: "gpt-4" };
    expect(ExtendedClassifierOutputSchema.safeParse(input).success).toBe(false);
  });

  test("rejects subject longer than 80 chars", () => {
    const input = {
      skill: "debug", verb: "debug", domains: [], confidence: 0.9,
      subject: "x".repeat(81),
    };
    expect(ExtendedClassifierOutputSchema.safeParse(input).success).toBe(false);
  });

  test("accepts up to 4 domains", () => {
    const input = {
      skill: "implement", verb: "implement",
      domains: ["typescript", "bun", "api", "security"],
      confidence: 0.85,
    };
    expect(ExtendedClassifierOutputSchema.safeParse(input).success).toBe(true);
  });

  test("rejects 5 domains", () => {
    const input = {
      skill: "implement", verb: "implement",
      domains: ["typescript", "bun", "api", "security", "crypto"],
      confidence: 0.85,
    };
    expect(ExtendedClassifierOutputSchema.safeParse(input).success).toBe(false);
  });
});

// ─── Minimal schema (phi3:mini fallback) ─────────────────────────────────────

describe("MinimalClassifierOutputSchema", () => {
  test("accepts valid minimal result", () => {
    const input = { skill: "summarize", verb: "summarize", confidence: 0.75 };
    const result = MinimalClassifierOutputSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("rejects when skill is missing", () => {
    const input = { verb: "debug", confidence: 0.8 };
    expect(MinimalClassifierOutputSchema.safeParse(input).success).toBe(false);
  });
});

// ─── nl-cmd confidence gate logic (unit) ─────────────────────────────────────
// Test the gate logic in isolation — no actual dispatch.

describe("confidence gate thresholds", () => {
  function gateDecision(confidence: number, flags: { dryRun?: boolean; confirm?: boolean }) {
    if (confidence < 0.60) return "bail";
    const needsPlan = flags.dryRun || flags.confirm || confidence < 0.85;
    if (flags.dryRun) return "dry-run";
    if (needsPlan) return "confirm";
    return "silent-dispatch";
  }

  test("≥0.85 with no flags → silent dispatch", () => {
    expect(gateDecision(0.85, {})).toBe("silent-dispatch");
    expect(gateDecision(0.97, {})).toBe("silent-dispatch");
  });

  test("0.60-0.84 → confirm required", () => {
    expect(gateDecision(0.60, {})).toBe("confirm");
    expect(gateDecision(0.78, {})).toBe("confirm");
    expect(gateDecision(0.84, {})).toBe("confirm");
  });

  test("<0.60 → bail", () => {
    expect(gateDecision(0.59, {})).toBe("bail");
    expect(gateDecision(0.0, {})).toBe("bail");
  });

  test("--dry-run flag → dry-run regardless of confidence", () => {
    expect(gateDecision(0.95, { dryRun: true })).toBe("dry-run");
    expect(gateDecision(0.70, { dryRun: true })).toBe("dry-run");
  });

  test("--confirm flag → confirm regardless of high confidence", () => {
    expect(gateDecision(0.95, { confirm: true })).toBe("confirm");
    expect(gateDecision(0.90, { confirm: true })).toBe("confirm");
  });
});

// ─── Subject fallback logic ───────────────────────────────────────────────────

describe("subject fallback", () => {
  test("uses result.subject when present", () => {
    const taskText = "summarize my standup notes from today";
    const resultSubject = "standup notes";
    const subject = resultSubject ?? taskText.slice(0, 80);
    expect(subject).toBe("standup notes");
  });

  test("falls back to truncated task text when subject absent (phi3:mini path)", () => {
    const taskText = "summarize my standup notes from today";
    const resultSubject: string | undefined = undefined;
    const subject = resultSubject ?? taskText.slice(0, 80);
    expect(subject).toBe(taskText);
  });

  test("truncates very long task text to 80 chars in fallback", () => {
    const taskText = "x".repeat(200);
    const subject = taskText.slice(0, 80);
    expect(subject.length).toBe(80);
  });
});
