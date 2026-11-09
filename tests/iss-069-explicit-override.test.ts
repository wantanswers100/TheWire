// Regression coverage for ISS-069: an explicit agent override was silently
// re-routed. `wire ask --to codex` / `wire task --to codex` for code_review
// (whose rule chain is ollama → claude) fell through to the claude last
// resort; `wire task --skill code` printed "Task queued" while the daemon
// discarded the file as schema_invalid; and dispatched subjects were cut at
// 80 characters, dropping file paths from handoff instructions.

import { describe, test, expect, afterEach, spyOn } from "bun:test";
import { rmSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WireRouter } from "../src/router/index.js";
import { runTask } from "../src/cli/task-cmd.js";
import { keywordClassify } from "../src/router/classifier.js";

let testRoot: string;

function makeRoot(): string {
  testRoot = join(tmpdir(), `wire-iss069-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  return testRoot;
}

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
});

function rules(router: any, skill: string, filter: string[]) {
  return router.routeByRules(
    { skill, verb: "review", domains: [], type: "task", modelFilter: new Set(filter) },
    true, true, "balanced", [],
  );
}

describe("WireRouter — explicit override is never substituted (ISS-069)", () => {
  test("code_review with modelFilter={codex} routes to codex, not claude", () => {
    const decision = rules(new WireRouter(makeRoot()), "code_review", ["codex"]);
    expect(decision.agent).toBe("codex");
    expect(decision.rule).toBe("explicit-override");
    expect(decision.fallbacksAvailable).not.toContain("claude");
  });

  test("an unavailable filtered agent is still attempted rather than replaced", () => {
    const router = new WireRouter(makeRoot()) as any;
    const decision = router.routeByRules(
      { skill: "code_review", verb: "review", domains: [], type: "task", modelFilter: new Set(["codex"]) },
      false, true, "balanced", [],  // gateway down → codex unavailable
    );
    expect(decision.agent).toBe("codex");
    expect(decision.fallbacksAvailable).toEqual([]);
  });

  test("no filter keeps existing claude default routing", () => {
    const router = new WireRouter(makeRoot()) as any;
    const decision = router.routeByRules(
      { skill: "nonexistent_skill", verb: "review", domains: [], type: "task" },
      true, true, "balanced", [],
    );
    expect(decision.agent).toBe("claude");
    expect(decision.rule).not.toBe("explicit-override");
  });
});

describe("wire task — rejects what the daemon would discard (ISS-069)", () => {
  test("invalid --skill exits non-zero and writes nothing", async () => {
    const inbox = join(makeRoot(), "inbox");
    mkdirSync(inbox, { recursive: true });
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as any);
    const err = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(runTask(["--to", "codex", "--skill", "code", "--verb", "review", "--subject", "x"], "", "", inbox))
        .rejects.toThrow("exit:1");
      expect(readdirSync(inbox)).toEqual([]);
    } finally {
      exit.mockRestore();
      err.mockRestore();
    }
  });
});

describe("dispatched subject is not truncated (ISS-069)", () => {
  test("keyword classification keeps a long handoff path intact", () => {
    const path = "/home/user/projects/inbox/claude_codex_20261108_165607_example-project.md";
    const result = keywordClassify(`please debug the failing handoff brief at ${path}`);
    expect(result.subject?.length ?? 0).toBeGreaterThan(80);
    expect(result.subject).toContain(path);
  });
});
