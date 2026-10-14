// Tests for ISS-052: awaiting_review recovery path in DispatchDB.
// Covers listAwaitingReview(), claimAwaitingReview(), and rejectAwaitingReview().

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DispatchDB } from "../src/dispatch/db.js";

const makeDir = () => {
  const d = join(tmpdir(), `wire-db-review-test-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const baseRecord = (id: string, status: string = "awaiting_review") => ({
  id,
  from: "claude",
  skill: "quick",
  routed_to: "ollama",
  status: status as import("../src/dispatch/db.js").DispatchStatus,
  created_at: Date.now(),
  error: status === "awaiting_review" ? "PhaseGate escalated: quality check failed" : null,
});

describe("DispatchDB — awaiting_review recovery (ISS-052)", () => {
  let dir: string;
  let db: DispatchDB;

  beforeEach(() => {
    dir = makeDir();
    db = new DispatchDB(dir);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("listAwaitingReview returns empty when no escalated tasks", () => {
    expect(db.listAwaitingReview()).toEqual([]);
  });

  test("listAwaitingReview returns only awaiting_review records", () => {
    db.insert(baseRecord("aaa-0001"));
    db.insert(baseRecord("aaa-0002", "done"));
    db.insert(baseRecord("aaa-0003", "failed"));

    const rows = db.listAwaitingReview();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("aaa-0001");
    expect(rows[0]!.status).toBe("awaiting_review");
  });

  test("listAwaitingReview returns multiple escalated tasks", () => {
    db.insert(baseRecord("bbb-0001"));
    db.insert(baseRecord("bbb-0002"));
    db.insert(baseRecord("bbb-0003"));

    const rows = db.listAwaitingReview();
    expect(rows).toHaveLength(3);
    expect(rows.every(r => r.status === "awaiting_review")).toBe(true);
  });

  test("claimAwaitingReview transitions awaiting_review → done", () => {
    db.insert(baseRecord("ccc-0001"));

    const ok = db.claimAwaitingReview("ccc-0001");
    expect(ok).toBe(true);

    const updated = db.get("ccc-0001");
    expect(updated?.status).toBe("done");
  });

  test("claimAwaitingReview returns false for non-existent id", () => {
    const ok = db.claimAwaitingReview("does-not-exist");
    expect(ok).toBe(false);
  });

  test("claimAwaitingReview returns false for task not in awaiting_review", () => {
    db.insert(baseRecord("ddd-0001", "done"));

    const ok = db.claimAwaitingReview("ddd-0001");
    expect(ok).toBe(false);

    const record = db.get("ddd-0001");
    expect(record?.status).toBe("done");
  });

  test("claimAwaitingReview is idempotent — second call fails", () => {
    db.insert(baseRecord("eee-0001"));

    const first = db.claimAwaitingReview("eee-0001");
    const second = db.claimAwaitingReview("eee-0001");

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("rejectAwaitingReview transitions awaiting_review → rejected", () => {
    db.insert(baseRecord("fff-0001"));

    const ok = db.rejectAwaitingReview("fff-0001");
    expect(ok).toBe(true);

    const updated = db.get("fff-0001");
    expect(updated?.status).toBe("rejected");
  });

  test("rejectAwaitingReview returns false for non-existent id", () => {
    const ok = db.rejectAwaitingReview("does-not-exist");
    expect(ok).toBe(false);
  });

  test("rejectAwaitingReview returns false for task not in awaiting_review", () => {
    db.insert(baseRecord("ggg-0001", "done"));

    const ok = db.rejectAwaitingReview("ggg-0001");
    expect(ok).toBe(false);
  });

  test("approved task no longer appears in listAwaitingReview", () => {
    db.insert(baseRecord("hhh-0001"));
    db.insert(baseRecord("hhh-0002"));

    db.claimAwaitingReview("hhh-0001");

    const rows = db.listAwaitingReview();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("hhh-0002");
  });

  test("rejected task no longer appears in listAwaitingReview", () => {
    db.insert(baseRecord("iii-0001"));

    db.rejectAwaitingReview("iii-0001");

    expect(db.listAwaitingReview()).toHaveLength(0);
  });

  test("error field preserved and readable for escalated tasks", () => {
    db.insert(baseRecord("jjj-0001"));

    const rows = db.listAwaitingReview();
    expect(rows[0]!.error).toBe("PhaseGate escalated: quality check failed");
  });
});
