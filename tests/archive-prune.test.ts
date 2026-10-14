// Regression coverage for the .processed/ archive-pruning gap found during
// the 2026-08-12 stale-item review: archiveInboxFile() (ISS-033) relocates
// fully-handled inbox files into inboxDir/.processed/ but nothing pruned that
// directory itself — this covers pruneProcessedArchiveCore(), the fix.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { pruneProcessedArchiveCore } from "../src/dispatch/archivePrune.js";

let testRoot: string;
let inboxDir: string;
let processedDir: string;

function writeAged(name: string, ageDays: number): void {
  const p = join(processedDir, name);
  writeFileSync(p, "content", "utf8");
  const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(p, past, past);
}

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-archive-prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  inboxDir = join(testRoot, "inbox");
  processedDir = join(inboxDir, ".processed");
  mkdirSync(processedDir, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("pruneProcessedArchiveCore()", () => {
  test("no .processed/ dir at all — reports zero, never creates it", () => {
    rmSync(processedDir, { recursive: true, force: true });
    const result = pruneProcessedArchiveCore(inboxDir, false, 30);
    expect(result.scanned).toBe(0);
    expect(result.eligible.length).toBe(0);
    expect(existsSync(processedDir)).toBe(false);
  });

  test("files older than the threshold are eligible; newer ones are not", () => {
    writeAged("old.wire.json", 45);
    writeAged("new.wire.json", 2);

    const result = pruneProcessedArchiveCore(inboxDir, false, 30);
    expect(result.scanned).toBe(2);
    expect(result.eligible.map(c => c.filename)).toEqual(["old.wire.json"]);
    expect(result.deleted.length).toBe(0); // dry-run
  });

  test("dry-run (apply=false) never deletes anything", () => {
    writeAged("old.wire.json", 45);
    pruneProcessedArchiveCore(inboxDir, false, 30);
    expect(existsSync(join(processedDir, "old.wire.json"))).toBe(true);
  });

  test("apply=true deletes only the eligible files, leaves newer ones untouched", () => {
    writeAged("old.wire.json", 45);
    writeAged("new.wire.json", 2);

    const result = pruneProcessedArchiveCore(inboxDir, true, 30);
    expect(result.deleted.map(c => c.filename)).toEqual(["old.wire.json"]);
    expect(existsSync(join(processedDir, "old.wire.json"))).toBe(false);
    expect(existsSync(join(processedDir, "new.wire.json"))).toBe(true);
  });

  test("never touches files in the active inbox, only .processed/", () => {
    const activeFile = join(inboxDir, "still-active.wire.json");
    writeFileSync(activeFile, "content", "utf8");
    const past = new Date(Date.now() - 999 * 24 * 60 * 60 * 1000);
    utimesSync(activeFile, past, past);

    const result = pruneProcessedArchiveCore(inboxDir, true, 30);
    expect(result.scanned).toBe(0); // .processed/ is empty; active inbox is never scanned
    expect(existsSync(activeFile)).toBe(true);
  });

  test("never recurses into subdirectories of .processed/", () => {
    mkdirSync(join(processedDir, "subdir"), { recursive: true });
    writeFileSync(join(processedDir, "subdir", "nested.wire.json"), "content", "utf8");

    const result = pruneProcessedArchiveCore(inboxDir, true, 0);
    expect(result.scanned).toBe(0); // the directory entry itself is skipped, not descended into
    expect(existsSync(join(processedDir, "subdir", "nested.wire.json"))).toBe(true);
  });

  test("custom olderThanDays threshold is respected", () => {
    writeAged("medium.wire.json", 10);

    const strict = pruneProcessedArchiveCore(inboxDir, false, 5);
    expect(strict.eligible.length).toBe(1);

    const lenient = pruneProcessedArchiveCore(inboxDir, false, 20);
    expect(lenient.eligible.length).toBe(0);
  });
});
