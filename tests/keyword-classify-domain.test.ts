// Regression coverage for ISS-028: keywordClassify() must never return an
// empty `domains` array. WireSpec's schema requires at least one domain
// entry (see ISSUES.md ISS-028) — a payload built with domains:[] is
// guaranteed to fail schema validation and, before this fix, was silently
// discarded by processFile() with zero trace. keywordClassify() is the
// fallback used when the qwen3:4b classifier is unavailable or times out —
// i.e. exactly the scenario where this matters most — so every one of its
// return branches needs coverage, not just a couple of examples.

import { describe, test, expect } from "bun:test";
import { keywordClassify } from "../src/router/classifier.js";

describe("keywordClassify() — non-empty domains (ISS-028)", () => {
  // One representative input per branch in keywordClassify(), in the same
  // order as the function's if/else chain, so a future branch reordering or
  // addition that reintroduces an empty domains[] gets caught immediately.
  const casesByBranch: Array<[string, string]> = [
    ["linux/system intent", "show me my disk usage"],
    ["debug", "there's a bug in the login flow"],
    ["summarize", "summarize my standup notes"],
    ["implement", "implement a new export function"],
    ["refactor", "refactor this messy module"],
    ["code_review", "review this pull request"],
    ["plan", "design a plan for the migration"],
    ["live/factual research", "what's the weather today"],
    ["research", "research UK housing policy"],
    ["explain", "explain how the dispatch loop works"],
    ["default catch-all", "asdkjfh qwerty nonsense input"],
  ];

  for (const [label, input] of casesByBranch) {
    test(`branch: ${label} → non-empty domains`, () => {
      const result = keywordClassify(input);
      expect(Array.isArray(result.domains)).toBe(true);
      expect(result.domains!.length).toBeGreaterThan(0);
    });
  }

  test("every branch's domains survive JSON round-trip as a valid array (not just non-empty in memory)", () => {
    for (const [, input] of casesByBranch) {
      const result = keywordClassify(input);
      const roundTripped = JSON.parse(JSON.stringify({ domain: result.domains }));
      expect(Array.isArray(roundTripped.domain)).toBe(true);
      expect(roundTripped.domain.length).toBeGreaterThan(0);
    }
  });
});
