#!/usr/bin/env bun
// wire — WireProtocol v1 CLI
// Usage: wire <subcommand> [options]
//
// Subcommands:
//   task                      Send a task to an agent (no JSON required)
//   keygen <agentId>          Generate Ed25519 + X25519 keypair for an agent
//   send                      Build, sign, and write a wire message to inbox/
//   recv <file>               Decode, verify, and display a .wire.json file
//   verify <file>             Verify signatures + HMAC without full decode
//   inspect <file>            Human-readable dump of a .wire.json file
//   route                     Ask the router which agent it would pick for a task
//   classify "<text>"         Classify free-text via qwen3:4b (Layer 2) then route
//   policy                    Show provider/cost guardrails and routing audit
//   dispatch <start|stop|status>  Manage the dispatch loop daemon
//   agent <status|watch>      Universal Markdown handoff visibility

import { join } from "node:path";
import { runKeygen } from "./keygen.js";
import { isHelpRequest } from "./help-guard.js";
import { runSend } from "./send.js";
import { runRecv } from "./recv.js";
import { runVerify } from "./verify-cmd.js";
import { runInspect } from "./inspect.js";
import { runRoute } from "../router/route-cmd.js";
import { runClassify } from "../router/classify-cmd.js";
import { runTask } from "./task-cmd.js";
import { runNl } from "./nl-cmd.js";
import { runShell } from "./shell-cmd.js";
import { runFetch } from "./fetch-cmd.js";
import { runCodeReview } from "./code-review-cmd.js";
import { runExplainFile } from "./explain-file-cmd.js";
import { runProjectBrief } from "./project-brief-cmd.js";
import { runPrepOnline } from "./prep-online-cmd.js";
import { runStatus } from "./status-cmd.js";
import { runWork } from "./work-cmd.js";
import { runInbox } from "./inbox-cmd.js";
import { runProjectStatus } from "./project-status-cmd.js";
import { runDiagnose } from "./diagnose-cmd.js";
import { runInternet } from "./internet-cmd.js";
import { runWorkspace } from "./workspace-cmd.js";
import { runModelUpdate } from "./modelupdate-cmd.js";
import { runSetup } from "./setup-cmd.js";
import { runContext } from "./context-cmd.js";
import { runSync }    from "./sync-cmd.js";
import { ensureServices } from "./ensure-services.js";
import { runModels } from "./models-cmd.js";
import { runProviders } from "./providers-cmd.js";
import { runCron } from "./cron-cmd.js";
import { runWeather } from "./weather-cmd.js";
import { runCodexCmd } from "./codex-cmd.js";
import { runAgentCmd } from "./agent-cmd.js";
import { runPolicy } from "./policy-cmd.js";
import { APP_VERSION, formatVersionLine } from "../version.js";
import { withEngaged, engagedLine, listEngaged } from "../engaged.js";
import { runVersion, runUpdate } from "./update-cmd.js";
import { printGlossary } from "./glossary.js";

// ─── Project paths ───────────────────────────────────────────────────────────
//
// ISS-031: sourced from config/paths.ts, the single shared definition.
// `export { X } from "mod"` alone is a re-export-only statement — it does
// NOT create a local binding for this file's own code to use (caught live:
// `wire task` threw "ReferenceError: KEYS_DIR is not defined" at the actual
// call site below). Needs both an import (for this file's own use) and a
// separate export (for backward compatibility with existing importers of
// KEYS_DIR/STATE_DIR/INBOX_DIR from this module). Do not redefine these
// locally — see config/paths.ts's header comment for why that's the exact
// bug class ISS-026 was.
import { PROJECT_ROOT, KEYS_DIR, STATE_DIR, INBOX_DIR, GATEWAY_URL } from "../config/paths.js";
export { PROJECT_ROOT, KEYS_DIR, STATE_DIR, INBOX_DIR, GATEWAY_URL };

// ─── CLI entry point ─────────────────────────────────────────────────────────

const [, , subcommand, ...rest] = process.argv;

