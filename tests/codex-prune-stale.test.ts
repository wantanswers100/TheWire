import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pruneStaleCore } from "../src/dispatch/codexPruneStale.js";
import { DispatchDB } from "../src/dispatch/db.js";
import type { DispatchRecord } from "../src/dispatch/db.js";

let testRoot: string;
let stateDir: string;
let inboxDir: string;

function seedRow(overrides: Partial<Omit<DispatchRecord, "updated_at">> = {}): string {
  const id = overrides.id ?? `row-${Math.random().toString(36).slice(2)}`;
  const db = new DispatchDB(stateDir);
  db.insert({
    id,
    from: "claude",
    skill: "THINK",
    routed_to: "codex",
    status: "awaiting_hitl",
    created_at: Date.now(),
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-codex-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  stateDir = join(testRoot, ".wire-state");
  inboxDir = join(testRoot, "inbox");
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ─── Dry-run lists stale eligible rows, mutates nothing ────────────────────

describe("pruneStaleCore — dry-run", () => {
  test("lists a stale awaiting_hitl row and a stale quarantined row, mutates nothing", () => {
    const id1 = seedRow({ status: "awaiting_hitl", skill: "THINK", source_file: "gone-1.md" });
    const id2 = seedRow({ status: "quarantined", skill: "quarantine", source_file: "gone-2.md" });

    const result = pruneStaleCore(stateDir, false, inboxDir);

    expect(result.applied).toBe(false);
    expect(result.eligible.map(c => c.id).sort()).toEqual([id1, id2].sort());
    expect(result.deleted).toHaveLength(0);

    // still present in the DB — dry-run must not mutate
    const db = new DispatchDB(stateDir);
    expect(db.get(id1)).not.toBeNull();
    expect(db.get(id2)).not.toBeNull();
  });
});

// ─── --apply deletes only the eligible rows ─────────────────────────────────

describe("pruneStaleCore — apply", () => {
  test("deletes only the eligible stale rows", () => {
    const idStale = seedRow({ status: "awaiting_hitl", source_file: "gone.md" });
    const idFresh = seedRow({ status: "awaiting_hitl", source_file: "present.md" });
    writeFileSync(join(inboxDir, "present.md"), "still here\n", "utf8");

    const result = pruneStaleCore(stateDir, true, inboxDir);

    expect(result.applied).toBe(true);
    expect(result.deleted.map(c => c.id)).toEqual([idStale]);

    const db = new DispatchDB(stateDir);
    expect(db.get(idStale)).toBeNull();
    expect(db.get(idFresh)).not.toBeNull();
  });
});

// ─── done/failed/policy_violation rows preserved regardless of file state ──

describe("pruneStaleCore — terminal statuses are never eligible", () => {
  test("a done row with a missing source_file is preserved (real grounding case)", () => {
    const id = seedRow({ status: "done", source_file: "long-gone.md" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });

  test("a failed row with a missing source_file is preserved", () => {
    const id = seedRow({ status: "failed", source_file: "long-gone-2.md" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });

  test("a policy_violation row with a missing source_file is preserved", () => {
    const id = seedRow({ status: "policy_violation", source_file: "long-gone-3.md" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });

  test("running/pending/routing rows with missing source_file are preserved", () => {
    const idRunning = seedRow({ status: "running", source_file: "gone-r.md" });
    const idPending = seedRow({ status: "pending", source_file: "gone-p.md" });
    const idRouting = seedRow({ status: "routing", source_file: "gone-ro.md" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    const eligibleIds = result.eligible.map(c => c.id);
    expect(eligibleIds).not.toContain(idRunning);
    expect(eligibleIds).not.toContain(idPending);
    expect(eligibleIds).not.toContain(idRouting);
    const db = new DispatchDB(stateDir);
    expect(db.get(idRunning)).not.toBeNull();
    expect(db.get(idPending)).not.toBeNull();
    expect(db.get(idRouting)).not.toBeNull();
  });
});

// ─── Existing-source awaiting/quarantined rows preserved ────────────────────

describe("pruneStaleCore — existing source_file means not stale", () => {
  test("awaiting_hitl row whose source_file exists is preserved", () => {
    const id = seedRow({ status: "awaiting_hitl", source_file: "here.md" });
    writeFileSync(join(inboxDir, "here.md"), "content\n", "utf8");
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });
});

// ─── null/empty source_file skipped ─────────────────────────────────────────

describe("pruneStaleCore — missing source_file is skipped, not treated as stale", () => {
  test("row with no source_file at all is never eligible", () => {
    const id = seedRow({ status: "awaiting_hitl" }); // no source_file key
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(result.noSourceSkipped).toBeGreaterThanOrEqual(1);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });

  test("row with empty-string source_file is never eligible", () => {
    const id = seedRow({ status: "quarantined", source_file: "" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });
});

// ─── Non-codex rows untouched ────────────────────────────────────────────────

describe("pruneStaleCore — non-codex rows never considered", () => {
  test("a gemini-routed row, even if awaiting_hitl-like and stale, is left alone", () => {
    const db = new DispatchDB(stateDir);
    const id = "gemini-row";
    db.insert({ id, from: "claude", skill: "THINK", routed_to: "gemini", status: "awaiting_hitl", created_at: Date.now(), source_file: "gone.md" });

    const result = pruneStaleCore(stateDir, true, inboxDir);

    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(db.get(id)).not.toBeNull();
  });
});

// ─── Unsafe source_file values skipped, never resolved ──────────────────────

describe("pruneStaleCore — unsafe source_file values are skipped, not resolved", () => {
  test("a source_file containing a path separator is skipped", () => {
    const id = seedRow({ status: "awaiting_hitl", source_file: "../../etc/passwd" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(result.unsafeSkipped.map(c => c.id)).toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });

  test("an absolute path source_file is skipped", () => {
    const id = seedRow({ status: "quarantined", source_file: "/etc/passwd" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(result.unsafeSkipped.map(c => c.id)).toContain(id);
    expect(new DispatchDB(stateDir).get(id)).not.toBeNull();
  });

  test("a source_file containing a subdirectory is skipped", () => {
    const id = seedRow({ status: "awaiting_hitl", source_file: "subdir/file.md" });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(result.unsafeSkipped.map(c => c.id)).toContain(id);
  });

  test("a plain '..' source_file is skipped", () => {
    const id = seedRow({ status: "awaiting_hitl", source_file: ".." });
    const result = pruneStaleCore(stateDir, true, inboxDir);
    expect(result.eligible.map(c => c.id)).not.toContain(id);
    expect(result.unsafeSkipped.map(c => c.id)).toContain(id);
  });
});

// ─── Dry-run eligibility exactly matches apply eligibility ──────────────────

describe("pruneStaleCore — dry-run/apply parity", () => {
  test("dry-run's eligible list matches exactly what --apply deletes", () => {
    const id1 = seedRow({ status: "awaiting_hitl", source_file: "gone-a.md" });
    const id2 = seedRow({ status: "quarantined", source_file: "gone-b.md" });
    const id3 = seedRow({ status: "awaiting_hitl", source_file: "present-c.md" });
    writeFileSync(join(inboxDir, "present-c.md"), "here\n", "utf8");

    const dry = pruneStaleCore(stateDir, false, inboxDir);
    const dryIds = dry.eligible.map(c => c.id).sort();

    const applied = pruneStaleCore(stateDir, true, inboxDir);
    const appliedIds = applied.eligible.map(c => c.id).sort();

    expect(dryIds).toEqual(appliedIds);
    expect(dryIds).toEqual([id1, id2].sort());
    expect(dryIds).not.toContain(id3);
  });
});

// ─── Second apply is idempotent ──────────────────────────────────────────────

describe("pruneStaleCore — idempotent on repeated apply", () => {
  test("running --apply a second time reports nothing to prune", () => {
    seedRow({ status: "awaiting_hitl", source_file: "gone-once.md" });
    const first = pruneStaleCore(stateDir, true, inboxDir);
    expect(first.deleted.length).toBeGreaterThanOrEqual(1);

    const second = pruneStaleCore(stateDir, true, inboxDir);
    expect(second.eligible).toHaveLength(0);
    expect(second.deleted).toHaveLength(0);
  });
});

// ─── Unlimited scan — no old row silently missed ────────────────────────────

describe("pruneStaleCore — scans all rows, not a capped subset", () => {
  test("a row seeded far in the past is still scanned and eligible if stale", () => {
    const oldId = seedRow({ status: "awaiting_hitl", source_file: "ancient.md", created_at: 1 });
    // Seed a bunch of newer rows to make sure the old one isn't pushed out
    // of any accidental LIMIT.
    for (let i = 0; i < 30; i++) {
      seedRow({ status: "done", source_file: `newer-${i}.md`, created_at: Date.now() - i });
    }
    const result = pruneStaleCore(stateDir, false, inboxDir);
    expect(result.scanned).toBeGreaterThanOrEqual(31);
    expect(result.eligible.map(c => c.id)).toContain(oldId);
  });
});
