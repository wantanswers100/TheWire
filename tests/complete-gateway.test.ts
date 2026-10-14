// /complete gateway: per-request logging + caller deadline.
// Before this, /complete (a client app's main Wire path) logged nothing
// per request — a 89-100% failure rate on 2026-09-22 was invisible from Wire's
// side. Also: the sequential provider chain could run ~80s against a 50s
// client timeout (ISS-041); callers can now pass a deadline.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleComplete } from "../src/gateway/complete.js";

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
let dir: string;
let logPath: string;

type FetchImpl = (url: string) => Promise<Response>;
function mockFetch(impl: FetchImpl) {
  globalThis.fetch = ((input: string | URL | Request) => impl(String(input))) as typeof fetch;
}
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }] } }] }));

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": "test-key", ...headers },
    body: JSON.stringify({ system_prompt: "s", user_prompt: "u", ...body }),
  });
}
function logLines(): Record<string, any>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  dir = join(tmpdir(), `wire-complete-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  logPath = join(dir, "complete-requests.jsonl");
  process.env["WIRE_COMPLETE_API_KEY"] = "test-key";
  process.env["WIRE_COMPLETE_LOG_PATH"] = logPath;
  process.env["WIRE_COMPLETE_PROVIDER_ORDER"] = "groq,gemini";
  process.env["GROQ_API_KEY"] = "gsk_fake";
  process.env["GEMINI_API_KEY"] = "AIzaFAKESECRET";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
});

describe("/complete request log", () => {
  test("logs every attempt, the winner, and the caller", async () => {
    mockFetch(async (url) => url.includes("groq") ? new Response("busy", { status: 503 }) : geminiOk());
    const res = await handleComplete(request({ role: "primary" }, { "X-Caller": "example-client" }));
    expect(res.status).toBe(200);

    const entry = logLines()[0]!;
    expect(entry.caller).toBe("example-client");
    expect(entry.status).toBe(200);
    expect(entry.provider).toBe("gemini");
    expect(entry.attempts.map((a: any) => [a.provider, a.ok])).toEqual([["groq", false], ["gemini", true]]);
    expect(typeof entry.total_ms).toBe("number");
  });

  test("logs all-provider failure as 502 and never writes API keys", async () => {
    mockFetch(async (url) => { throw new Error(`fetch failed for ${url}`); });
    const res = await handleComplete(request({}));
    expect(res.status).toBe(502);

    const raw = readFileSync(logPath, "utf8");
    expect(raw).not.toContain("AIzaFAKESECRET");
    expect(raw).not.toContain("gsk_fake");
    expect(logLines()[0]!.status).toBe(502);
    expect(await res.text()).not.toContain("AIzaFAKESECRET");
  });

  test("auth failures are logged without a body", async () => {
    const res = await handleComplete(request({}, { "X-API-Key": "wrong" }));
    expect(res.status).toBe(401);
    expect(logLines()[0]!.status).toBe(401);
  });
});

describe("/complete caller deadline", () => {
  test("stops the chain at the deadline and returns 504 instead of running every provider", async () => {
    let geminiCalled = false;
    mockFetch(async (url) => {
      if (url.includes("groq")) return new Promise<Response>((r) => setTimeout(() => r(new Response("slow", { status: 503 })), 400));
      geminiCalled = true;
      return geminiOk();
    });
    const t0 = Date.now();
    const res = await handleComplete(request({ deadline_ms: 100 }));
    expect(res.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(350);
    expect(geminiCalled).toBe(false);
    expect(logLines()[0]!.status).toBe(504);
  });

  test("huge deadlines are clamped, not overflowed into an instant 504", async () => {
    mockFetch(async (url) => url.includes("groq") ? new Response("busy", { status: 503 }) : geminiOk());
    const res = await handleComplete(request({ deadline_ms: 3_000_000_000, role: "x".repeat(5000) }));
    expect(res.status).toBe(200);
    const entry = logLines()[0]!;
    expect(entry.deadline_ms).toBe(300_000);
    expect(entry.role.length).toBeLessThanOrEqual(40);
  });

  test("X-Deadline-Ms header works the same as body.deadline_ms", async () => {
    mockFetch(async () => new Promise<Response>((r) => setTimeout(() => r(geminiOk()), 400)));
    const res = await handleComplete(request({}, { "X-Deadline-Ms": "100" }));
    expect(res.status).toBe(504);
  });
});
