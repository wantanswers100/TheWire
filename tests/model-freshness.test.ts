// modelFreshness: retired or previous-generation models are flagged before
// they fail a dispatch (agy rejected gemini-3.7-flash-medium on 2026-11-08).

import { describe, test, expect } from "bun:test";
import { checkAgyModels, checkCodexModel, checkClaudeModel } from "../src/dispatch/modelFreshness.js";
import { AGY_DEFAULT_MODEL } from "../src/config/models.js";

const codexList = JSON.stringify({ models: [
  { slug: "gpt-6.1-sol", description: "Latest workhorse model for coding and everyday work.", visibility: "list", priority: 1 },
  { slug: "gpt-6-sol", description: "Previous generation workhorse model.", visibility: "list", priority: 4 },
]});

describe("model freshness", () => {
  test("agy: configured model missing from `agy models` is unknown", () => {
    const r = checkAgyModels("gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n");
    expect(r.some(c => c.configured === AGY_DEFAULT_MODEL && c.status === "unknown")).toBe(AGY_DEFAULT_MODEL !== "gemini-3.8-flash-high");
  });

  test("agy: every current default is offered by agy 1.5.x", () => {
    const offered = ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
                     "gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"].map(m => `${m}\tx`).join("\n");
    expect(checkAgyModels(offered).every(c => c.status === "ok")).toBe(true);
  });

  test("agy: CLI failure is reported unchecked, not ok", () => {
    expect(checkAgyModels(null)[0]!.status).toBe("unchecked");
  });

  test("codex: previous-generation model is stale and names the newest", () => {
    const r = checkCodexModel('model = "gpt-6-sol"\n', codexList);
    expect(r.status).toBe("stale");
    expect(r.detail).toContain("gpt-6.1-sol");
  });

  test("codex: newest model ok; unlisted model unknown", () => {
    expect(checkCodexModel('model = "gpt-6.1-sol"\n', codexList).status).toBe("ok");
    expect(checkCodexModel('model = "gpt-4-retired"\n', codexList).status).toBe("unknown");
  });

  test("claude: alias ok, pinned id flagged for review", () => {
    expect(checkClaudeModel("sonnet").status).toBe("ok");
    expect(checkClaudeModel("claude-sonnet-4-6").status).toBe("stale");
  });
});
