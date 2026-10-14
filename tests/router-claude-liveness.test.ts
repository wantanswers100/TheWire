// Regression coverage for ISS-023: claude used to be hardcoded
// always-available in WireRouter.isAgentAvailable(), with zero real
// liveness signal. Fixed via a 5-minute cooldown after the most recently
// recorded claude-routed dispatch failure. claudeRecentlyFailed() is
// private — accessed via `as any` for white-box testing, same pattern
// used elsewhere in this suite (e.g. dispatch-loop-archive.test.ts's
// makeLoop(): any).

import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { WireRouter } from "../src/router/index.js";
import { DispatchDB } from "../src/dispatch/db.js";

let testRoot: string;

function makeRoot(): string {
  testRoot = join(tmpdir(), `wire-router-liveness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testRoot, { recursive: true });
  return testRoot;
}

afterEach(() => {
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
});

describe("WireRouter — claude liveness (ISS-023)", () => {
  test("no dispatch.db rows at all — claude reports available", () => {
    const stateDir = makeRoot();
    const router = new WireRouter(stateDir) as any;
    expect(router.claudeRecentlyFailed()).toBe(false);
  });

  test("most recent claude-routed row is 'done' — claude reports available", () => {
    const stateDir = makeRoot();
    const db = new DispatchDB(stateDir);
    db.insert({ id: "t1", from: "codex", skill: "quick", routed_to: "claude", status: "pending", created_at: Date.now() });
    db.update("t1", { status: "done" });

    const router = new WireRouter(stateDir) as any;
    expect(router.claudeRecentlyFailed()).toBe(false);
  });

  test("most recent claude-routed row is 'failed', recent — claude reports unavailable", () => {
    const stateDir = makeRoot();
    const db = new DispatchDB(stateDir);
    db.insert({ id: "t2", from: "codex", skill: "quick", routed_to: "claude", status: "pending", created_at: Date.now() });
    db.update("t2", { status: "failed", error: "spawnSync claude ETIMEDOUT" });

    const router = new WireRouter(stateDir) as any;
    expect(router.claudeRecentlyFailed()).toBe(true);
  });

  test("most recent claude-routed row is 'failed' but outside the cooldown window — claude reports available", () => {
    const stateDir = makeRoot();
    const db = new DispatchDB(stateDir) as any;
    db.insert({ id: "t3", from: "codex", skill: "quick", routed_to: "claude", status: "pending", created_at: Date.now() });
    db.update("t3", { status: "failed", error: "spawnSync claude ETIMEDOUT" });
    // Backdate updated_at past the 5-minute cooldown — direct SQL since
    // update() always stamps Date.now(), no override parameter exists.
    db.db.run("UPDATE dispatch SET updated_at = ? WHERE id = ?", [Date.now() - 10 * 60 * 1000, "t3"]);

    const router = new WireRouter(stateDir) as any;
    expect(router.claudeRecentlyFailed()).toBe(false);
  });

  test("a failure on a different agent does not affect claude's availability", () => {
    const stateDir = makeRoot();
    const db = new DispatchDB(stateDir);
    db.insert({ id: "t4", from: "codex", skill: "research", routed_to: "gemini", status: "pending", created_at: Date.now() });
    db.update("t4", { status: "failed", error: "gemini rate limit" });

    const router = new WireRouter(stateDir) as any;
    expect(router.claudeRecentlyFailed()).toBe(false);
  });
});
