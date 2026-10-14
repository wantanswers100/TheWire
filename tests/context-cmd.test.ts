import { describe, expect, test } from "bun:test";

import { projectStatePartsFromStatus, recentDevlogHeadings } from "../src/cli/context-cmd.js";

describe("wire context — status/devlog parsing", () => {
  test("uses the top-level Phase field instead of unrelated historical phase text", () => {
    const parts = projectStatePartsFromStatus([
      "# STATUS",
      "**Phase:** 44 complete + explicit pickup — 452/452 tests passing",
      "**State:** ACTIVE — current work",
      "",
      "Historical note: Phase 23 said something else.",
    ].join("\n"));

    expect(parts).toEqual(["44 complete + explicit pickup", "452/452 tests", "ACTIVE"]);
  });

  test("recognizes ISO timestamp DEVLOG headings and date-only headings", () => {
    const headings = recentDevlogHeadings([
      "## 2026-08-11T23:15:00Z — Wire agent pickup security/docs review",
      "## 2026-08-02 — Older doc pass",
      "## Not a dated heading",
    ].join("\n"));

    expect(headings).toEqual([
      "2026-08-11T23:15:00Z — Wire agent pickup security/docs review",
      "2026-08-02 — Older doc pass",
    ]);
  });
});
