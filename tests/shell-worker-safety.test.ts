import { describe, test, expect } from "bun:test";
import { isBlocked, displaySafe } from "../src/agents/shell-worker.js";

describe("shell blocklist (backstop behind HITL)", () => {
  const blocked = [
    "rm -rf /", "rm -fr /", "rm -r -f /", "rm -rf /*", "rm -rf ~", "rm -rf ~/", "rm -rf $HOME",
    "sudo rm -rf /", "find / -delete", "dd if=/dev/zero of=/dev/sda", "dd if=x of=/dev/nvme0n1",
    "mkfs.ext4 /dev/sda1", ">/dev/sda", ":(){ :|:& };:",
  ];
  for (const c of blocked) test(`blocks: ${c}`, () => expect(isBlocked(c)).toBe(true));

  const allowed = ["ls -la /", "rm -rf ./build", "rm -rf /tmp/wire-test", "find . -name '*.log'", "df -h", "cat ~/notes.txt"];
  for (const c of allowed) test(`allows: ${c}`, () => expect(isBlocked(c)).toBe(false));
});

describe("displaySafe — the approval prompt shows what will actually run", () => {
  test("plain commands are unchanged", () => expect(displaySafe("ls -la")).toBe("ls -la"));
  test("carriage return cannot hide the real command", () => {
    const shown = displaySafe("rm -rf ~/x\recho harmless");
    expect(shown).not.toContain("\r");
    expect(shown).toContain("\\r");
  });
  test("ANSI escapes are made visible", () => {
    const shown = displaySafe("echo hi\x1b[2K\x1b[1Gls");
    expect(shown).not.toContain("\x1b");
    expect(shown).toContain("\\x1b");
  });
});
