// wire version — show what is running and whether a newer release exists
// wire update  — move this checkout to the newest release tag, after asking
//
// Releases are cut by the maintainer (local → QA/UAT → production); users only
// check and pull. `update` is fast-forward only: it never discards local work,
// never rewrites history, and refuses if the checkout is not a clean `main`.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { promptYesNo } from "./prompt.js";
import { checkForRelease, formatVersionLine, versionDetails, type ReleaseCheck } from "../version.js";

const ROOT = join(import.meta.dir, "..", "..");

function describe(check: ReleaseCheck): string {
  switch (check.state) {
    case "no-git":      return "Update check unavailable — not a git checkout (downloaded as a zip?).";
    case "unreachable": return `Couldn't reach GitHub to check for updates (${check.detail}).`;
    case "no-releases": return "No releases published on GitHub yet.";
    case "up-to-date":  return `Up to date — ${check.latest} is the latest release.`;
    case "ahead":       return `Running a newer version than the latest published release (${check.latest}).`;
    case "newer":       return `Update available: ${check.latest}  →  run: wire update`;
  }
}

export function runVersion(args: string[]): void {
  console.log(`wire ${formatVersionLine()}`);
  console.log(`protocol: WireProtocol v1   ·   release notes: CHANGELOG.md`);
  if (args.includes("--offline")) return;
  console.log(describe(checkForRelease()));
}

function git(args: string[], inherit = false): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: inherit ? "inherit" : "pipe", timeout: 120_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

async function confirm(question: string): Promise<boolean> {
  return promptYesNo(question);
}

export async function runUpdate(args: string[]): Promise<void> {
  const check = checkForRelease();
  console.log(describe(check));
  if (check.state !== "newer") return;

  // Preconditions — refuse rather than risk someone's local work.
  const d = versionDetails();
  const problems: string[] = [];
  if (d.branch !== "main") problems.push(`on branch "${d.branch}", not main (git checkout main)`);
  if (d.dirty) problems.push("uncommitted changes (commit or stash them first)");
  if (problems.length) {
    console.error(`\nNot updating:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }

  console.log(`\nThis will:\n  1. fetch release ${check.latest} from GitHub\n  2. fast-forward main to it (no local changes are touched or lost)\n  3. run bun install`);
  const yes = args.includes("--yes");
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("Not a terminal — re-run with --yes to update non-interactively.");
      process.exit(1);
    }
    if (!(await confirm(`Update ${d.version} → ${check.latest.replace(/^v/, "")}?`))) {
      console.log("Cancelled.");
      return;
    }
  }

  if (!git(["fetch", "--tags", "origin"], true).ok) { console.error("git fetch failed — nothing changed."); process.exit(1); }
  if (!git(["merge", "--ff-only", `refs/tags/${check.latest}`], true).ok) {
    console.error(`Can't fast-forward to ${check.latest} — this main has commits that aren't in the release. Nothing changed.`);
    process.exit(1);
  }
  const install = spawnSync("bun", ["install"], { cwd: ROOT, stdio: "inherit" });
  if (install.status !== 0) {
    console.error("Code updated, but bun install failed — run `bun install` in the wire folder before using wire.");
    process.exit(1);
  }

  // Re-read from disk: this process still holds the old package.json in memory.
  const after = spawnSync("bun", ["run", join(ROOT, "src/cli/index.ts"), "version", "--offline"], { encoding: "utf8" });
  if (after.status !== 0) {
    console.error("Updated, but the new version failed to start — run `wire version` to see the error.");
    process.exit(1);
  }
  console.log(`\nUpdated.\n${(after.stdout ?? "").split("\n")[0] ?? ""}`);
  console.log("Restart background services to use it:  wire dispatch stop && wire dispatch start");
}
