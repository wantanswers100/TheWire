import { describe, test, expect } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isHelpRequest } from "../src/cli/help-guard.js";
import { parseFlags } from "../src/cli/nl-cmd.js";

describe("isHelpRequest", () => {
  test("help flag as the first argument of a normal command", () => {
    expect(isHelpRequest("keygen", ["--help"])).toBe(true);
    expect(isHelpRequest("setup", ["-h"])).toBe(true);
    expect(isHelpRequest("status", ["--help"])).toBe(true);
  });
  test("state-writing commands: help flag anywhere", () => {
    expect(isHelpRequest("keygen", ["alice", "--help"])).toBe(true);
    expect(isHelpRequest("sync", ["--fix", "--help"])).toBe(true);
    expect(isHelpRequest("cron", ["remove", "x", "-h"])).toBe(true);
  });
  test("commands with their own detailed help are left to show it", () => {
    for (const c of ["task", "models", "policy", "fetch", "shell", "weather", "ask", "-"]) {
      expect(isHelpRequest(c, ["--help"])).toBe(false);
    }
  });
  test("free text containing -h is not a help request", () => {
    expect(isHelpRequest("-", ["what", "does", "ls", "-h", "do"])).toBe(false);
    expect(isHelpRequest("ask", ["explain", "--help", "flags"])).toBe(false);
    expect(isHelpRequest("shell", ["ls", "-h"])).toBe(false);
    expect(isHelpRequest("memory", ["search", "df -h"])).toBe(false);
    expect(isHelpRequest("work", ["proj", "fix", "-h", "flag"])).toBe(false);
  });
  test("no flag, no help", () => {
    expect(isHelpRequest("status", [])).toBe(false);
    expect(isHelpRequest(undefined, ["--help"])).toBe(false);
    expect(isHelpRequest("help", ["--help"])).toBe(false);
  });
});

describe("plain-English parser keeps -h inside the task text", () => {
  test("wire - what does ls -h do", () => {
    const { textArgs } = parseFlags(["what", "does", "ls", "-h", "do"]);
    expect(textArgs.join(" ")).toBe("what does ls -h do");
  });
});

describe("wire <cmd> --help writes nothing (subprocess, temp keys dir)", () => {
  const cli = join(import.meta.dir, "../src/cli/index.ts");
  test("keygen --help and keygen alice --help exit 0 and create no key files", () => {
    const keys = mkdtempSync(join(tmpdir(), "wire-help-keys-"));
    try {
      for (const args of [["keygen", "--help"], ["keygen", "alice", "--help"]]) {
        const r = Bun.spawnSync(["bun", "run", cli, ...args], {
          env: { ...process.env, WIRE_KEYS_DIR: keys },
          stdout: "pipe", stderr: "pipe", timeout: 20_000,
        });
        expect(r.exitCode).toBe(0);
        expect(r.stdout.toString()).toContain("wire");
      }
      expect(readdirSync(keys)).toEqual([]);
    } finally {
      rmSync(keys, { recursive: true, force: true });
    }
  }, 45_000);
  test("task --help still shows the task command's own help", () => {
    const r = Bun.spawnSync(["bun", "run", cli, "task", "--help"], { stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toMatch(/wire task/);
  }, 25_000);
});
