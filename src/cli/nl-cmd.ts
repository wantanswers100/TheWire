// wire ask — natural language task dispatch
//
// Accepts free-form English, classifies intent with qwen3:4b, routes, and
// dispatches a TaskSpec to the inbox without requiring structured flags.
//
// Usage:
//   wire ask "summarize my standup notes"
//   wire ask "debug the TypeError in router.ts" --confirm
//   wire ask "research UK housing policy" --to gemini --dry-run

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMessage, serializeMessage, wireFilename } from "../envelope/encode.js";
import { WireRouter } from "../router/index.js";
import { isClassifierAvailable, classifyExtended, keywordClassify, isLinuxIntent } from "../router/classifier.js";
import { liveSearch } from "../agents/gemini-live.js";
import { runWeather } from "./weather-cmd.js";
import { generateShellCommand, runShellCommand } from "../agents/shell-worker.js";
import { guardPrompt } from "../security/prompt-guard.js";
import { streamOllama, buildPrompt } from "../dispatch/workers.js";
import { AGENT_IDS, type AgentId, type SkillType, type TaskSpec, type TaskVerb } from "../types.js";
import { promptYesNo } from "./prompt.js";

const PROJECT_ROOT = join(import.meta.dir, "..", "..");

// ─── Flag parsing ─────────────────────────────────────────────────────────────

interface NlFlags {
  dryRun: boolean;
  confirm: boolean;
  live: boolean;
  shell: boolean;
  to?: AgentId;
  from: AgentId;
  cost: "free-first" | "quality-first";
  models?: string[];  // --models claude,groq — restrict to named agents (alternate process)
}

// RES-063 (2026-09-11): `--to` was cast to AgentId with no runtime check — any
// string typed after --to flowed straight through, and "system" (a real
// AgentId per types.ts) was never excluded despite the ISS-060 fix's comment
// claiming it couldn't occur. the security diff-review caught this before merge:
// see the isShellIntent fix below for why validation alone isn't the whole
// story. Throws (not process.exit) so parseFlags stays unit-testable.
function parseAgentIdFlag(value: string | undefined, flagName: string): AgentId {
  if (!value) {
    throw new Error(`${flagName} requires a value.`);
  }
  if (!AGENT_IDS.includes(value as AgentId)) {
    throw new Error(`${flagName} "${value}" is not a valid agent (${AGENT_IDS.join(" | ")}).`);
  }
  return value as AgentId;
}

export function parseFlags(args: string[]): { flags: NlFlags; textArgs: string[] } {
  const flags: NlFlags = {
    dryRun: false,
    confirm: false,
    live: false,
    shell: false,
    from: "claude",
    cost: "quality-first",
  };
  const textArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = args[i + 1];
    switch (a) {
      case "--dry-run":   flags.dryRun = true; break;
      case "--confirm":   flags.confirm = true; break;
      case "--live":      flags.live = true; break;
      case "--shell":     flags.shell = true; break;
      case "--to": {
        const to = parseAgentIdFlag(next, "--to");
        if (to === "system") {
          throw new Error(
            `--to system is not supported — shell execution always goes through the HITL-gated path. Use "wire shell" for an explicit command.`,
          );
        }
        flags.to = to;
        i++;
        break;
      }
      case "--from":      flags.from = parseAgentIdFlag(next, "--from"); i++; break;
      case "--cost":      flags.cost = next === "free-first" ? "free-first" : "quality-first"; i++; break;
      case "--models":    flags.models = (next ?? "").split(",").map(s => s.trim()).filter(Boolean); i++; break;
      case "--help":
      case "-h":
        // Help only as the first argument; later it is part of the task text
        // ("wire - what does ls -h do").
        if (i === 0) { printHelp(); process.exit(0); }
        if (!a.startsWith("--")) textArgs.push(a);
        break;
      default:            if (!a.startsWith("--")) textArgs.push(a);
    }
  }

  return { flags, textArgs };
}

