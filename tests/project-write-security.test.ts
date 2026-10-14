import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateWritePath } from "../src/projects/security.js";
import { writeProjectFile } from "../src/projects/writer.js";

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wire-pw-"));
  root = join(base, "proj");
  outside = join(base, "outside");
  mkdirSync(join(root, "outputs"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "victim.txt"), "original");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("project_write path guard", () => {
  test("allows a normal file in an allowed dir", () => {
    expect(validateWritePath(root, "outputs/a.md")).toBe(join(root, "outputs/a.md"));
  });

  test("rejects ../ traversal", () => {
    expect(() => validateWritePath(root, "../outside/victim.txt")).toThrow(/escapes/);
  });

  test("rejects a symlinked file that points outside the project", () => {
    symlinkSync(join(outside, "victim.txt"), join(root, "outputs", "link.txt"));
    expect(() => validateWritePath(root, "outputs/link.txt")).toThrow(/symlink|escapes/);
  });

  test("rejects a symlinked allowed dir that points outside the project", () => {
    symlinkSync(outside, join(root, "context"));
    expect(() => validateWritePath(root, "context/victim.txt")).toThrow(/escapes/);
  });

  test("rejects a symlinked parent inside an allowed dir", () => {
    symlinkSync(outside, join(root, "outputs", "sub"));
    expect(() => validateWritePath(root, "outputs/sub/new.txt")).toThrow(/escapes/);
  });

  test("allows a not-yet-existing nested path", () => {
    expect(validateWritePath(root, "outputs/x/y/z.md")).toBe(join(root, "outputs/x/y/z.md"));
  });

  test("writeProjectFile never writes through a symlink", () => {
    symlinkSync(join(outside, "victim.txt"), join(root, "outputs", "link.txt"));
    expect(() => writeProjectFile("p", root, "outputs/link.txt", "pwned")).toThrow();
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original");
  });

  test("writeProjectFile writes and appends normally", () => {
    writeProjectFile("p", root, "outputs/n.md", "one");
    writeProjectFile("p", root, "outputs/n.md", "two", "append");
    expect(readFileSync(join(root, "outputs/n.md"), "utf8")).toBe("one\ntwo");
    expect(existsSync(join(root, "outputs/n.md"))).toBe(true);
  });
});
