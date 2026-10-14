// Wire release version — the one number that changes every release.
//
// Single source of truth is package.json's "version"; this module only reads
// it, so there is no second copy to drift. Every merge to main is a release:
// bump package.json, add the matching CHANGELOG.md section, tag vX.Y.Z
// (tests/version.test.ts fails if package.json and CHANGELOG.md disagree).
//
// Not to be confused with WIRE_VERSION in types.ts — that is the message
// envelope protocol version ("WireProtocol v1"), which only changes when the
// .wire.json format itself changes, never on an ordinary release.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

export const APP_VERSION: string = pkg.version;

const ROOT = join(import.meta.dir, "..");

export interface VersionDetails {
  version: string;
  releaseDate?: string;   // from the matching CHANGELOG.md heading
  commit?: string;        // short SHA of the running checkout
  branch?: string;
  tag?: string;           // exact vX.Y.Z tag on HEAD, if any
  dirty?: boolean;        // uncommitted changes in the running checkout
  aheadOfMain?: number;   // commits on HEAD not yet in main (unreleased)
}

function git(args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 2000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/**
 * What code is actually running. Local git only — no network, ~10ms. Every
 * git field is optional: a zip download has no .git and just shows the version.
 */
export function versionDetails(): VersionDetails {
  const d: VersionDetails = { version: APP_VERSION };
  try {
    const cl = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const esc = APP_VERSION.replace(/\./g, "\\.");
    d.releaseDate = new RegExp(`^## ${esc} — (\\d{4}-\\d{2}-\\d{2})$`, "m").exec(cl)?.[1];
  } catch { /* no changelog shipped — version alone is still correct */ }

  d.commit = git(["rev-parse", "--short", "HEAD"]);
  if (!d.commit) return d;
  d.branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  d.tag = git(["describe", "--tags", "--exact-match", "--match", "v[0-9]*"]);
  d.dirty = (git(["status", "--porcelain", "--untracked-files=no"]) ?? "") !== "";
  if (d.branch !== "main") {
    const n = Number(git(["rev-list", "--count", "main..HEAD"]));
    if (Number.isFinite(n)) d.aheadOfMain = n;
  }
  return d;
}

/** One line, e.g. "1.1.0 (2026-09-30) · 808286f on fix/x · 3 commits not in main · uncommitted changes" */
export function formatVersionLine(d: VersionDetails = versionDetails()): string {
  const parts = [`${d.version}${d.releaseDate ? ` (${d.releaseDate})` : ""}`];
  if (d.commit) {
    parts.push(`${d.commit}${d.tag ? ` ${d.tag}` : ""} on ${d.branch ?? "?"}`);
    if (d.aheadOfMain) parts.push(`${d.aheadOfMain} commit${d.aheadOfMain === 1 ? "" : "s"} not in main — unreleased`);
    if (d.dirty) parts.push("uncommitted changes");
  }
  return parts.join("  ·  ");
}

// ─── Release check (wire version / wire update) ──────────────────────────────

/** SemVer compare for "X.Y.Z" (a leading "v" is ignored): >0 if a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Newest "vX.Y.Z" tag in `git ls-remote --tags --refs` output, or undefined. */
export function newestReleaseTag(lsRemoteOutput: string): string | undefined {
  const tags = [...lsRemoteOutput.matchAll(/refs\/tags\/(v\d+\.\d+\.\d+)$/gm)].map(m => m[1]!);
  return tags.sort((a, b) => compareVersions(b, a))[0];
}

export type ReleaseCheck =
  | { state: "no-git" }
  | { state: "unreachable"; detail: string }
  | { state: "no-releases" }
  | { state: "up-to-date"; latest: string }
  | { state: "newer"; latest: string }
  | { state: "ahead"; latest: string };   // running a version newer than the newest published tag

/**
 * Asks the repo's own `origin` (TheWire for public users) which release tags
 * exist. Read-only, one network call, 8s cap. Never changes anything locally.
 */
export function checkForRelease(current = APP_VERSION): ReleaseCheck {
  if (!git(["rev-parse", "--git-dir"])) return { state: "no-git" };
  const r = spawnSync("git", ["-C", ROOT, "ls-remote", "--tags", "--refs", "origin", "v*"], { encoding: "utf8", timeout: 8000 });
  if (r.status !== 0) {
    return { state: "unreachable", detail: (r.stderr || r.error?.message || "no response").trim().split("\n")[0]!.slice(0, 120) };
  }
  const latest = newestReleaseTag(r.stdout);
  if (!latest) return { state: "no-releases" };
  const c = compareVersions(latest, current);
  if (c > 0) return { state: "newer", latest };
  if (c < 0) return { state: "ahead", latest };
  return { state: "up-to-date", latest };
}
