// Ollama request gate — serializes local Ollama calls within this process.
//
// Root cause (DEVLOG 2026-09-09): the dispatch loop fires processFile() for
// each inbox message without awaiting it (fire-and-forget), so several tasks
// arriving close together each call classifyExtended()/runOllama() at once.
// On this CPU-only WSL2 box, Ollama holds at most 2 models loaded — a burst
// of concurrent requests across different models (qwen3:4b classify,
// qwen2.5-coder:14b review, etc.) forces a swap-and-reload of a multi-GB
// model from disk mid-request, which routinely blew past even generous
// (45-180s) per-call timeouts. Queuing all local Ollama calls in this process
// to run one at a time removes the concurrent-model-swap trigger; it does not
// make individual calls faster, only prevents them from piling up.
//
// This only serializes calls made from within this process. A separate
// process (e.g. an MCP tool call) hitting Ollama at the same time is not
// covered — that is a known, smaller-probability gap, not addressed here.

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` only after every previously-queued call has settled (resolved or
 * rejected), and block every later call until `fn` itself settles. Preserves
 * FIFO call order, not completion order. A rejection from `fn` propagates to
 * its own caller but never wedges the queue for calls queued after it.
 */
export function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  // `queue` is always normalized to resolve below, so it never rejects here —
  // `fn` runs exactly once, after every earlier queued call has settled.
  const run = queue.then(fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
