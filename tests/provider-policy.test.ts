import { describe, test, expect } from "bun:test";

import { auditProviderPolicy, formatProviderPolicy, PROVIDER_POLICIES } from "../src/router/providerPolicy.js";
import { buildProviderFallbackPlan, formatProviderFallbackPlan } from "../src/router/providerFallback.js";
import type { RoutingRule } from "../src/router/types.js";

describe("provider policy — free/local first guardrails", () => {
  test("current routing table passes provider policy audit", () => {
    expect(auditProviderPolicy()).toEqual([]);
  });

  test("free-first skills cannot silently prefer paid/high-cost agents", () => {
    const rules: RoutingRule[] = [
      { skill: "summarize", preferredAgent: "claude", fallbackChain: [], costTier: "high" },
    ];

    const findings = auditProviderPolicy(rules);

    expect(findings.some(f => f.code === "free-first-skill" && f.severity === "error")).toBe(true);
  });

  test("research must prefer Gemini with Groq llama4 before Claude fallback", () => {
    const wrongPreferred: RoutingRule[] = [
      { skill: "research", preferredAgent: "claude", fallbackChain: ["gemini"], costTier: "high" },
    ];
    const wrongFallback: RoutingRule[] = [
      { skill: "research", preferredAgent: "gemini", fallbackChain: ["claude", "llama4"], costTier: "low" },
    ];

    expect(auditProviderPolicy(wrongPreferred).some(f => f.code === "research-not-gemini")).toBe(true);
    expect(auditProviderPolicy(wrongFallback).some(f => f.code === "research-fallback-order")).toBe(true);
  });

  test("DeepSeek remains restricted to explicit code/math/logic opt-in route", () => {
    const rules: RoutingRule[] = [
      { skill: "research", preferredAgent: "deepseek", fallbackChain: ["ollama"], costTier: "free" },
    ];

    expect(auditProviderPolicy(rules).some(f => f.code === "deepseek-scope")).toBe(true);
  });

  test("policy output names free providers and never mentions secret values", () => {
    const out = formatProviderPolicy();

    expect(out).toContain("Ollama local open-source models");
    expect(out).toContain("Groq free tier");
    expect(out).toContain("Gemini free API");
    expect(out).toContain("Policy audit: PASS");
    expect(out).toContain("never print API keys");
    expect(out).not.toContain("GROQ_API_KEY=");
    expect(out).not.toContain("GEMINI_API_KEY=");
  });

  test("provider policy covers every currently documented agent profile class", () => {
    const agents = PROVIDER_POLICIES.map(p => p.agent).sort();

    expect(agents).toEqual(["antigravity", "claude", "codex", "deepseek", "gemini", "llama4", "ollama", "system"]);
  });

  test("Gemini pickup requires consent because CLI/API quota may be limited", () => {
    const gemini = PROVIDER_POLICIES.find(p => p.agent === "gemini");

    expect(gemini?.consentRequired).toBe(true);
    expect(gemini?.notes).toContain("foreground consent");
  });
});

describe("provider fallback planner — runtime failure policy", () => {
  test("runs the intended target when the app/provider is available", () => {
    const plan = buildProviderFallbackPlan({ skill: "research", parentAgent: "codex" });

    expect(plan.action).toBe("run_target");
    expect(plan.selectedAgent).toBe("gemini");
    expect(plan.message).toContain("Run gemini");
  });

  test("switches to Groq llama4 free-tier when Gemini quota is exhausted", () => {
    const plan = buildProviderFallbackPlan({
      skill: "research",
      parentAgent: "codex",
      states: { gemini: "quota_exhausted" },
    });

    expect(plan.action).toBe("switch_alternate");
    expect(plan.selectedAgent).toBe("llama4");
    expect(plan.steps[0]).toMatchObject({ agent: "gemini", state: "quota_exhausted", decision: "skipped" });
  });

  test("parent keeps ownership when preferred and alternates are unavailable", () => {
    const plan = buildProviderFallbackPlan({
      skill: "research",
      parentAgent: "codex",
      states: { gemini: "not_running", llama4: "auth_missing", antigravity: "not_running", claude: "usage_exhausted" },
    });

    expect(plan.action).toBe("parent_continue");
    expect(plan.selectedAgent).toBe("codex");
    expect(plan.message).toContain("parent codex keeps ownership");
  });

  test("asks the user before escalating to a high-cost alternate", () => {
    const plan = buildProviderFallbackPlan({
      skill: "scaffold",
      parentAgent: "gemini",
      states: { codex: "usage_exhausted" },
    });

    expect(plan.action).toBe("ask_user");
    expect(plan.selectedAgent).toBe("gemini");
    expect(plan.message).toContain("Ask the owner before escalating to claude");
  });

  test("asks the user before escalating to Codex even though Codex is low-cost", () => {
    const plan = buildProviderFallbackPlan({
      skill: "implement",
      parentAgent: "claude",
      states: { claude: "not_running" },
    });

    expect(plan.action).toBe("ask_user");
    expect(plan.selectedAgent).toBe("claude");
    expect(plan.steps).toContainEqual(expect.objectContaining({
      agent: "codex",
      state: "available",
      decision: "needs_approval",
    }));
    expect(plan.message).toContain("Ask the owner before escalating to codex");
  });

  test("formatted fallback output is presence-only and names no secrets", () => {
    const out = formatProviderFallbackPlan(buildProviderFallbackPlan({
      skill: "research",
      parentAgent: "claude",
      states: { gemini: "auth_missing" },
    }));

    expect(out).toContain("Wire provider fallback plan:");
    expect(out).toContain("auth_missing");
    expect(out).not.toContain("GEMINI_API_KEY=");
    expect(out).not.toContain("GROQ_API_KEY=");
  });
});
