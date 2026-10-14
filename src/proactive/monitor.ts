// Proactive Monitor — Wire Platform Phase 21
//
// Cross-project STATUS.md watcher. At session startup, scans configured
// project directories and reports which ones have changed since last run.
//
// Config: .wire-state/projects.json
//   { "projects": [{ "name": "myproject", "path": "/abs/path/to/project" }] }
//
// State: .wire-state/monitor.db (SQLite, content hashes)
//
// Security:
//   - Project paths are validated against .keys/ before any read
//   - STATUS.md paths resolved via realpathSync to defeat symlink injection
//   - STATUS.md preview lines prefixed with "> " to prevent session brief spoofing
//
// Designed to be called once at session start (from WireAgent.sessionBrief).
// Always succeeds — config parse errors, missing STATUS.md, and unreadable files
// are all handled gracefully and surfaced in the digest rather than swallowed.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const CONFIG_FILE = "projects.json";
const SNAPSHOT_LINES = 10;    // lines of STATUS.md captured per project
const BRIEF_LINES = 5;        // lines shown in session brief when changed

// .keys/ guard directory — computed once at module load
const KEYS_DIR_RAW = join(import.meta.dir, "../../.keys");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface ProjectDigest {
  name: string;
  path: string;
  hasStatus: boolean;
  changed: boolean;     // true if STATUS.md changed since last session
  isNew: boolean;       // true if first time seeing this project
  snapshot: string;     // first SNAPSHOT_LINES lines of STATUS.md
  lastSeen: number;     // epoch ms of previous check (0 = never seen)
  readError?: string;   // set when STATUS.md exists but could not be read
}

// ─── Config parser (module-level, exported for direct testing) ────────────────

export function parseProjectsConfig(raw: string): ProjectEntry[] {
  const parsed = JSON.parse(raw) as { projects?: unknown };
  if (!Array.isArray(parsed.projects)) {
    console.warn("[monitor] projects.json: 'projects' key is not an array — check config");
    return [];
  }
  return parsed.projects.filter(
    (p): p is ProjectEntry =>
      typeof p === "object" &&
      p !== null &&
      typeof (p as Record<string, unknown>)["name"] === "string" &&
      typeof (p as Record<string, unknown>)["path"] === "string" &&
      ((p as Record<string, unknown>)["name"] as string).length > 0 &&
      ((p as Record<string, unknown>)["path"] as string).length > 0
  );
}

// ─── ProactiveMonitor ─────────────────────────────────────────────────────────