function printHelp(): void {
  console.log(`wire ask — dispatch a task in plain English

Usage: wire ask "<task description>" [options]

Options:
  --dry-run         Show the dispatch plan without sending anything
  --confirm         Always show plan and prompt before dispatching
  --shell           Convert request to a Linux command via Ollama, then HITL-gate it
                    Also auto-triggers on obvious system requests (disk, processes, files)
  --live            Live search via Gemini (real-time web, requires GEMINI_API_KEY)
                    Free tier auto-detected; prompts before using paid quota
  --to <agent>      Override the routed agent (claude | gemini | codex | ollama | antigravity)
  --from <agent>    Sender identity (default: claude)
  --cost free-first Prefer free/local agents over paid ones
  --models <a,b>    Restrict dispatch to named agents only (alternate process — default unchanged)
                    Agents: claude | gemini | ollama | llama4 | deepseek | codex
                    Example: --models ollama,deepseek  (offline + reasoning only)

Examples:
  wire ask "summarize my standup notes"
  wire ask "research UK housing policy trends" --to gemini
  wire ask "debug the TypeError in router.ts" --confirm
  wire ask "explain the dispatch loop architecture" --dry-run

How it works:
  qwen3:4b classifies your input into skill, verb, and subject.
  The router picks the best agent. At ≥85% confidence, dispatches silently.
  At 60-84% confidence, shows the plan and asks to confirm, unless you chose
  the agent with --to (that counts as your confirmation; --confirm still asks).
  Below 60%, bails and suggests the structured 'wire task' command.`);
}

// ─── Display helpers ──────────────────────────────────────────────────────────

const P = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
};

function showPlan(
  taskText: string,
  skill: string,
  verb: string,
  subject: string,
  domains: string[],
  agent: string,
  confidence: number,
  ollamaModel?: string,
): void {
  const agentLabel = `${agent}${ollamaModel ? P.dim(` (${ollamaModel})`) : ""}`;
  const pct = Math.round(confidence * 100);
  const confColor = pct >= 85 ? P.green : pct >= 60 ? P.yellow : P.dim;

  const row = (label: string, value: string) =>
    `  ${P.dim(label.padEnd(12))}${value}`;

  process.stdout.write(
    `\n${P.bold("Wire Dispatch Plan")}\n` +
    `  ${P.dim("─".repeat(48))}\n` +
    row("Input:",  P.dim(`"${taskText.slice(0, 60)}${taskText.length > 60 ? "..." : ""}"`) ) + "\n" +
    row("Skill:",  P.cyan(skill)) + "\n" +
    row("Verb:",   verb) + "\n" +
    row("Subject:", subject) + "\n" +
    (domains.length ? row("Domains:", domains.join(", ")) + "\n" : "") +
    row("Agent:",  P.yellow(agentLabel)) + "\n" +
    row("Confidence:", confColor(`${pct}%`)) + "\n",
  );
}

function startSpinner(label: string): () => void {
  if (!process.stderr.isTTY) return () => {};
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t0 = Date.now();
  process.stderr.write(`  ${frames[0]} ${label}...\r`);
  const id = setInterval(() => {
    // Elapsed seconds: a cold local model can take ~45s, which otherwise reads as a hang.
    const secs = Math.floor((Date.now() - t0) / 1000);
    process.stderr.write(`  ${frames[i++ % frames.length]!} ${label}... ${secs}s\r`);
  }, 80);
  return () => {
    clearInterval(id);
    process.stderr.write("\r\x1b[K");
  };
}

