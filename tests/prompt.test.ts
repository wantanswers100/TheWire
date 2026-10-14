import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { promptLine, promptYesNo, type PromptIO } from "../src/cli/prompt.js";

function io(isTTY: boolean): PromptIO & { input: PassThrough; out: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let buf = "";
  output.on("data", (c) => { buf += String(c); });
  return { input, output, isTTY, out: () => buf };
}

describe("promptYesNo", () => {
  test("approves on 'y'", async () => {
    const s = io(true);
    const p = promptYesNo("Proceed?", s);
    s.input.write("y\n");
    expect(await p).toBe(true);
  });
  test("approves on 'YES' (case-insensitive, trimmed)", async () => {
    const s = io(true);
    const p = promptYesNo("Proceed?", s);
    s.input.write("  YES \n");
    expect(await p).toBe(true);
  });
  test("refuses on anything else", async () => {
    for (const a of ["n\n", "\n", "yy\n", "sure\n"]) {
      const s = io(true);
      const p = promptYesNo("Proceed?", s);
      s.input.write(a);
      expect(await p).toBe(false);
    }
  });
  test("refuses immediately on EOF (closed stdin), never hangs", async () => {
    const s = io(true);
    const p = promptYesNo("Proceed?", s);
    s.input.end();
    expect(await p).toBe(false);
  });
  test("refuses without reading when not a TTY, and says why", async () => {
    const s = io(false);
    expect(await promptYesNo("Proceed?", s)).toBe(false);
    expect(s.out()).toContain("non-interactive");
  });
  test("prints the question with [y/N]", async () => {
    const s = io(true);
    const p = promptYesNo("Dispatch?", s);
    s.input.write("n\n");
    await p;
    expect(s.out()).toContain("Dispatch? [y/N]");
  });
});

describe("promptLine", () => {
  test("returns the trimmed line", async () => {
    const s = io(true);
    const p = promptLine("Choice: ", s);
    s.input.write(" a \n");
    expect(await p).toBe("a");
  });
  test("returns null when not a TTY", async () => {
    expect(await promptLine("Choice: ", io(false))).toBeNull();
  });
});

describe("promptYesNo under a real pty", () => {
  const harness = join(import.meta.dir, "fixtures/prompt-harness.ts");
  // util-linux `script` gives the harness a real pty as stdin and forwards its
  // own stdin into it. The answer arrives after a delay, so the prompt is
  // already waiting (feeding a Buffer closes stdin before the prompt opens).
  function runInPty(answer: string): string {
    const r = Bun.spawnSync(
      ["bash", "-c", `(sleep 1; printf '${answer}\\n') | script -qec "bun run ${harness}" /dev/null`],
      { stdout: "pipe", stderr: "pipe", timeout: 20_000 },
    );
    return r.stdout.toString();
  }
  test("answering y approves", () => {
    expect(runInPty("y")).toContain("RESULT=APPROVED");
  }, 25_000);
  test("answering n refuses", () => {
    expect(runInPty("n")).toContain("RESULT=REFUSED");
  }, 25_000);
});