export class ProactiveMonitor {
  private db: Database;
  private stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "monitor.db"));
    this.db.run(`
      CREATE TABLE IF NOT EXISTS project_state (
        name         TEXT PRIMARY KEY,
        path         TEXT NOT NULL,
        content_hash TEXT NOT NULL DEFAULT '',
        snapshot     TEXT NOT NULL DEFAULT '',
        last_seen    INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  // ── digest ────────────────────────────────────────────────────────────────
  // Scans all configured projects. Returns per-project status.
  // Updates stored hashes after scanning so next call detects further changes.
  // Not idempotent — call once per session at startup.

  digest(): ProjectDigest[] {
    const projects = this.loadProjects();
    if (projects.length === 0) return [];

    // Prune stale DB rows for projects no longer in config (CR1)
    // Prevents stale hashes from mis-classifying a re-used project name
    const configuredNames = new Set(projects.map(p => p.name));
    if (configuredNames.size > 0) {
      const placeholders = [...configuredNames].map(() => "?").join(",");
      this.db.run(
        `DELETE FROM project_state WHERE name NOT IN (${placeholders})`,
        [...configuredNames]
      );
    }

    // Resolve .keys/ guard once for the whole scan
    const resolvedKeysDir = existsSync(KEYS_DIR_RAW) ? realpathSync(KEYS_DIR_RAW) : null;

    const results: ProjectDigest[] = [];

    for (const p of projects) {
      const statusPath = join(p.path, "STATUS.md");

      if (!existsSync(statusPath)) {
        results.push({
          name: p.name, path: p.path,
          hasStatus: false, changed: false, isNew: false,
          snapshot: "", lastSeen: 0,
        });
        continue;
      }

      // Security: resolve symlinks before reading — reject if canonical path falls inside .keys/
      if (resolvedKeysDir) {
        try {
          const canonical = realpathSync(statusPath);
          if (canonical === resolvedKeysDir || canonical.startsWith(resolvedKeysDir + "/")) {
            console.error(`[monitor] security: refusing to read ${statusPath} — resolves into .keys/`);
            results.push({
              name: p.name, path: p.path,
              hasStatus: false, changed: false, isNew: false,
              snapshot: "", lastSeen: 0,
              readError: "path resolves into protected .keys/ directory",
            });
            continue;
          }
        } catch {
          // realpathSync failure — treat as unreadable below
        }
      }

      let content: string;
      try {
        content = readFileSync(statusPath, "utf8");
      } catch (e) {
        // Surface as an explicit error entry rather than silently dropping the project (SF2/CR4)
        console.warn(`[monitor] cannot read STATUS.md for '${p.name}': ${(e as Error).message}`);
        results.push({
          name: p.name, path: p.path,
          hasStatus: true, changed: false, isNew: false,
          snapshot: "", lastSeen: 0,
          readError: (e as Error).message,
        });
        continue;
      }

      const hash = createHash("sha256").update(content).digest("hex");
      const snapshot = content.split("\n").slice(0, SNAPSHOT_LINES).join("\n").trim();
      const now = Date.now();

      const stored = this.db.query(
        "SELECT content_hash, last_seen FROM project_state WHERE name = ?"
      ).get(p.name) as { content_hash: string; last_seen: number } | null;

      const isNew = stored === null;
      const changed = isNew || stored.content_hash !== hash;

      this.db.run(
        `INSERT INTO project_state (name, path, content_hash, snapshot, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path         = excluded.path,
           content_hash = excluded.content_hash,
           snapshot     = excluded.snapshot,
           last_seen    = excluded.last_seen`,
        [p.name, p.path, hash, snapshot, now]
      );

      results.push({
        name: p.name, path: p.path,
        hasStatus: true, changed, isNew,
        snapshot, lastSeen: stored?.last_seen ?? 0,
      });
    }

    return results;
  }

  // ── format ────────────────────────────────────────────────────────────────
  // Returns a human-readable block for session brief.
  // Returns empty string when there are no digests (no config, no projects).

  format(digests: ProjectDigest[]): string {
    if (digests.length === 0) return "";

    // Invariant: isNew=true implies changed=true (new implies changed)
    for (const d of digests) {
      if (d.isNew && !d.changed) {
        console.error(`[monitor] invariant violation: isNew=true but changed=false for project '${d.name}' — digest may be stale`);
      }
    }

    const lines = ["Projects", "─".repeat(40)];

    for (const d of digests) {
      if (!d.hasStatus) {
        const label = d.readError ? `unreadable` : "no STATUS.md";
        lines.push(`  · ${d.name}  [${label}]`);
        if (d.readError) lines.push(`    error: ${d.readError}`);
        continue;
      }

      const mark = d.changed ? "↑" : "·";
      const label = d.isNew ? "new" : d.changed ? "updated" : "unchanged";
      lines.push(`  ${mark} ${d.name}  [${label}]`);

      if (d.changed && d.snapshot) {
        // Prefix with "> " to clearly mark as external content — prevents STATUS.md
        // from spoofing Wire session brief output (task entries, status marks, headers)
        for (const line of d.snapshot.split("\n").slice(0, BRIEF_LINES)) {
          if (line.trim()) lines.push(`    > ${line}`);
        }
      }
    }

    lines.push("─".repeat(40));
    return lines.join("\n");
  }

  // ── loadProjects (private — use parseProjectsConfig for unit testing) ─────

  private loadProjects(): ProjectEntry[] {
    const configPath = join(this.stateDir, CONFIG_FILE);
    if (!existsSync(configPath)) return [];  // not yet configured — silent is correct

    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch (e) {
      console.error(`[monitor] cannot read projects.json: ${(e as Error).message}`);
      return [];
    }

    try {
      return parseProjectsConfig(raw);
    } catch (e) {
      console.error(`[monitor] projects.json is malformed: ${(e as Error).message}`);
      return [];
    }
  }
}
