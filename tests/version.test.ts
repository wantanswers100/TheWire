// Release-version guard: package.json is the single version source, and every
// release must add a matching CHANGELOG.md section. This fails the pre-commit
// hook if one is bumped without the other, so the number users see (`wire
// --version`, banner, `wire status`) always has release notes behind it.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION } from "../src/version.js";
import { WIRE_VERSION } from "../src/types.js";

const ROOT = join(import.meta.dir, "..");
const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

// "## 1.1.0 — 2026-09-30" → ["1.1.0", "2026-09-30"]
const entries = [...changelog.matchAll(/^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/gm)].map(m => ({
  version: m[1]!,
  date: m[2]!,
}));

function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

describe("release version", () => {
  test("APP_VERSION is package.json's version and is SemVer", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("newest CHANGELOG.md section matches package.json", () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.version).toBe(APP_VERSION);
  });

  test("CHANGELOG.md versions are unique and strictly descending, dates non-increasing", () => {
    for (let i = 1; i < entries.length; i++) {
      expect(cmp(entries[i - 1]!.version, entries[i]!.version)).toBeGreaterThan(0);
      expect(entries[i - 1]!.date >= entries[i]!.date).toBe(true);
    }
  });

  test("app version is independent of the envelope protocol version", () => {
    // WireProtocol v1 must not be bumped by an ordinary release.
    expect(WIRE_VERSION).toBe("1");
  });
});

describe("release check helpers", () => {
  test("compareVersions orders numerically, not as strings", async () => {
    const { compareVersions } = await import("../src/version.js");
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.1.0", "v1.1.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.1.0")).toBeLessThan(0);
  });

  test("newestReleaseTag picks the highest vX.Y.Z and ignores other tags", async () => {
    const { newestReleaseTag } = await import("../src/version.js");
    const out = [
      "a1\trefs/tags/phase/46",
      "b2\trefs/tags/v1.9.0",
      "c3\trefs/tags/v1.10.0",
      "d4\trefs/tags/v1.2.0-rc1",
      "e5\trefs/tags/v1.1.0",
    ].join("\n");
    expect(newestReleaseTag(out)).toBe("v1.10.0");
    expect(newestReleaseTag("")).toBeUndefined();
  });
});