// Phase 52: the interactive REPL and the ink/React TUI were both retired.
// Bare `wire` now prints usage instead of dropping into an interactive shell.
// Wire is driven by explicit subcommands (`wire ask "..."`, `wire status`, …)
// and by the dispatch daemon, neither of which needed an interactive surface.
if (!subcommand) {
  printUsage();
  process.exit(0);
}

// --help/-h is answered here, before any command can read it as an argument.
if (isHelpRequest(subcommand, rest)) {
  printUsage();
  process.exit(0);
}

// Top-level words people type that actually live under another subcommand.
const SUBCOMMAND_HINTS: Record<string, string> = {
  stop: "dispatch stop",
  start: "dispatch start",
  restart: "dispatch stop && wire dispatch start",
  daemon: "dispatch status",
  review: "dispatch review list",
  approve: "dispatch review approve <id>",
  reject: "dispatch review reject <id>",
  jobs: "cron list",
  search: "memory search <q>",
};

// Auto-start gateway + dispatch for commands that need them
const SERVICE_CMDS = new Set(["ask", "-", "work", "task", "shell", "fetch", "memory", "rag"]);
// Asking for help must never start the gateway or the dispatch daemon.
if (SERVICE_CMDS.has(subcommand) && rest[0] !== "--help" && rest[0] !== "-h") await ensureServices();

