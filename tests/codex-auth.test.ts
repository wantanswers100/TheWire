import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkCodexAuth } from "../src/dispatch/codexAuth.js";
import { statusCore } from "../src/cli/codex-cmd.js";

let testRoot: string;
let authPath: string;
let stateDir: string;

beforeEach(() => {
  testRoot = join(tmpdir(), `wire-codex-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  authPath = join(testRoot, ".codex", "auth.json");
  stateDir = join(testRoot, ".wire-state");
  mkdirSync(testRoot, { recursive: true });
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

const FAKE_SECRET = "sk-test-fake-secret-marker-1234567890abcdef";

// ─── checkCodexAuth ──────────────────────────────────────────────────────────

describe("checkCodexAuth — env-based signals", () => {
  test("env OPENAI_API_KEY present, no auth file -> configured", () => {
    const result = checkCodexAuth({ OPENAI_API_KEY: "sk-whatever" }, authPath);
    expect(result.configured).toBe(true);
    expect(result.envApiKeyPresent).toBe(true);
    expect(result.envSessionTokenPresent).toBe(false);
    expect(result.authFilePresent).toBe(false);
  });

  test("env OPENAI_SESSION_TOKEN present, no auth file -> configured", () => {
    const result = checkCodexAuth({ OPENAI_SESSION_TOKEN: "session-whatever" }, authPath);
    expect(result.configured).toBe(true);
    expect(result.envSessionTokenPresent).toBe(true);
  });

  test("no env vars, no auth file -> not configured", () => {
    const result = checkCodexAuth({}, authPath);
    expect(result.configured).toBe(false);
    expect(result.envApiKeyPresent).toBe(false);
    expect(result.envSessionTokenPresent).toBe(false);
    expect(result.authFilePresent).toBe(false);
  });
});

describe("checkCodexAuth — auth file presence (the actual fix)", () => {
  test("no env vars, readable non-empty auth file -> configured via file", () => {
    mkdirSync(join(testRoot, ".codex"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ token: FAKE_SECRET }), "utf8");

    const result = checkCodexAuth({}, authPath);
    expect(result.configured).toBe(true);
    expect(result.authFilePresent).toBe(true);
    expect(result.envApiKeyPresent).toBe(false);
    expect(result.envSessionTokenPresent).toBe(false);
    expect(result.authFileAgeDays).toBeGreaterThanOrEqual(0);
    expect(result.authFileAgeDays).toBeLessThan(1); // just created
  });

  test("auth file missing entirely -> not configured", () => {
    const result = checkCodexAuth({}, authPath); // .codex/ dir never created
    expect(result.authFilePresent).toBe(false);
    expect(result.configured).toBe(false);
  });

  test("auth file exists but unreadable (chmod 000) -> not configured (fail closed)", () => {
    mkdirSync(join(testRoot, ".codex"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ token: FAKE_SECRET }), "utf8");
    try {
      chmodSync(authPath, 0o000);
    } catch {
      return; // permission manipulation unsupported in this environment — skip
    }
    try {
      const result = checkCodexAuth({}, authPath);
      expect(result.authFilePresent).toBe(false);
      expect(result.configured).toBe(false);
    } finally {
      chmodSync(authPath, 0o600); // restore so afterEach's rmSync can clean up
    }
  });

  test("auth file exists but is zero bytes -> not configured", () => {
    mkdirSync(join(testRoot, ".codex"), { recursive: true });
    writeFileSync(authPath, "", "utf8");
    const result = checkCodexAuth({}, authPath);
    expect(result.authFilePresent).toBe(false);
    expect(result.configured).toBe(false);
  });

  test("invalid JSON content does not throw and still reports present", () => {
    mkdirSync(join(testRoot, ".codex"), { recursive: true });
    writeFileSync(authPath, "not json at all {{{ this is garbage", "utf8");
    expect(() => checkCodexAuth({}, authPath)).not.toThrow();
    const result = checkCodexAuth({}, authPath);
    expect(result.authFilePresent).toBe(true);
    expect(result.configured).toBe(true);
  });
});

describe("checkCodexAuth — never exposes secret content", () => {
  test("fake secret string never appears in the returned status object", () => {
    mkdirSync(join(testRoot, ".codex"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ access_token: FAKE_SECRET, refresh_token: FAKE_SECRET }), "utf8");

    const result = checkCodexAuth({ OPENAI_API_KEY: FAKE_SECRET }, authPath);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(FAKE_SECRET);
  });

  test("no exception thrown by checkCodexAuth ever contains the fake secret", () => {
    mkdirSync(join(testRoot, ".codex"), { recursive: true });
    writeFileSync(authPath, JSON.stringify({ token: FAKE_SECRET }), "utf8");
    try {
      checkCodexAuth({ OPENAI_API_KEY: FAKE_SECRET }, authPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      expect(message).not.toContain(FAKE_SECRET);
    }
  });
});

// ─── wire codex status display ──────────────────────────────────────────────

describe("statusCore — auth display", () => {
  test("reports all three signals and configured state without exposing values", () => {
    const result = statusCore({ stateDir });
    const text = result.lines.join("\n");
    expect(text).toContain("OPENAI_API_KEY:");
    expect(text).toContain("OPENAI_SESSION_TOKEN:");
    expect(text).toContain("~/.codex/auth.json:");
    expect(text).toContain("configured:");
  });

  test("never includes a raw secret value even if one is present in real env at test time", () => {
    const original = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = FAKE_SECRET;
    try {
      const result = statusCore({ stateDir });
      expect(result.lines.join("\n")).not.toContain(FAKE_SECRET);
    } finally {
      if (original === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = original;
    }
  });
});
