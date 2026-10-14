#!/usr/bin/env bun
// wire dispatch start|stop|status
//
// Usage:
//   bun run wire dispatch start    — start the dispatch loop daemon
//   bun run wire dispatch stop     — stop (writes .wire-state/dispatch.pid then kills)
//   bun run wire dispatch status   — show recent dispatch records

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { DispatchLoop } from "./loop.js";
import { DispatchDB } from "./db.js";
import { SkillCapture } from "../skills/SkillCapture.js";
// ISS-031: sourced from config/paths.ts, the single shared definition.
// ISS-026 was this exact daemon watching a stale, independently-hardcoded
// ~/.wire/inbox for over a month while every CLI entrypoint wrote to
// ~/projects/inbox — now there is exactly one place either value can drift.
import { KEYS_DIR, STATE_DIR, INBOX_DIR, GATEWAY_URL } from "../config/paths.js";

const PID_FILE = join(STATE_DIR, "dispatch.pid");
const AGENT_TOKEN = process.env["WIRE_TOKEN"] ?? "";

const [, , subcmd] = process.argv;

// ─── start ────────────────────────────────────────────────────────────────────

if (subcmd === "start") {
  if (existsSync(PID_FILE)) {
    const pid = readFileSync(PID_FILE, "utf8").trim();
    console.log(`Dispatch loop already running (pid ${pid}). Use 'wire dispatch stop' first.`);
    process.exit(1);
  }

  writeFileSync(PID_FILE, String(process.pid), { encoding: "utf8", mode: 0o600 });
  console.log(`[dispatch] pid ${process.pid} written to ${PID_FILE}`);

  const skillCapture = new SkillCapture(STATE_DIR);

  const loop = new DispatchLoop({
    keysDir: KEYS_DIR,
    stateDir: STATE_DIR,
    inboxDir: INBOX_DIR,
    gatewayUrl: GATEWAY_URL,
    agentToken: AGENT_TOKEN,
    onOutcome: skillCapture.asHook(),
  });

  // Session brief before starting — shows recent task history
  console.log("\n" + loop.sessionBrief() + "\n");

  loop.start();

  process.on("SIGINT", () => { loop.stop(); if (existsSync(PID_FILE)) unlinkSync(PID_FILE); process.exit(0); });
  process.on("SIGTERM", () => { loop.stop(); if (existsSync(PID_FILE)) unlinkSync(PID_FILE); process.exit(0); });

  // Keep alive
  setInterval(() => {}, 60_000);
}

// ─── stop ─────────────────────────────────────────────────────────────────────

else if (subcmd === "stop") {
  if (!existsSync(PID_FILE)) {
    console.log("Dispatch loop is not running.");
    process.exit(0);
  }
  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    unlinkSync(PID_FILE);
    console.log(`[dispatch] stopped (pid ${pid})`);
  } catch (e) {
    console.error(`Failed to stop pid ${pid}:`, e);
    unlinkSync(PID_FILE);
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

else if (subcmd === "status") {
  const running = existsSync(PID_FILE);
  const pid = running ? readFileSync(PID_FILE, "utf8").trim() : null;
  console.log(`Dispatch loop: ${running ? `RUNNING (pid ${pid})` : "STOPPED"}`);

  const db = new DispatchDB(STATE_DIR);
  const errors = db.recentErrors(5);
  if (errors.length > 0) {
    console.log(`\nRecent failures (${errors.length}):`);
    for (const r of errors) {
      console.log(`  ${r.id.slice(0, 8)} skill=${r.skill} routed_to=${r.routed_to} error=${r.error?.slice(0, 80)}`);
    }
  } else {
    console.log("No recent failures.");
  }
}

// ─── review ───────────────────────────────────────────────────────────────────
// Operator recovery path for PhaseGate-escalated tasks (ISS-052).
// Tasks in awaiting_review are permanent dead-ends without this path.

else if (subcmd === "review") {
  const [, , , reviewCmd, reviewId] = process.argv;
  const db = new DispatchDB(STATE_DIR);

  if (reviewCmd === "list") {
    const rows = db.listAwaitingReview();
    if (rows.length === 0) {
      console.log("No tasks awaiting review.");
    } else {
      console.log(`Tasks awaiting review (${rows.length}):\n`);
      for (const r of rows) {
        const age = Math.round((Date.now() - r.updated_at) / 60_000);
        console.log(`  ${r.id.slice(0, 8)}  skill=${r.skill}  from=${r.from}  age=${age}m`);
        if (r.error) console.log(`           reason: ${r.error}`);
      }
      console.log(`\nApprove: wire dispatch review approve <id-prefix>`);
      console.log(`Reject:  wire dispatch review reject <id-prefix>`);
    }
    db.close();

  } else if (reviewCmd === "approve" && reviewId) {
    // Support 8-char prefix matching
    const rows = db.listAwaitingReview();
    const match = rows.find(r => r.id === reviewId || r.id.startsWith(reviewId));
    if (!match) {
      console.error(`No awaiting_review task found matching: ${reviewId}`);
      db.close();
      process.exit(1);
    }
    const ok = db.claimAwaitingReview(match.id);
    db.close();
    if (ok) {
      console.log(`[review] approved ${match.id.slice(0, 8)} — status set to done`);
      console.log(`Note: to re-run this task, submit a new request via 'wire ask' or 'wire task'.`);
    } else {
      console.error(`[review] claim failed — task may have already been resolved`);
      process.exit(1);
    }

  } else if (reviewCmd === "reject" && reviewId) {
    const rows = db.listAwaitingReview();
    const match = rows.find(r => r.id === reviewId || r.id.startsWith(reviewId));
    if (!match) {
      console.error(`No awaiting_review task found matching: ${reviewId}`);
      db.close();
      process.exit(1);
    }
    const ok = db.rejectAwaitingReview(match.id);
    db.close();
    if (ok) {
      console.log(`[review] rejected ${match.id.slice(0, 8)} — status set to rejected`);
    } else {
      console.error(`[review] reject failed — task may have already been resolved`);
      process.exit(1);
    }

  } else {
    console.log(`Usage: wire dispatch review <list|approve|reject> [id]`);
    db.close();
    process.exit(1);
  }
}

// ─── help ─────────────────────────────────────────────────────────────────────

else {
  console.log(`Usage: wire dispatch <start|stop|status|review>`);
  process.exit(1);
}
