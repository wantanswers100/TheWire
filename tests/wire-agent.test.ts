import { describe, test, expect, beforeEach } from "bun:test";
import { WireAgent, buildEnrichedPrompt } from "../src/agents/wire-agent.js";
import { MemoryStore } from "../src/agents/memory.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wire-agent-"));
}

// ─── buildEnrichedPrompt unit tests ──────────────────────────────────────────

describe("buildEnrichedPrompt", () => {
  test("returns base prompt unchanged when context is empty", () => {
    const result = buildEnrichedPrompt("Do the thing.", { memorySummary: "", ragContext: "" });
    expect(result).toBe("Do the thing.");
  });

  test("prepends memory summary when present", () => {
    const result = buildEnrichedPrompt("Do the thing.", {
      memorySummary: "[Prior context from memory]\n- key: value",
      ragContext: "",
    });
    expect(result).toContain("[Prior context from memory]");
    expect(result).toContain("Do the thing.");
    // context comes before the base prompt
    expect(result.indexOf("[Prior context from memory]")).toBeLessThan(result.indexOf("Do the thing."));
  });

  test("prepends RAG context when present", () => {
    const result = buildEnrichedPrompt("Do the thing.", {
      memorySummary: "",
      ragContext: "[Relevant document context]\nsome chunk",
    });
    expect(result).toContain("[Relevant document context]");
    expect(result).toContain("Do the thing.");
  });

  test("prepends both when both present", () => {
    const result = buildEnrichedPrompt("Do the thing.", {
      memorySummary: "[Prior context from memory]\n- k: v",
      ragContext: "[Relevant document context]\nchunk",
    });
    expect(result).toContain("[Prior context from memory]");
    expect(result).toContain("[Relevant document context]");
    expect(result).toContain("Do the thing.");
  });
});

// ─── WireAgent integration tests ──────────────────────────────────────────────

describe("WireAgent", () => {
  let stateDir: string;
  let agent: WireAgent;
  let memory: MemoryStore;

  beforeEach(() => {
    stateDir = tmpDir();
    agent = new WireAgent(stateDir);
    memory = new MemoryStore(stateDir);
  });

  test("enrich returns empty context when no memory or rag", async () => {
    const ctx = await agent.enrich("quick", { verb: "summarize", subject: "test" });
    expect(ctx.memorySummary).toBe("");
    expect(ctx.ragContext).toBe("");
  }, 30_000);

  test("enrich returns non-empty memorySummary when memory has matching entries", async () => {
    // Seed memory with a relevant entry
    await memory.set({
      key: "dispatch-test-1",
      value: "The Wire Platform uses WireProtocol v1 for signed messages.",
      category: "observation",
    });

    const ctx = await agent.enrich("research", { verb: "research", subject: "Wire Platform protocol" });
    // MemoryTiers episodic format: "Previous similar tasks: [key] → excerpt"
    expect(ctx.memorySummary.length).toBeGreaterThan(0);
  }, 30_000);

  test("enrich does not query RAG for non-knowledge skills", async () => {
    const ctx = await agent.enrich("quick", { verb: "summarize", subject: "anything" });
    // ragContext should always be empty for non-knowledge skills
    expect(ctx.ragContext).toBe("");
  }, 30_000);

  test("sessionBrief returns ready message when no task history", () => {
    const brief = agent.sessionBrief();
    expect(brief).toContain("Ready");
    expect(typeof brief).toBe("string");
    expect(brief.length).toBeGreaterThan(0);
  });

  test("sessionBrief includes task entries after logTask", async () => {
    await memory.logTask({
      taskId: "test-task-id-001",
      from: "gemini",
      skill: "research",
      subject: "Wire Platform architecture",
      routedTo: "gemini",
      status: "success",
      resultSummary: "The Wire Platform is a personal AI presence.",
    });

    const brief = agent.sessionBrief();
    expect(brief).toContain("research");
    expect(brief).toContain("gemini");
  });

  test("sessionBrief shows failure indicator for failed tasks", async () => {
    await memory.logTask({
      taskId: "test-task-id-002",
      from: "claude",
      skill: "debug",
      routedTo: "ollama",
      status: "failed",
      resultSummary: "Ollama timeout after 120s",
    });

    const brief = agent.sessionBrief();
    expect(brief).toContain("✗");
    expect(brief).toContain("debug");
  });

  test("enrich returns EnrichmentContext object for any skill", async () => {
    // Verify the return shape contract holds regardless of data presence
    for (const skill of ["quick", "research", "knowledge", "debug"]) {
      const ctx = await agent.enrich(skill, { verb: "query", subject: "test" });
      expect(typeof ctx.memorySummary).toBe("string");
      expect(typeof ctx.ragContext).toBe("string");
    }
  }, 30_000);
});
