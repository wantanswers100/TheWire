import { describe, test, expect } from "bun:test";
import {
  AgentIdSchema,
  TaskSpecSchema,
  ResultSpecSchema,
  HandoffSpecSchema,
  ErrorSpecSchema,
  WirePayloadSchema,
} from "../src/schema/wirespec.js";
import { validatePayload } from "../src/schema/validator.js";
import { AGENT_IDS } from "../src/types.js";

describe("AgentIdSchema sync", () => {
  test("AgentIdSchema covers all AGENT_IDS", () => {
    expect(AgentIdSchema.options).toHaveLength(AGENT_IDS.length);
    for (const id of AGENT_IDS) {
      expect(AgentIdSchema.options).toContain(id);
    }
  });
});

describe("TaskSpec schema", () => {
  test("valid task passes", () => {
    const result = TaskSpecSchema.safeParse({
      format: "task",
      verb: "query",
      domain: ["sqlite", "indexing"],
      output: { format: "ranked-list", maxItems: 5 },
    });
    expect(result.success).toBe(true);
  });

  test("missing domain fails", () => {
    const result = TaskSpecSchema.safeParse({
      format: "task",
      verb: "query",
      output: { format: "json" },
    });
    expect(result.success).toBe(false);
  });

  test("empty domain array fails", () => {
    const result = TaskSpecSchema.safeParse({
      format: "task",
      verb: "query",
      domain: [],
      output: { format: "json" },
    });
    expect(result.success).toBe(false);
  });

  test("invalid verb fails", () => {
    const result = TaskSpecSchema.safeParse({
      format: "task",
      verb: "invent",
      domain: ["test"],
      output: { format: "json" },
    });
    expect(result.success).toBe(false);
  });
});

describe("ResultSpec schema", () => {
  test("valid result passes", () => {
    const result = ResultSpecSchema.safeParse({
      format: "result",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "success",
      confidence: 0.92,
      data: [{ option: "covering index", tradeoff: "more disk" }],
    });
    expect(result.success).toBe(true);
  });

  test("confidence out of range fails", () => {
    const result = ResultSpecSchema.safeParse({
      format: "result",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      status: "success",
      confidence: 1.5,
      data: null,
    });
    expect(result.success).toBe(false);
  });

  test("invalid UUID taskId fails", () => {
    const result = ResultSpecSchema.safeParse({
      format: "result",
      taskId: "not-a-uuid",
      status: "success",
      confidence: 0.8,
      data: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("HandoffSpec schema", () => {
  test("valid handoff passes", () => {
    const result = HandoffSpecSchema.safeParse({
      format: "handoff",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      reason: "specialization",
      contextSummary: "Needs React/TS expertise",
    });
    expect(result.success).toBe(true);
  });

  test("invalid reason fails", () => {
    const result = HandoffSpecSchema.safeParse({
      format: "handoff",
      taskId: "550e8400-e29b-41d4-a716-446655440001",
      reason: "boredom",
      contextSummary: "test",
    });
    expect(result.success).toBe(false);
  });
});

describe("WirePayload discriminated union", () => {
  test("routes to correct schema by format field", () => {
    const task = WirePayloadSchema.safeParse({
      format: "task",
      verb: "plan",
      domain: ["architecture"],
      output: { format: "structured" },
    });
    expect(task.success).toBe(true);

    const ping = WirePayloadSchema.safeParse({ format: "ping" });
    expect(ping.success).toBe(true);

    const unknown = WirePayloadSchema.safeParse({ format: "unknown_type" });
    expect(unknown.success).toBe(false);
  });
});

describe("validatePayload", () => {
  test("returns ok=true on valid payload", () => {
    const result = validatePayload({
      format: "task",
      verb: "debug",
      domain: ["python", "fastapi"],
      output: { format: "structured", include: ["line", "severity"] },
    });
    expect(result.ok).toBe(true);
  });

  test("returns ok=false with error list on invalid payload", () => {
    const result = validatePayload({ format: "task" }); // missing verb, domain, output
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
