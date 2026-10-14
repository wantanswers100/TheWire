import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronRegistry } from "../src/cron/CronRegistry.js";
import { CronDaemon } from "../src/cron/CronDaemon.js";
import { parseCronExpression, nextRunAfter } from "../src/cron/CronParser.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `wire-cron-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  process.env["WIRE_TEST"] = "1";
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env["WIRE_TEST"];
});

// ─── CronParser ───────────────────────────────────────────────────────────────

describe("CronParser", () => {
  test("parses basic expression", () => {
    const parsed = parseCronExpression("0 8 * * 1");
    expect(parsed.minutes).toEqual([0]);
    expect(parsed.hours).toEqual([8]);
    expect(parsed.daysOfWeek).toEqual([1]);
  });

  test("parses wildcard fields", () => {
    const parsed = parseCronExpression("* * * * *");
    expect(parsed.minutes).toHaveLength(60);
    expect(parsed.hours).toHaveLength(24);
  });

  test("parses step expression", () => {
    const parsed = parseCronExpression("*/15 * * * *");
    expect(parsed.minutes).toEqual([0, 15, 30, 45]);
  });

  test("parses range expression", () => {
    const parsed = parseCronExpression("0 9-17 * * 1-5");
    expect(parsed.hours).toEqual([9,10,11,12,13,14,15,16,17]);
    expect(parsed.daysOfWeek).toEqual([1,2,3,4,5]);
  });

  test("parses list expression", () => {
    const parsed = parseCronExpression("0 8,12,18 * * *");
    expect(parsed.hours).toEqual([8, 12, 18]);
  });

  test("throws on wrong field count", () => {
    expect(() => parseCronExpression("* * * *")).toThrow("5 fields");
  });

  test("nextRunAfter returns future timestamp", () => {
    const now = Date.now();
    const next = nextRunAfter("* * * * *", now);
    expect(next).toBeGreaterThan(now);
  });

  test("nextRunAfter finds correct weekday", () => {
    // Monday=1 at 8:00 — run next occurrence after a fixed Sunday
    const sunday = new Date("2025-01-05T12:00:00").getTime(); // Sunday
    const next = nextRunAfter("0 8 * * 1", sunday);
    const d = new Date(next);
    expect(d.getDay()).toBe(1);  // Monday
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(0);
  });
});

// ─── CronRegistry ─────────────────────────────────────────────────────────────

describe("CronRegistry — HITL skill rejection", () => {
  const forbidden = ["implement", "architect", "scaffold", "refactor", "wire", "system"];

  for (const skill of forbidden) {
    test(`rejects forbidden skill: ${skill}`, () => {
      const reg = new CronRegistry(testDir);
      expect(() =>
        reg.add({ name: `test-${skill}`, schedule: "0 8 * * *", skill: skill as never, subject: "test", domain: ["general"], enabled: true })
      ).toThrow("cannot be scheduled");
    });
  }
});

