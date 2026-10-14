import { describe, test, expect } from "bun:test";

import { parseAgentHandoffContent, validateAgentHandoffFields } from "../src/dispatch/agentHandoff.js";
import { parseFrontmatter } from "../src/dispatch/codexHandoff.js";

function makeHandoff(overrides: Record<string, string> = {}): string {
  const fields = {
    from: "claude",
    to: "codex",
    target: "codex",
    date: "2026-08-11 17:30:00",
    project: "agent-wire",
    status: "pending",
    work_type: "review",
    ...overrides,
  };
  return [
    "---",
    ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    "# Handoff",
    "",
    "Review this.",
    "",
  ].join("\n");
}

describe("agentHandoff — known tokens", () => {
  for (const token of ["claude", "codex", "gemini", "ollama", "antigravity"] as const) {
    test(`parses a valid handoff targeting ${token}`, () => {
      const result = parseAgentHandoffContent(makeHandoff({ to: token, target: token }), `${token}.md`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.request.to).toBe(token);
        expect(result.request.target).toBe(token);
        expect(result.request.body).toContain("Review this.");
      }
    });
  }
});

describe("agentHandoff — generic validation", () => {
  test("requires only shared markdown handoff fields, not Codex execution fields", () => {
    const result = parseAgentHandoffContent(makeHandoff(), "generic.md");
    expect(result.ok).toBe(true);
  });

  test("rejects when to and target do not match", () => {
    const result = parseAgentHandoffContent(makeHandoff({ to: "codex", target: "claude" }), "mismatch.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "target" && e.message.includes("must match"))).toBe(true);
    }
  });

  test("rejects unknown agent tokens", () => {
    const result = parseAgentHandoffContent(makeHandoff({ to: "nobody", target: "nobody" }), "unknown.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "to")).toBe(true);
      expect(result.errors.some(e => e.field === "target")).toBe(true);
    }
  });

  test("accepts current workspace date format, not ISO-only", () => {
    const result = parseAgentHandoffContent(makeHandoff({ date: "2026-08-11 16:47:59" }), "date.md");
    expect(result.ok).toBe(true);
  });

  test("rejects status outside pending/actioned", () => {
    const result = parseAgentHandoffContent(makeHandoff({ status: "done" }), "status.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(e => e.field === "status")).toBe(true);
    }
  });

  test("validateAgentHandoffFields reports missing shared fields", () => {
    const raw = parseFrontmatter("from: claude\nto: codex\ntarget: codex\n");
    const result = validateAgentHandoffFields(raw, "body", "missing.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(e => e.field)).toContain("date");
      expect(result.errors.map(e => e.field)).toContain("project");
      expect(result.errors.map(e => e.field)).toContain("status");
      expect(result.errors.map(e => e.field)).toContain("work_type");
    }
  });
});

