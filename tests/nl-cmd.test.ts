// Tests for src/cli/nl-cmd.ts — RES-063
//
// Regression coverage for the --to / isShellIntent interaction the security review caught
// in diff-review before merge: `--to` must never silence the isLinuxIntent
// backstop, and must be validated at parse time against a real AgentId set.

import { describe, test, expect } from "bun:test";
import { parseFlags, computeIsShellIntent } from "../src/cli/nl-cmd.js";

describe("computeIsShellIntent", () => {
  test("plain conversational text is not shell intent", () => {
    expect(computeIsShellIntent(false, "explain", "summarize my standup notes")).toBe(false);
  });

  test("--shell flag always forces shell intent", () => {
    expect(computeIsShellIntent(true, "explain", "summarize my standup notes")).toBe(true);
  });

  test("classifier tagging skill=system forces shell intent", () => {
    expect(computeIsShellIntent(false, "system", "do a thing")).toBe(true);
  });

  test("isLinuxIntent backstop fires on raw shell-like text with no --to involved", () => {
    expect(computeIsShellIntent(false, "explain", "show me my disk usage")).toBe(true);
  });

  // The actual regression: before RES-063, this same call was gated behind
  // `!flags.to` at the call site in runNl(), so supplying --to (any value)
  // silenced this exact detection. computeIsShellIntent no longer takes a
  // `to`/AgentId parameter at all — proof by construction that the routing
  // destination cannot suppress detection, not just a test that happens to
  // pass today.
  test("shell-like phrasing is still caught regardless of a routing override — RES-063", () => {
    // A shell-sounding request the classifier might mis-tag (skill !== "system")
    // must still trip the isLinuxIntent backstop — verified against the actual
    // pattern in classifier.ts (`disk (usage|space|free|used)`), not an assumed one.
    expect(computeIsShellIntent(false, "explain", "show me my disk usage")).toBe(true);
  });
});

describe("parseFlags — --to validation (RES-063)", () => {
  test("accepts a valid non-system agent", () => {
    const { flags } = parseFlags(["do", "a", "thing", "--to", "codex"]);
    expect(flags.to).toBe("codex");
  });

  test("rejects an unknown agent id instead of passing it through unchecked", () => {
    expect(() => parseFlags(["do", "a", "thing", "--to", "not-a-real-agent"])).toThrow(
      /not a valid agent/,
    );
  });

  test("rejects --to system explicitly — shell execution must go through the HITL path", () => {
    expect(() => parseFlags(["do", "a", "thing", "--to", "system"])).toThrow(/--to system is not supported/);
  });

  test("rejects a missing value after --to", () => {
    expect(() => parseFlags(["do", "a", "thing", "--to"])).toThrow(/requires a value/);
  });

  test("--from is validated the same way", () => {
    expect(() => parseFlags(["do", "a", "thing", "--from", "not-a-real-agent"])).toThrow(
      /not a valid agent/,
    );
  });
});

import { confirmationNeeded } from "../src/cli/nl-cmd.js";

describe("confirmationNeeded", () => {
  test("high confidence: no plan, no prompt", () => {
    expect(confirmationNeeded({ confidence: 0.9 })).toEqual({ showPlan: false, ask: false });
  });
  test("mid confidence without --to: plan + prompt", () => {
    expect(confirmationNeeded({ confidence: 0.62 })).toEqual({ showPlan: true, ask: true });
  });
  test("explicit --to counts as the confirmation: plan shown, no prompt", () => {
    expect(confirmationNeeded({ confidence: 0.62, to: "ollama" })).toEqual({ showPlan: true, ask: false });
  });
  test("--confirm forces the prompt even with --to", () => {
    expect(confirmationNeeded({ confidence: 0.95, to: "ollama", confirm: true })).toEqual({ showPlan: true, ask: true });
  });
  test("--dry-run shows the plan and never asks", () => {
    expect(confirmationNeeded({ confidence: 0.5, dryRun: true })).toEqual({ showPlan: true, ask: false });
  });
});
