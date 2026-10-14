import { describe, test, expect } from "bun:test";
import { buildMessage, serializeMessage, wireFilename } from "../src/envelope/encode.js";
import { decodeMessage, parseWireFile } from "../src/envelope/decode.js";
import type { TaskSpec } from "../src/types.js";

const sampleTask: TaskSpec = {
  format: "task",
  verb: "query",
  domain: ["sqlite", "indexing"],
  output: { format: "ranked-list", maxItems: 5 },
};

describe("envelope — build", () => {
  test("buildMessage returns valid envelope fields", async () => {
    const msg = await buildMessage({
      from: "claude",
      to: "gemini",
      type: "task",
      skill: "research",
      payload: sampleTask,
    });
    expect(msg.wire).toBe("1");
    expect(msg.from).toBe("claude");
    expect(msg.to).toBe("gemini");
    expect(msg.type).toBe("task");
    expect(msg.skill).toBe("research");
    expect(msg.enc).toBe(false);
    expect(msg.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.ts).toBe("number");
    expect(msg.hmac).toBeUndefined();
    expect(msg.sig).toBeUndefined();
  });

  test("TTL ceiling rejects system skill with ttl > 3600", async () => {
    await expect(
      buildMessage({
        from: "claude",
        to: "gemini",
        type: "task",
        skill: "system",
        payload: sampleTask,
        ttl: 7200,
      })
    ).rejects.toThrow(/TTL 7200s exceeds maximum/);
  });

  test("wireFilename generates expected format", async () => {
    const msg = await buildMessage({
      from: "claude",
      to: "gemini",
      type: "task",
      skill: "research",
      payload: sampleTask,
    });
    const filename = wireFilename(msg);
    expect(filename).toMatch(/^claude_gemini_\d{14}_[0-9a-f]{8}\.wire\.json$/);
  });
});

describe("envelope — serialize + parse", () => {
  test("serializeMessage produces valid JSON", async () => {
    const msg = await buildMessage({
      from: "claude",
      to: "gemini",
      type: "task",
      skill: "research",
      payload: sampleTask,
    });
    const serialized = serializeMessage(msg);
    expect(() => JSON.parse(serialized)).not.toThrow();
  });

  test("parseWireFile returns null for non-JSON", () => {
    const result = parseWireFile("not json {{{");
    expect(result).toBeNull();
  });
});

describe("envelope — decode", () => {
  test("build → serialize → parse → decode roundtrip", async () => {
    const msg = await buildMessage({
      from: "claude",
      to: "gemini",
      type: "task",
      skill: "research",
      payload: sampleTask,
    });

    const raw = parseWireFile(serializeMessage(msg));
    const result = decodeMessage(raw, "gemini");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(sampleTask);
      expect(result.message.from).toBe("claude");
      expect(result.message.to).toBe("gemini");
    }
  });

  test("wrong recipient is rejected", async () => {
    const msg = await buildMessage({
      from: "claude",
      to: "gemini",
      type: "task",
      skill: "research",
      payload: sampleTask,
    });

    const raw = parseWireFile(serializeMessage(msg));
    const result = decodeMessage(raw, "ollama"); // message is for gemini, not ollama
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema_invalid");
  });

  test("expired TTL is rejected", async () => {
    const msg = await buildMessage({
      from: "claude",
      to: "gemini",
      type: "task",
      skill: "research",
      payload: sampleTask,
    });

    // Backdate ts by 31s to exceed 30s clock skew limit
    const backdated = { ...msg, ts: Date.now() - 31_000 };
    const raw = parseWireFile(serializeMessage(backdated));
    const result = decodeMessage(raw, "gemini");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ttl_expired");
  });

  test("schema_invalid for garbage input", () => {
    const result = decodeMessage({ garbage: true }, "claude");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema_invalid");
  });

  test("null input returns schema_invalid", () => {
    const result = decodeMessage(null, "claude");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema_invalid");
  });
});
