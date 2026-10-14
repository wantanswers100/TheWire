// agyAuth.ts — presence-only agy CLI auth check.
//
// Verifies that the agy CLI is installed and executable. agy authenticates
// via Google account OAuth managed internally by the Antigravity app — there
// is no token file or env var to check. configured = CLI present and runnable.
//
// Never invokes a real model call. Never reads credentials. Fail-closed:
// any spawn error → not configured.

import { spawnSync } from "node:child_process";

export interface AgyAuthStatus {
  cliPresent: boolean;
  cliVersion: string | null;  // informational only — from `agy --version` stdout
  configured: boolean;        // true iff CLI is present and executable
}

export function checkAgyAuth(): AgyAuthStatus {
  const which = spawnSync("which", ["agy"], { encoding: "utf8" });
  if (which.status !== 0 || !which.stdout.trim()) {
    return { cliPresent: false, cliVersion: null, configured: false };
  }

  const ver = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 5_000 });
  // ver.error is set on ETIMEDOUT or spawn failure — treat as not configured (fail-closed).
  if (ver.error || ver.status !== 0) {
    return { cliPresent: true, cliVersion: null, configured: false };
  }
  const cliVersion = ver.stdout.trim() || null;
  return { cliPresent: true, cliVersion, configured: true };
}
