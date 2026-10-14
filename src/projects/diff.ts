// diff.ts — project change ledger using Git + working tree
//
// project_diff returns what changed since a given commit, run ID, or "HEAD".
// Git is primary ledger; working tree (uncommitted) tracked separately.

import { spawnSync } from "node:child_process";

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

export interface DiffResult {
  project: string;
  from: string | null;
  to: string | null;
  committed: ChangedFile[];
  working_tree: ChangedFile[];
  total_changes: number;
}

export function projectDiff(
  projectId: string,
  projectRoot: string,
  since?: string,
): DiffResult {
  const to = gitOut(projectRoot, ["rev-parse", "--short", "HEAD"]);

  let committed: ChangedFile[] = [];
  let from: string | null = null;

  if (since && since !== "HEAD" && since !== "working") {
    // Could be a commit hash or "last" (last commit)
    const ref = since === "last"
      ? gitOut(projectRoot, ["rev-parse", "--short", "HEAD~1"])
      : since;
    from = ref;
    if (ref) {
      const diffOut = gitOut(projectRoot, ["diff", "--name-status", ref, "HEAD"]);
      committed = parseNameStatus(diffOut ?? "");
    }
  } else if (!since || since === "last") {
    // Default: show last commit's changes
    from = gitOut(projectRoot, ["rev-parse", "--short", "HEAD~1"]);
    const diffOut = from
      ? gitOut(projectRoot, ["diff", "--name-status", from ?? "", "HEAD"])
      : null;
    committed = parseNameStatus(diffOut ?? "");
  }

  // Working tree (uncommitted changes)
  const statusOut = gitOut(projectRoot, ["status", "--porcelain"]);
  const workingTree = parsePortelain(statusOut ?? "");

  return {
    project: projectId,
    from,
    to,
    committed,
    working_tree: workingTree,
    total_changes: committed.length + workingTree.length,
  };
}

function parseNameStatus(text: string): ChangedFile[] {
  return text
    .split("\n")
    .filter(l => l.trim())
    .map(line => {
      const [code, ...parts] = line.split("\t");
      const path = parts.join("\t").trim();
      const status = codeToStatus(code?.charAt(0) ?? "");
      return { path, status };
    })
    .filter(f => f.path);
}

function parsePortelain(text: string): ChangedFile[] {
  return text
    .split("\n")
    .filter(l => l.trim())
    .map(line => {
      const code = line.slice(0, 2).trim();
      const path = line.slice(3).trim();
      return { path, status: codeToStatus(code.charAt(0)) };
    })
    .filter(f => f.path);
}

function codeToStatus(c: string): ChangedFile["status"] {
  switch (c) {
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "?": return "untracked";
    default:  return "modified";
  }
}

function gitOut(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0 || r.error) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}
