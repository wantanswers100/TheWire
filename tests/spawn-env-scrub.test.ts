import { describe, test, expect } from "bun:test";
import { childEnvFor, spawnAsync } from "../src/dispatch/spawnAsync.js";

const wireKeys = ["GEMINI_API_KEY", "GROQ_API_KEY", "WIRE_COMPLETE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
const base = {
  PATH: "/usr/bin", HOME: "/home/u",
  GEMINI_API_KEY: "g", GROQ_API_KEY: "q", WIRE_COMPLETE_API_KEY: "w",
  OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a",
};

describe("childEnvFor — Wire's own .env secrets never reach other vendors' CLIs", () => {
  test("claude gets only its own vendor key", () => {
    const e = childEnvFor("claude", base, wireKeys);
    expect(e["ANTHROPIC_API_KEY"]).toBe("a");
    for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "WIRE_COMPLETE_API_KEY", "OPENAI_API_KEY"]) expect(e[k]).toBeUndefined();
    expect(e["PATH"]).toBe("/usr/bin");
  });

  test("codex gets only OpenAI keys", () => {
    const e = childEnvFor("codex", base, wireKeys);
    expect(e["OPENAI_API_KEY"]).toBe("o");
    expect(e["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(e["GROQ_API_KEY"]).toBeUndefined();
  });

  test("unknown commands get none of Wire's keys", () => {
    const e = childEnvFor("agy", base, wireKeys);
    for (const k of wireKeys) expect(e[k]).toBeUndefined();
    expect(e["HOME"]).toBe("/home/u");
  });

  test("shell vars that are not Wire's keys pass through untouched", () => {
    const e = childEnvFor("codex", { ...base, GH_TOKEN: "x" }, wireKeys);
    expect(e["GH_TOKEN"]).toBe("x");
  });

  test("spawnAsync applies the scrub by default", async () => {
    process.env["WIRE_COMPLETE_API_KEY"] = "leak-check";
    try {
      const r = await spawnAsync("bash", ["-c", "echo -n \"${WIRE_COMPLETE_API_KEY:-none}\""], {});
      expect(r.stdout).toBe("none");
    } finally { delete process.env["WIRE_COMPLETE_API_KEY"]; }
  });
});