// Plan/confirm decision. An explicit --to is the user's confirmation of the
// route, so it never prompts (MCP bug 2026-10-13: `wire_ask` with `to`
// returned "Dispatch? [y/N]" instead of an answer). --confirm still forces a
// prompt. Shell-intent HITL (RES-063) is separate and unaffected.
export function confirmationNeeded(o: { confidence: number; to?: string; dryRun?: boolean; confirm?: boolean }): { showPlan: boolean; ask: boolean } {
  const showPlan = Boolean(o.dryRun || o.confirm || o.confidence < 0.85);
  const ask = showPlan && !o.dryRun && (Boolean(o.confirm) || !o.to);
  return { showPlan, ask };
}

async function promptConfirm(): Promise<boolean> {
  return promptYesNo("\nDispatch?");
}

// ─── Shell-intent detection (RES-063) ──────────────────────────────────────────
//
// Extracted as a pure function so the --to/isLinuxIntent interaction can be
// pinned by a unit test without spinning up the full CLI (TTY, Ollama, etc.).
// Deliberately takes no `to`/AgentId argument — the whole point of this fix is
// that the routing destination must never influence whether shell intent is
// detected, only where an approved command is dispatched afterward.
export function computeIsShellIntent(shellFlag: boolean, skill: string, taskText: string): boolean {
  return shellFlag || skill === "system" || isLinuxIntent(taskText.toLowerCase());
}

