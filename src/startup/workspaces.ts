// Workspace store — persistent named connections to filesystem folders.
// Backed by .wire-state/workspaces.json (mode 600).

import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";

const STATE_FILE = join(import.meta.dir, "../../.wire-state/workspaces.json");

export interface Workspace {
  name:    string;
  path:    string;
  mode:    "r" | "w" | "rw";
  addedAt: string;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function load(): Workspace[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, "utf8")) as { workspaces?: Workspace[] };
    return data.workspaces ?? [];
  } catch {
    return [];
  }
}

function save(workspaces: Workspace[]): void {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({ workspaces }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
}

export function listWorkspaces(): Workspace[] {
  return load();
}

export function addWorkspace(rawPath: string, name?: string, mode: "r" | "w" | "rw" = "rw"): Workspace {
  const path = resolve(expandTilde(rawPath));

  if (!existsSync(path)) throw new Error(`Path does not exist: ${path}`);

  const s = statSync(path);
  if (!s.isDirectory()) throw new Error(`Not a directory: ${path}`);

  const all = load();
  const dup = all.find(w => w.path === path);
  if (dup) throw new Error(`Already connected as "${dup.name}": ${path}`);

  const ws: Workspace = {
    name:    name ?? basename(path),
    path,
    mode,
    addedAt: new Date().toISOString(),
  };

  save([...all, ws]);
  return ws;
}

export function removeWorkspace(nameOrPath: string): boolean {
  const all = load();
  const next = all.filter(w => w.name !== nameOrPath && w.path !== nameOrPath);
  if (next.length === all.length) return false;
  save(next);
  return true;
}

export function clearWorkspaces(): void {
  save([]);
}

export interface ResolvedFile {
  path:      string;
  workspace: Workspace;
}

// Find the first match for a filename / relative path across connected workspaces.
// Also accepts absolute paths (must fall inside a workspace).
export function resolveInWorkspaces(fileRef: string): ResolvedFile | null {
  const expanded = expandTilde(fileRef);
  const all = load();

  if (expanded.startsWith("/") && existsSync(expanded)) {
    const ws = all.find(w => expanded.startsWith(w.path + "/") || expanded === w.path) ?? all[0];
    if (ws) return { path: expanded, workspace: ws };
    return null;
  }

  for (const ws of all) {
    const candidate = join(ws.path, fileRef);
    if (existsSync(candidate)) return { path: candidate, workspace: ws };
  }

  return null;
}

// Extract the last fenced code block from a string.
export function extractLastCodeBlock(text: string): { code: string; lang: string } | null {
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let last: { code: string; lang: string } | null = null;
  for (const m of text.matchAll(re)) {
    last = { lang: m[1] ?? "", code: m[2] ?? "" };
  }
  return last;
}

export function writableWorkspaces(): Workspace[] {
  return load().filter(w => w.mode === "w" || w.mode === "rw");
}
