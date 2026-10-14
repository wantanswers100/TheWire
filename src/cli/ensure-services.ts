// ensure-services — lazy-start gate for gateway and dispatch loop.
// Called at the top of any user-facing wire command so services come up
// automatically if systemd hasn't started them yet.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
// ISS-031: sourced from config/paths.ts. This file previously hardcoded
// "http://127.0.0.1:31338" with no WIRE_GATEWAY env override — a third
// independent literal for the same value (equivalent to localhost in
// practice on this box, but still an unenforced duplicate).
import { PROJECT_ROOT, GATEWAY_URL } from "../config/paths.js";

const PID_FILE = join(PROJECT_ROOT, ".wire-state", "dispatch.pid");

async function gatewayUp(): Promise<boolean> {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnGateway(): void {
  const proc = Bun.spawn(
    ["bun", "run", join(PROJECT_ROOT, "src/gateway/server.ts")],
    { cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "ignore"], detached: true }
  );
  proc.unref();
}

function dispatchRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnDispatch(): void {
  const proc = Bun.spawn(
    ["bun", "run", join(PROJECT_ROOT, "src/dispatch/cmd.ts"), "start"],
    { cwd: PROJECT_ROOT, stdio: ["ignore", "ignore", "ignore"], detached: true }
  );
  proc.unref();
}

export async function ensureServices(): Promise<void> {
  let gwUp = await gatewayUp();

  if (!gwUp) {
    spawnGateway();
    // Brief wait — 1.2s max, check twice
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(400);
      gwUp = await gatewayUp();
      if (gwUp) break;
    }
    if (gwUp) {
      process.stderr.write("[wire] gateway started\n");
    }
  }

  if (!dispatchRunning()) {
    spawnDispatch();
    process.stderr.write("[wire] dispatch started\n");
  }
}