// Whole-input weather request, capturing an optional location:
//   "weather in 75001" · "what's the weather in Dallas?" · "forecast for London"
// A location needs a preposition (≤4 words) unless it is a bare US ZIP.
export const WEATHER_INTENT =
  /^(?:(?:what(?:'s| is)|show(?: me)?|get|check)\s+(?:the\s+)?)?(?:weather|forecast)(?:\s+(?:in|for|at|near)\s+([^?\s]+(?:\s+[^?\s]+){0,3})|\s+(\d{5}))?\s*\??$/i;

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runNl(
  args: string[],
  _keysDir: string,
  stateDir: string,
  inboxDir: string,
): Promise<void> {
  let flags: NlFlags;
  let textArgs: string[];
  try {
    ({ flags, textArgs } = parseFlags(args));
  } catch (e) {
    process.stderr.write(`[wire] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  let taskText = textArgs.join(" ").trim();
  let fromStdin = false;

  if (!taskText && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    taskText = Buffer.concat(chunks).toString("utf8").trim();
    fromStdin = true;
  }

  if (!taskText) {
    process.stderr.write('[wire] No task provided.\n  Usage: wire ask "<task description>"\n  Run:   wire ask --help\n');
    process.exit(1);
  }

  // ─── Wakeup intercept — RETIRED (Phase 51) ────────────────────────────────
  // The tmux workspace this launched is gone. The intercept stays only to give
  // a direct answer instead of sending "wakeup" to the classifier, where it
  // would be routed as an ordinary task and burn a dispatch on nothing.
  // Exact match only, same as before — "wake up the gateway" still falls
  // through to the classifier.

  if (taskText.split(" ")[0]?.toLowerCase() === "wakeup") {
    console.log("wire wakeup was retired in Phase 51 — the tmux workspace is no longer part of Wire.");
    console.log("  Session briefing: bun run wire-start   ·   Health: wire status");
    console.log("  Gateway and dispatch daemon are unaffected.");
    return;
  }

  // ─── Weather intercept ────────────────────────────────────────────────────
  // "wire - weather in 75001" has a free, deterministic answer (`wire weather`,
  // wttr.in). Sending it to the classifier instead once produced a silent
  // audit/classify dispatch to paid Claude (DEVLOG 2026-09-30). Whole-phrase
  // match only — "research weather patterns in climate models" still classifies.
  // --live and --to are explicit requests for an agent, so they bypass this.

  const weatherMatch = WEATHER_INTENT.exec(taskText);
  if (weatherMatch && !flags.live && !flags.to) {
    const location = (weatherMatch[1] ?? weatherMatch[2])?.trim();
    await runWeather(location ? [location] : []);
    return;
  }

  // ─── Sanitize user input before it enters any LLM prompt ────────────────
  taskText = guardPrompt(taskText, "task input");

  // ─── Classify (with keyword fallback) ────────────────────────────────────
  //
  // Strategy:
  //   1. Try qwen3:4b via Ollama (best accuracy, requires Ollama running)
  //   2. If Ollama unavailable or all attempts time out → keyword fast-path
  //      (instant, no Ollama, ~0.55-0.72 confidence → always shows plan+confirm)
  //
  // When --to is specified, the agent is already known. Keyword classification
  // is sufficient — we just need skill/verb/subject to build the TaskSpec.

  // Root-caused 2026-09-17: the comment above already documented that --to
  // should skip the slow qwen3:4b classification path (keyword classification
  // is enough once the destination agent is already known) — but the code
  // below unconditionally ran classifyExtended() regardless of flags.to,
  // costing up to 90s (2 attempts x 45s each, "WSL2 cold-start" per that
  // function's own comment) on every explicit-override call for zero benefit,
  // since flags.to wins over result.preferredAgent/decision.agent either way
  // (see the `agent` assignment below). Implementing the documented intent.
  let result: Awaited<ReturnType<typeof classifyExtended>> | null = null;
  if (flags.to) {
    result = keywordClassify(taskText);
  } else {
    const stopSpinner = startSpinner("routing via qwen3:4b");
    try {
      result = await classifyExtended(taskText);
    } catch {
      result = null;
    } finally {
      stopSpinner();
    }

    if (!result) {
      const kwResult = keywordClassify(taskText);
      const source = (await isClassifierAvailable()) ? "qwen3:4b timed out" : "Ollama unavailable";
      console.warn(`[wire] ${source} — using keyword classification (confidence: ${Math.round(kwResult.confidence * 100)}%)`);
      result = kwResult;
    }
  }

  // ─── Confidence gate ──────────────────────────────────────────────────────
  //
  // Below 0.55: keyword fallback couldn't even find a pattern — bail.
  // 0.55-0.84: always show plan + confirm (includes all keyword results).
  // >=0.85: silent dispatch (qwen3:4b only — keyword never reaches this).
  //
  // Exception: if --to is already specified, we skip the low-confidence bail
  // because the user already told us where to send it.

  if (result.confidence < 0.55 && !flags.to) {
    const subjectHint = result.subject ? ` --subject "${result.subject}"` : "";
    process.stderr.write(
      `[wire] Cannot classify this input (confidence: ${Math.round(result.confidence * 100)}%).\n` +
      `  Use: wire task --to ollama --skill <skill> --verb <verb>${subjectHint}\n`,
    );
    process.exit(1);
  }

  // ─── Route ────────────────────────────────────────────────────────────────

  const router = new WireRouter(stateDir);
  const decision = await router.route({
    skill: result.skill,
    verb: result.verb,
    domains: result.domains ?? [],
    type: "task",
    costPreference: flags.cost,
  });

  // Flag --to and explicit preferredAgent from classifier both override router
  const agent: AgentId =
    flags.to ?? (result.preferredAgent as AgentId | undefined) ?? decision.agent;
  const ollamaModel = agent === decision.agent ? decision.ollamaModel : undefined;

  // If qwen3:1.7b fallback omitted subject, use the raw task text (truncated)
  const subject = result.subject ?? taskText.slice(0, 80);

  // ─── Live search (--live flag) ────────────────────────────────────────────

  if (flags.live) {
    if (agent !== "gemini") {
      console.error(`[wire] --live requires Gemini. Add --to gemini or omit --to.`);
      console.error(`       Routed agent was: ${agent}`);
      process.exit(1);
    }
    await liveSearch(subject, stateDir, PROJECT_ROOT);
    return;
  }

  // ─── NL → shell execution ────────────────────────────────────────────────
  // Triggered by --shell flag or when keywordClassify detected a shell-intent
  // (skill="wire", verb="verify", domains includes "local").

  // isLinuxIntent runs on raw task text as a final override — catches paraphrases
  // that qwen3:4b might classify as "research" or "explain" instead of shell/system.
  //
  // RES-063 (2026-09-11): the ISS-060 fix (2026-09-09) made this conditional on
  // `!flags.to`, on the claim that `--to` "can only ever select claude/gemini/
  // codex/ollama (never system)". The security diff-review found that claim false on two
  // counts: "system" IS a valid AgentId in types.ts, and `--to`'s value received
  // no runtime validation at all before this fix — any string flowed through. Net
  // effect: supplying --to at all, with any value, unconditionally silenced the
  // one backstop meant to catch a shell request the classifier mis-tagged — e.g.
  // `wire ask "show me my disk usage" --to claude` would dispatch with no HITL
  // prompt at all (verified against the actual pattern in isLinuxIntent(), not
  // assumed — see tests/nl-cmd.test.ts). That's a direct violation of this
  // project's hard invariant ("shell execution always requires HITL approval, no
  // auto-run, no silent fallback, no bypass" — CLAUDE.md, agent-wire-security.md).
  //
  // Fix: the backstop is now unconditional again — `--to` is validated separately
  // (parseAgentIdFlag rejects unknown values and "system" outright) but no longer
  // exempts a task from isLinuxIntent detection. The ISS-060 false-positive this
  // was originally trying to avoid (a review/analysis task whose wording matched
  // Linux vocabulary) still gets caught, but the failure mode is now "prompts for
  // interactive shell approval" — never "silently bypasses it". Fail-safe over
  // convenience, per the hard invariant.
  const isShellIntent = computeIsShellIntent(flags.shell, result.skill, taskText);

  if (isShellIntent && !flags.dryRun) {
    if (!process.stdin.isTTY) {
      console.error("[wire] Shell execution requires an interactive terminal (cannot approve commands non-interactively).");
      process.exit(1);
    }

    console.log(`\nGenerating shell command for: "${subject}"`);
    const cmd = await generateShellCommand(taskText);

    if (!cmd) {
      console.error("[wire] Could not generate a shell command (Ollama unavailable or unclear request).");
      console.error(`  Try: wire shell "<explicit command>"`);
      process.exit(1);
    }

    try {
      const result2 = await runShellCommand(cmd);
      if (!result2.approved) {
        console.log("Cancelled.");
        return;
      }
      if (result2.stdout) process.stdout.write(result2.stdout);
      if (result2.stderr) process.stderr.write(result2.stderr);
      if (result2.exitCode !== 0) process.exit(result2.exitCode);
    } catch (e) {
      console.error(`[wire] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }

  // ─── Plan + confirm ───────────────────────────────────────────────────────

  const { showPlan: needsPlan, ask } = confirmationNeeded({
    confidence: result.confidence, to: flags.to, dryRun: flags.dryRun, confirm: flags.confirm,
  });

  if (needsPlan) {
    showPlan(taskText, result.skill, result.verb, subject, result.domains ?? [], agent, result.confidence, ollamaModel);

    if (flags.dryRun) {
      process.stdout.write(`\n${P.dim("[dry-run] No message written.")}\n`);
      return;
    }

    if (ask) {
      // stdin already consumed for the task text: there is no one to ask
      if (fromStdin) {
        process.stdout.write(P.dim("\n[stdin input — proceeding without interactive confirm]\n"));
      } else if (!(await promptConfirm())) {
        process.stdout.write(P.dim("Cancelled. (Not confirmed. Re-run with --to <agent> to choose the route explicitly.)\n"));
        return;
      }
    }
  }

  // ─── Ollama streaming fast path (interactive TTY only) ───────────────────
  // For ollama-routed tasks in a real terminal, stream response directly instead
  // of queuing to inbox. HITL skills always go through dispatch (approval UX).

  const HITL_SKILLS = new Set(["implement", "architect", "scaffold", "refactor", "wire"]);
  const isOllamaFastPath =
    agent === "ollama" &&
    process.stdout.isTTY &&
    !flags.dryRun &&
    !HITL_SKILLS.has(result.skill);

  if (isOllamaFastPath) {
    const prompt = buildPrompt({ verb: result.verb, domain: result.domains ?? [], subject });
    process.stdout.write(P.dim(`\n[${result.skill}/${result.verb} → ollama]\n`));
    try {
      await streamOllama(result.skill, prompt);
      return;
    } catch (e) {
      console.error(`[wire] Ollama stream failed: ${e instanceof Error ? e.message : String(e)}`);
      console.error("  Falling back to queued dispatch...");
      // Fall through to inbox dispatch below
    }
  }

  // ─── Build and dispatch ───────────────────────────────────────────────────

  // ISS-027: the wire message envelope is always addressed to "claude" —
  // DispatchLoop only ever processes messages with to==="claude" (loop.ts's
  // processFile()) and does its own agent selection via WireRouter's routing
  // table + fallback chain (the same logic ISS-022 validated end-to-end).
  // This CLI-side `agent`/`decision` computation still exists for the plan
  // display and confidence gating above, but must never become the envelope
  // `to` field — that silently orphaned every CLI-dispatched task (the
  // message was addressed directly to e.g. "gemini", which nothing
  // automatically consumes; the daemon discarded it without logging).
  // `--to <agent>` now maps onto modelFilter (same mechanism `--models`
  // already uses) so an explicit agent request still constrains routing,
  // instead of bypassing the daemon's routing/fallback logic entirely.
  const modelFilter = flags.models?.length ? flags.models : flags.to ? [flags.to] : undefined;

  // ISS-028: boundary guard, not just a classifier-internal fix. Multiple
  // upstream paths can produce an empty domains array — keywordClassify()'s
  // fallback branches (fixed at the source in classifier.ts) and the
  // qwen3:1.7b minimal-schema fallback (also fixed at the source) are the
  // ones actually observed live, but the qwen3:4b happy-path schema
  // (ExtendedClassifierOutputSchema) itself has no `.min(1)` on domains — if
  // the model's own JSON legitimately omits domain tags, nothing upstream
  // catches it. WireSpec's schema requires domain.length >= 1; a payload
  // built with domain:[] is silently discarded by processFile() with zero
  // trace (this is exactly the failure ISS-028 was about). One guard here,
  // at the point the payload is actually constructed, closes every current
  // and future source at once instead of chasing each classifier code path.
  const domain = result.domains?.length ? result.domains : ["general"];

  const payload: TaskSpec = {
    format: "task",
    verb: result.verb as TaskVerb,
    domain,
    output: { format: "prose" },
    subject,
    ...(modelFilter?.length ? { modelFilter: modelFilter as import("../types.js").AgentId[] } : {}),
  };

  if (flags.models?.length) {
    process.stdout.write(P.dim(`  [model filter: ${flags.models.join(", ")} — alternate process]\n`));
  }

  const msg = await buildMessage({
    from: flags.from,
    to: "claude",
    type: "task",
    skill: result.skill as SkillType,
    payload,
  });

  const filename = wireFilename(msg);
  const outPath = join(inboxDir, filename);
  writeFileSync(outPath, serializeMessage(msg), { encoding: "utf8", mode: 0o644 });

  const subjectDisplay = subject.length > 60 ? subject.slice(0, 57) + "..." : subject;
  process.stdout.write(
    `\n${P.green("✓")} ${P.bold("queued")}  ` +
    `${P.dim(flags.from)} ${P.dim("→")} ${P.yellow(agent)}  ` +
    `${P.cyan(`[${result.skill}/${result.verb}]`)}  ` +
    `${P.dim(`"${subjectDisplay}"`)}\n` +
    `  ${P.dim(`id: ${msg.id}`)}\n`,
  );
}
