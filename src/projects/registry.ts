// registry.ts — project registration and discovery
//
// Reads ~/.wire/projects.json (user-managed registry).
// Falls back to scanning ~/projects/active/ for STATUS.md if registry missing.
// Never scans arbitrary paths — only registered entries or known active dir.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface ProjectEntry {
  id: string;
  path: string;
  enabled: boolean;
}

export interface ProjectRegistry {
  version: number;
  projects: Record<string, { path: string; enabled: boolean }>;
}

const WIRE_DIR = join(homedir(), ".wire");
const REGISTRY_PATH = join(WIRE_DIR, "projects.json");
const ACTIVE_DIR = join(homedir(), "projects", "active");

export function loadRegistry(): ProjectRegistry {
  if (existsSync(REGISTRY_PATH)) {
    try {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as ProjectRegistry;
    } catch {
      // fall through to auto-discovery
    }
  }
  return autoDiscover();
}

function autoDiscover(): ProjectRegistry {
  const projects: Record<string, { path: string; enabled: boolean }> = {};
  if (!existsSync(ACTIVE_DIR)) return { version: 1, projects };

  try {
    const entries = readdirSync(ACTIVE_DIR);
    for (const name of entries) {
      const projectPath = join(ACTIVE_DIR, name);
      try {
        if (statSync(projectPath).isDirectory()) {
          if (existsSync(join(projectPath, "STATUS.md")) ||
              existsSync(join(projectPath, "MANIFEST.json"))) {
            projects[name] = { path: projectPath, enabled: true };
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return { version: 1, projects };
}

export function getRegisteredProjects(): ProjectEntry[] {
  const registry = loadRegistry();
  return Object.entries(registry.projects)
    .filter(([, v]) => v.enabled)
    .map(([id, v]) => ({ id, path: v.path, enabled: v.enabled }));
}

export function getProject(id: string): ProjectEntry | null {
  const registry = loadRegistry();
  const entry = registry.projects[id];
  if (!entry || !entry.enabled) return null;
  return { id, path: entry.path, enabled: entry.enabled };
}

export function saveRegistry(registry: ProjectRegistry): void {
  if (!existsSync(WIRE_DIR)) mkdirSync(WIRE_DIR, { mode: 0o700, recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), { mode: 0o600 });
}

export function registerProject(id: string, projectPath: string): void {
  const registry = loadRegistry();
  registry.projects[id] = { path: resolve(projectPath), enabled: true };
  saveRegistry(registry);
}