switch (subcommand) {
  case "--version":
  case "-v":
  case "version":
    runVersion(rest);
    break;
  case "update":
    await runUpdate(rest);
    break;
  case "ask":
  case "-":
    await withEngaged("terminal", "ask", () => runNl(rest, KEYS_DIR, STATE_DIR, INBOX_DIR));
    break;
  case "engaged": {
    // `--line`: one compact line, empty when idle (for host status lines).
    const line = engagedLine();
    if (rest[0] === "--line") { if (line) console.log(line); break; }
    const list = listEngaged();
    if (list.length === 0) console.log("Wire idle — nothing in flight.");
    for (const e of list) console.log(`  ${e.caller.padEnd(12)} ${e.action.padEnd(16)} pid ${e.pid}  ${Math.round((Date.now() - e.startedAt) / 1000)}s`);
    break;
  }
  // Phase 51: the tmux workspace was retired. Kept as an explicit tombstone
  // rather than removed outright so muscle memory gets a useful answer instead
  // of "unknown command". The pipeline it used to front (gateway + dispatch
  // daemon) is unaffected and runs independently of any terminal.
  case "wakeup":
    console.log("wire wakeup was retired in Phase 51 — the tmux workspace is no longer part of Wire.");
    console.log("");
    console.log("  Session briefing:   bun run wire-start   (or: wire-up)");
    console.log("  Inbox watcher:      bun run wire-watch");
    console.log("  Platform health:    wire status");
    console.log("");
    console.log("  The gateway and dispatch daemon are unaffected — they run as");
    console.log("  detached background processes, independent of any terminal.");
    break;
  case "shell":
    await runShell(rest);
    break;
  case "fetch":
    await runFetch(rest);
    break;
  case "code-review":
    await runCodeReview(rest);
    break;
  case "explain-file":
    await runExplainFile(rest);
    break;
  case "project-brief":
    runProjectBrief(rest);
    break;
  case "prep-online":
    await runPrepOnline(rest);
    break;
  case "context":
    await runContext(rest);
    break;
  case "sync":
    await runSync(rest);
    break;
  case "status":
    await runStatus(rest);
    break;
  case "work":
    await runWork(rest);
    break;
  case "inbox":
    runInbox(rest);
    break;
  case "project-status":
    runProjectStatus(rest);
    break;
  case "diagnose":
    await runDiagnose(rest);
    break;
  case "internet":
    await runInternet(rest);
    break;
  case "workspace":
  case "ws":
    runWorkspace(rest);
    break;
  case "modelupdate":
    await runModelUpdate(rest);
    break;
  case "providers":
    await runProviders(rest);
    break;
  case "setup":
    await runSetup(rest, KEYS_DIR, STATE_DIR);
    break;
  case "models":
    await runModels(rest);
    break;
  case "mcp": {
    const { spawnSync: spawnMcp } = await import("node:child_process");
    const rMcp = spawnMcp("bun", ["run", join(import.meta.dir, "../mcp/server.ts"), ...rest], {
      stdio: "inherit",
      env: { ...process.env },
    });
    process.exit(rMcp.status ?? 0);
    break;
  }
  case "task":
    await runTask(rest, KEYS_DIR, STATE_DIR, INBOX_DIR);
    break;
  case "keygen":
    await runKeygen(rest, KEYS_DIR);
    break;
  case "send":
    await runSend(rest, KEYS_DIR, STATE_DIR, INBOX_DIR);
    break;
  case "recv":
    await runRecv(rest, KEYS_DIR, STATE_DIR);
    break;
  case "verify":
    await runVerify(rest, KEYS_DIR, STATE_DIR);
    break;
  case "inspect":
    await runInspect(rest);
    break;
  case "route":
    await runRoute(rest, STATE_DIR);
    break;
  case "classify":
    await runClassify(rest, STATE_DIR);
    break;
  case "policy":
    await runPolicy(rest);
    break;
  case "ingest":
  case "rag": {
    const { spawnSync: spawnR } = await import("node:child_process");
    const rr = spawnR("bun", ["run", join(import.meta.dir, "../agents/rag-cmd.ts"), subcommand, ...rest], {
      stdio: "inherit", env: { ...process.env },
    });
    process.exit(rr.status ?? 0);
    break;
  }
  case "memory": {
    const { spawnSync: spawnM } = await import("node:child_process");
    const rm = spawnM("bun", ["run", join(import.meta.dir, "../agents/memory-cmd.ts"), ...rest], {
      stdio: "inherit", env: { ...process.env },
    });
    process.exit(rm.status ?? 0);
    break;
  }
  case "weather":
    await runWeather(rest);
    break;
  case "cron":
    await runCron(rest);
    break;
  case "codex":
    await runCodexCmd(rest);
    break;
  case "agent":
    await runAgentCmd(rest);
    break;
  case "dispatch": {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("bun", ["run", join(import.meta.dir, "../dispatch/cmd.ts"), ...rest], {
      stdio: "inherit",
      env: { ...process.env },
    });
    process.exit(r.status ?? 0);
    break;
  }
  case "eval": {
    const { EvalStore } = await import("../dispatch/EvalStore.js");
    const es = new EvalStore(STATE_DIR);
    const taskId = rest[0];
    if (taskId) {
      const rows = es.summary(taskId);
      if (rows.length === 0) {
        console.log(`No eval records found for task ${taskId}`);
      } else {
        console.log(`Eval records for task ${taskId}:`);
        console.log(`${"step".padEnd(16)} ${"verdict".padEnd(8)} ${"score".padEnd(7)} ${"agent".padEnd(12)} ${"skill".padEnd(12)} latency_ms`);
        console.log("-".repeat(72));
        for (const r of rows) {
          const step    = (r.step ?? "").padEnd(16);
          const verdict = (r.verdict ?? "").padEnd(8);
          const score   = String(r.score ?? "").padEnd(7);
          const agent   = (r.agent ?? "").padEnd(12);
          const skill   = (r.skill ?? "").padEnd(12);
          const lat     = String(r.latency_ms ?? "");
          console.log(`${step} ${verdict} ${score} ${agent} ${skill} ${lat}`);
        }
      }
    } else {
      const stats = es.recentStats();
      console.log("Recent eval stats (last 100 end_to_end rows):");
      console.log(`  completionRate:  ${(stats.completionRate * 100).toFixed(1)}%`);
      console.log(`  judgePassRate:   ${(stats.judgePassRate  * 100).toFixed(1)}%`);
      console.log(`  retryRate:       ${(stats.retryRate      * 100).toFixed(1)}%`);
      console.log(`  escalationRate:  ${(stats.escalationRate * 100).toFixed(1)}%`);
    }
    break;
  }
  case "--help":
  case "-h":
  case "help":
    if (rest[0] === "terms" || rest[0] === "glossary") {
      printGlossary(rest.slice(1).join(" ") || undefined);
    } else {
      printUsage();
    }
    process.exit(0);
    break;
  default: {
    // Short error, not the full ~90-line usage dump — the real error scrolled
    // off-screen (`wire stop`, 2026-09-30). Point at the likely intent instead.
    const hint = SUBCOMMAND_HINTS[subcommand ?? ""];
    console.error(`Unknown subcommand: ${subcommand}`);
    if (hint) console.error(`  Did you mean: wire ${hint}`);
    console.error(`  All commands: wire help   ·   Plain English: wire - <task>`);
    process.exit(1);
  }
}

