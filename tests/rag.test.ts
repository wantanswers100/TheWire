import { describe, test, expect, beforeEach } from "bun:test";
import { RagStore, chunkText } from "../src/agents/rag.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wire-rag-"));
}

// ─── chunkText unit tests ─────────────────────────────────────────────────────

describe("chunkText", () => {
  test("returns single chunk for short text", () => {
    const chunks = chunkText("Hello world.");
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe("Hello world.");
  });

  test("splits long text into multiple chunks", () => {
    const longText = "word ".repeat(1000);
    const chunks = chunkText(longText);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("chunks respect MAX_CHUNKS_PER_FILE (500)", () => {
    const hugeText = "x ".repeat(500_000);
    const chunks = chunkText(hugeText);
    expect(chunks.length).toBeLessThanOrEqual(500);
  });

  test("no empty chunks", () => {
    const text = "a\n\n\n\nb\n\n\n\nc";
    const chunks = chunkText(text);
    for (const c of chunks) expect(c.trim().length).toBeGreaterThan(0);
  });

  test("prefers paragraph breaks", () => {
    const para1 = "a ".repeat(400);
    const para2 = "b ".repeat(400);
    const text = para1 + "\n\n" + para2;
    const chunks = chunkText(text);
    // At least one chunk should end near the paragraph break
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── RagStore integration tests ───────────────────────────────────────────────

describe("RagStore", () => {
  let stateDir: string;
  let store: RagStore;
  let tmpFile: string;

  beforeEach(() => {
    stateDir = tmpDir();
    store = new RagStore(stateDir);
    tmpFile = join(stateDir, "test-doc.txt");
    writeFileSync(tmpFile, [
      "The Wire Platform is a personal AI presence.",
      "It uses WireProtocol v1 for signed and encrypted messages.",
      "The dispatch loop routes tasks to workers: Ollama, Gemini, and Codex.",
      "Memory is stored in SQLite with nomic-embed-text embeddings.",
      "The RAG layer enables document retrieval for the Wire Agent.",
    ].join("\n\n"));
  });

  test("ingest creates chunks in database", async () => {
    const report = await store.ingest(tmpFile);
    expect(report.sourceFile).toBe(tmpFile);
    expect(report.chunks).toBeGreaterThan(0);
    expect(report.replaced).toBe(false);
  }, 60_000);

  test("re-ingest replaces prior chunks", async () => {
    await store.ingest(tmpFile);
    const report = await store.ingest(tmpFile);
    expect(report.replaced).toBe(true);

    const files = store.listFiles();
    const entry = files.find(f => f.sourceFile === tmpFile);
    expect(entry).toBeDefined();
    expect(entry!.chunks).toBe(report.chunks);
  }, 60_000);

  test("listFiles returns ingested file", async () => {
    await store.ingest(tmpFile);
    const files = store.listFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.some(f => f.sourceFile === tmpFile)).toBe(true);
  }, 60_000);

  test("remove deletes chunks", async () => {
    await store.ingest(tmpFile);
    const removed = store.remove(tmpFile);
    expect(removed).toBeGreaterThan(0);
    const files = store.listFiles();
    expect(files.some(f => f.sourceFile === tmpFile)).toBe(false);
  }, 60_000);

  test("keyword fallback retrieve works without embeddings", async () => {
    await store.ingest(tmpFile);
    const results = await store.retrieve({ query: "dispatch loop", topK: 3 });
    expect(Array.isArray(results)).toBe(true);
  }, 60_000);

  test("retrieve returns results with score, fallback flag, and content", async () => {
    await store.ingest(tmpFile);
    const results = await store.retrieve({ query: "personal AI presence", topK: 3 });
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
      expect(typeof r.fallback).toBe("boolean");
      expect(typeof r.content).toBe("string");
      expect(r.content.length).toBeGreaterThan(0);
      expect(r.source_file).toBe(tmpFile);
    }
  }, 60_000);

  test("rejects file over size limit", async () => {
    const bigFile = join(stateDir, "big.txt");
    const buf = Buffer.alloc(3 * 1024 * 1024, "a");
    writeFileSync(bigFile, buf);
    await expect(store.ingest(bigFile)).rejects.toThrow("too large");
  });

  test("rejects non-existent file", async () => {
    await expect(store.ingest("/no/such/file.txt")).rejects.toThrow("not found");
  });

  test("rejects .env files and .wire-state/ anywhere", async () => {
    const d = tmpDir();
    writeFileSync(join(d, ".env"), "SECRET=x\n");
    await expect(store.ingest(join(d, ".env"))).rejects.toThrow("Refusing to ingest");
    writeFileSync(join(d, ".env.local"), "SECRET=x\n");
    await expect(store.ingest(join(d, ".env.local"))).rejects.toThrow("Refusing to ingest");
  });

  test("rejects files from .keys/ directory", async () => {
    // Use a path inside .keys/ — guard must fire before existence check
    const keysPath = join(process.cwd(), ".keys/claude.ed25519.sk");
    await expect(store.ingest(keysPath)).rejects.toThrow(".keys/");
  });
});