describe("CronRegistry — safe task scheduling", () => {
  test("adds a job with a safe skill", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({
      name: "daily-summary",
      schedule: "0 8 * * *",
      skill: "summarize",
      subject: "daily standup",
      domain: ["general"],
      enabled: true,
    });
    expect(entry.id).toBeGreaterThan(0);
    expect(entry.name).toBe("daily-summary");
    expect(entry.skill).toBe("summarize");
    expect(entry.next_run).toBeGreaterThan(Date.now());
    expect(entry.run_count).toBe(0);
    expect(entry.fail_count).toBe(0);
  });

  test("lists added jobs", () => {
    const reg = new CronRegistry(testDir);
    reg.add({ name: "job-a", schedule: "*/5 * * * *", skill: "quick", subject: "ping", domain: ["general"], enabled: true });
    reg.add({ name: "job-b", schedule: "0 9 * * *", skill: "research", subject: "news", domain: ["general"], enabled: true });
    const jobs = reg.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.map(j => j.name)).toContain("job-a");
  });

  test("getByName returns correct entry", () => {
    const reg = new CronRegistry(testDir);
    reg.add({ name: "named-job", schedule: "0 * * * *", skill: "quick", subject: "hourly", domain: ["general"], enabled: true });
    const found = reg.getByName("named-job");
    expect(found).not.toBeNull();
    expect(found!.schedule).toBe("0 * * * *");
  });

  test("remove deletes job", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({ name: "to-delete", schedule: "0 8 * * *", skill: "quick", subject: "x", domain: ["general"], enabled: true });
    const removed = reg.remove(entry.id);
    expect(removed).toBe(true);
    expect(reg.get(entry.id)).toBeNull();
  });

  test("listDue returns overdue jobs only", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({ name: "overdue", schedule: "0 8 * * *", skill: "quick", subject: "x", domain: ["general"], enabled: true });
    // Force next_run into the past
    (reg as unknown as { db: { run: (sql: string, args: unknown[]) => void } })
      .db.run("UPDATE cron_entries SET next_run = ? WHERE id = ?", [Date.now() - 60_000, entry.id]);
    const due = reg.listDue(Date.now());
    expect(due.map(j => j.id)).toContain(entry.id);
  });

  test("listDue excludes disabled jobs", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({ name: "disabled-job", schedule: "0 8 * * *", skill: "quick", subject: "x", domain: ["general"], enabled: false });
    (reg as unknown as { db: { run: (sql: string, args: unknown[]) => void } })
      .db.run("UPDATE cron_entries SET next_run = ? WHERE id = ?", [Date.now() - 60_000, entry.id]);
    const due = reg.listDue(Date.now());
    expect(due.map(j => j.id)).not.toContain(entry.id);
  });

  test("advanceNextRun increments run_count and sets future next_run", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({ name: "advance-test", schedule: "*/5 * * * *", skill: "quick", subject: "x", domain: ["general"], enabled: true });
    reg.advanceNextRun(entry.id, entry.schedule);
    const updated = reg.get(entry.id)!;
    expect(updated.run_count).toBe(1);
    expect(updated.next_run).toBeGreaterThan(Date.now());
  });

  test("rejects duplicate job names", () => {
    const reg = new CronRegistry(testDir);
    reg.add({ name: "unique", schedule: "0 8 * * *", skill: "quick", subject: "x", domain: ["general"], enabled: true });
    expect(() =>
      reg.add({ name: "unique", schedule: "0 9 * * *", skill: "quick", subject: "y", domain: ["general"], enabled: true })
    ).toThrow();
  });

  test("recordRunStart + recordRunComplete creates audit record", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({ name: "audit-test", schedule: "0 8 * * *", skill: "quick", subject: "x", domain: ["general"], enabled: true });
    const runId = reg.recordRunStart(entry.id);
    expect(runId).toBeGreaterThan(0);
    reg.recordRunComplete(runId, "task-abc-123");
    const runs = reg.recentRuns(entry.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
    expect(runs[0]!.dispatch_task_id).toBe("task-abc-123");
  });

  test("recordRunComplete with error sets failed status", () => {
    const reg = new CronRegistry(testDir);
    const entry = reg.add({ name: "fail-test", schedule: "0 8 * * *", skill: "quick", subject: "x", domain: ["general"], enabled: true });
    const runId = reg.recordRunStart(entry.id);
    reg.recordRunComplete(runId, null, "dispatch failed: network error");
    const runs = reg.recentRuns(entry.id);
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.error).toBe("dispatch failed: network error");
  });
});

// ─── CronDaemon — WIRE_TEST no-op guard ──────────────────────────────────────

describe("CronDaemon", () => {
  test("does not start timer in WIRE_TEST=1 mode", () => {
    process.env["WIRE_TEST"] = "1";
    const inboxDir = join(testDir, "inbox");
    const daemon = new CronDaemon({ stateDir: testDir, inboxDir });
    daemon.start();
    expect(daemon.isRunning()).toBe(false);
    daemon.stop();
  });
});