function printUsage(): void {
  const b  = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const d  = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const y  = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const c  = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const g  = (s: string) => `\x1b[32m${s}\x1b[0m`;

  const cmd  = (name: string, desc: string, width = 24) =>
    `  ${y(name.padEnd(width - 1))} ${d(desc)}`;  // explicit gap: long names never run into desc
  const sub  = (name: string, desc: string) => cmd(name, desc, 28);
  const note = (s: string) => `  ${d(s)}`;
  const ex   = (s: string) => `  ${g("$")} ${c("wire")} ${s}`;
  const sep  = () => `  ${d("─".repeat(54))}`;

  process.stdout.write([
    "",
    `${b(`wire ${APP_VERSION}`)} ${d("— WireProtocol v1  ·  personal AI presence")}`,
    d(`  version ${formatVersionLine()}`),
    "",
    b("QUICK START"),
    note(`Type anything in English — wire handles the rest`),
    ex(`- show my disk usage`),
    ex(`- research UK housing policy --to gemini`),
    ex(`- debug the TypeError in router.ts --confirm`),
    "",
    sep(),
    b("NATURAL LANGUAGE"),
    sub(`- <task>`,           `NL dispatch — no quotes, no subcommand`),
    sub(`ask "<task>"`,       `NL dispatch — long form with flags`),
    note(`  flags: --dry-run  --confirm  --live  --to <agent>  --cost free-first`),
    note(`  run: wire ask --help`),
    "",
    b("WORKSPACE"),
    sub(`workspace add <path>`,  `Connect a folder (--name <n> --mode r|w|rw)`),
    sub(`workspace list`,        `List connected folders`),
    sub(`workspace remove <n>`,  `Disconnect a folder by name or path`),
    sub(`internet`,              `Network info: IPs, MACs, gateway, DNS, public IP`),
    sub(`status`,                `Ollama, gateway, dispatch, context packs, usage`),
    sub(`inbox`,              `Scan ~/projects/inbox/ — wire msgs, docs, junk`),
    sub(`work <proj> "<task>"`, `Project-aware dispatch with context packs`),
    sub(`project-status <p>`, `STATUS.md + context deliverables and risks`),
    sub(`project-brief <p>`,  `Display a project's context pack`),
    sub(`prep-online <p> "<task>"`, `Draft escalation prompt for online model`),
    sub(`diagnose <p>`,       `Multi-angle health: security + AI analysis`),
    note(`  flags: --local  --full  --write-inbox`),
    "",
    b("SHELL"),
    sub(`shell "<cmd>"`,      `Run command with HITL approval gate`),
    "",
    b("CODE"),
    sub(`code-review <file>`, `Local review via qwen2.5-coder:14b`),
    note(`  flag: --escalate  (also print online escalation prompt)`),
    sub(`explain-file <file>`,`Explain a source file via qwen3:4b`),
    "",
    b("WEB"),
    sub(`weather [location]`,  `Current weather via wttr.in (free, no API key)`),
    note(`  wire weather Dallas  |  wire weather 75001  |  wire weather --format 3`),
    sub(`fetch "<url>" "<q>"`, `Fetch static page + Ollama Q&A`),
    note(`  live search: wire - what is the weather --live`),
    "",
    b("DISPATCH"),
    sub(`dispatch start`,                `Start background dispatch loop daemon`),
    sub(`dispatch stop`,                 `Stop the daemon`),
    sub(`dispatch status`,               `Daemon state + recent task history`),
    sub(`dispatch review list`,          `List tasks escalated by PhaseGate`),
    sub(`dispatch review approve <id>`,  `Approve an escalated task (marks done)`),
    sub(`dispatch review reject <id>`,   `Reject an escalated task`),
    sub(`eval <taskId>`,      `Show per-step eval scores for a task`),
    sub(`eval`,               `Show aggregate eval stats (last 100 end_to_end rows)`),
    sub(`agent status`,       `Universal Markdown handoff visibility`),
    sub(`agent watch status`, `All-agent inbox watcher state (parks/quarantines only)`),
    sub(`task`,               `Structured dispatch: --to --skill --verb --subject`),
    note(`  run: wire task --help`),
    sub(`cron add "<sched>" <skill> "<subject>"`, `Schedule recurring task (5-field cron)`),
    sub(`cron list`,          `List all scheduled cron jobs`),
    sub(`cron del <id|name>`, `Delete a cron job`),
    sub(`cron run <id|name>`, `Trigger a cron job immediately`),
    sub(`cron next "<sched>"`,`Preview next run time for a cron expression`),
    "",
    b("MEMORY & RAG"),
    sub(`memory search <q>`,  `Search memory store`),
    sub(`memory list`,        `List all stored entries`),
    sub(`ingest <file>`,      `Ingest document into RAG store`),
    sub(`rag search <q>`,     `Search RAG document store`),
    "",
    b("MODELS"),
    sub(`models`,             `List Ollama models + Wire skill assignments`),
    sub(`models loaded`,      `Show models warm in RAM`),
    sub(`models set <s> <m>`, `Assign model to a Wire skill`),
    sub(`models pull <name>`, `Pull model from Ollama`),
    sub(`models info`,        `Show current .env overrides`),
    sub(`modelupdate`,        `Check + upgrade Ollama models (--yes pull, --install missing)`),
    sub(`providers`,          `List API providers (Groq, Gemini) with URLs + Wire model config`),
    sub(`providers check`,    `Fetch provider docs, analyze for stale or upgraded models`),
    sub(`providers upgrade`,  `Write updated model IDs to .env`),
    "",
    b("PLATFORM"),
    sub(`setup`,              `First-run check: Ollama, models, keys, dirs`),
    sub(`version`,            `Version running + check GitHub for a newer release`),
    sub(`update`,             `Update to the newest release (asks first; fast-forward only)`),
    sub(`engaged`,            `What Wire is doing right now, and for which CLI`),
    sub(`mcp`,                `Start Wire as MCP server (JSON-RPC 2.0 / stdio)`),
    sub(`classify "<text>"`,  `Inspect classifier routing decision`),
    sub(`route`,              `Inspect Layer 1 routing decision`),
    sub(`policy`,             `Provider/cost guardrails + fallback planner`),
    note(`  example: wire policy fallback research --parent codex --failed gemini:quota_exhausted`),
    "",
    b("PROTOCOL (low-level)"),
    sub(`keygen <agentId>`,   `Generate Ed25519 + X25519 keypair`),
    sub(`send`,               `Build + sign a wire message (JSON from stdin)`),
    sub(`recv <file>`,        `Decode + verify a .wire.json file`),
    sub(`verify <file>`,      `Check HMAC + signature only`),
    sub(`inspect <file>`,     `Human-readable message dump`),
    "",
    b("TERMS"),
    sub(`help terms`,         `Plain-language glossary: security reviewer, PhaseGate, HITL, QA/UAT, …`),
    sub(`help terms <word>`,  `One definition, e.g. wire help terms hitl`),
    "",
  ].join("\n") + "\n");
}
