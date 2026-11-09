// modelFreshness.ts — check configured agent models against what each CLI
// offers today, before a retired name fails a dispatch.
//
// agy:    every AGY_* model Wire would pass must appear in `agy models`.
// codex:  ~/.codex/config.toml `model` must be listed by `codex debug models`;
//         flagged stale when the CLI labels it previous/older generation.
// claude: aliases (opus/sonnet/haiku) always resolve to the newest release;
//         a pinned id is reported so it gets reviewed.
//
// Read-only: never changes configuration. Callers decide how to surface it.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AGY_DEFAULT_MODEL, AGY_SKILL_MODEL } from "../config/models.js";

export interface ModelCheck {
  agent: "antigravity" | "codex" | "claude";
  status: "ok" | "stale" | "unknown" | "unchecked";
  configured: string;
  detail: string;
}

function run(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function checkAgyModels(list = run("agy", ["models"])): ModelCheck[] {
  const configured = [...new Set([AGY_DEFAULT_MODEL, ...Object.values(AGY_SKILL_MODEL)])];
  if (list === null) {
    return [{ agent: "antigravity", status: "unchecked", configured: configured.join(", "), detail: "`agy models` failed" }];
  }
  const known = new Set(list.split("\n").map(l => l.split("\t")[0]!.trim()).filter(Boolean));
  return configured.map(m => known.has(m)
    ? { agent: "antigravity" as const, status: "ok" as const, configured: m, detail: "listed by agy" }
    : { agent: "antigravity" as const, status: "unknown" as const, configured: m,
        detail: "not offered by agy; update AGY_* (.env or src/config/models.ts)" });
}

export function checkCodexModel(
  configText = (() => { try { return readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"); } catch { return null; } })(),
  listJson = run("codex", ["debug", "models"]),
): ModelCheck {
  const configured = configText?.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? "(codex default)";
  if (listJson === null) return { agent: "codex", status: "unchecked", configured, detail: "`codex debug models` failed" };
  let models: Array<{ slug: string; description?: string; visibility?: string; priority?: number }>;
  try { models = (JSON.parse(listJson) as { models: typeof models }).models; }
  catch { return { agent: "codex", status: "unchecked", configured, detail: "could not parse `codex debug models`" }; }
  const listed = models.filter(m => m.visibility === "list").sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
  const newest = listed[0]?.slug;
  if (configured === "(codex default)") return { agent: "codex", status: "ok", configured, detail: `CLI default (newest listed: ${newest})` };
  const entry = models.find(m => m.slug === configured);
  if (!entry) return { agent: "codex", status: "unknown", configured, detail: `not offered by codex; newest listed: ${newest}` };
  if (/previous generation|older/i.test(entry.description ?? "")) {
    return { agent: "codex", status: "stale", configured, detail: `"${entry.description}"; newest listed: ${newest}` };
  }
  return { agent: "codex", status: "ok", configured, detail: entry.description ?? "listed" };
}

export function checkClaudeModel(configured = process.env["WIRE_CLAUDE_MODEL"] ?? "sonnet"): ModelCheck {
  return /^(opus|sonnet|haiku)$/.test(configured)
    ? { agent: "claude", status: "ok", configured, detail: "alias, always resolves to the newest release" }
    : { agent: "claude", status: "stale", configured, detail: "pinned model id; review it or use an alias (opus|sonnet|haiku)" };
}

export function checkAllModels(): ModelCheck[] {
  return [...checkAgyModels(), checkCodexModel(), checkClaudeModel()];
}
