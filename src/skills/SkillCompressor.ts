// SkillCompressor — batch-summarizes skill outcomes via qwen3:4b
//
// Always fire-and-forget with 15s timeout. Never awaited inline.
// ISS-021: /no_think appended to all qwen3 prompts to prevent stalling.

import { OLLAMA_URL } from "../config/models.js";
import type { SkillRegistry } from "./SkillRegistry.js";
import type { SkillRecord } from "./types.js";

const COMPRESS_MODEL = "qwen3:4b";
const TIMEOUT_MS = 15_000;

export class SkillCompressor {
  private registry: SkillRegistry;

  constructor(registry: SkillRegistry) {
    this.registry = registry;
  }

  async compress(skill: string, records: SkillRecord[]): Promise<void> {
    if (records.length === 0) return;

    const snippets = records
      .slice(0, 50)
      .map((r, i) => `[${i + 1}] subject: ${r.subject ?? "(none)"} — result: ${r.result_summary.slice(0, 200)}`)
      .join("\n");

    const prompt =
      `Skill: ${skill}\n` +
      `Outcomes (${records.length} recent successes):\n${snippets}\n\n` +
      `Summarize key patterns, common subjects, and typical result quality in 3-5 sentences. ` +
      `Focus on what works well. /no_think`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: COMPRESS_MODEL, prompt, stream: false, think: false }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (!res.ok) return;

      const data = await res.json() as { response?: string };
      const summary = data.response?.trim();
      if (!summary) return;

      const ids = records.map(r => r.id);
      this.registry.markCompressed(ids, summary, COMPRESS_MODEL);
      console.log(`[skills] compressed ${ids.length} records for skill="${skill}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("abort") && !msg.includes("AbortError")) {
        console.warn(`[skills] compress failed for skill="${skill}": ${msg.slice(0, 120)}`);
      }
    }
  }
}
