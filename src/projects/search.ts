// search.ts — search across project context files
//
// Greps registered project files under context/ for a query string.
// Returns structured matches with file, line number, and snippet.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SearchMatch {
  file: string;
  line: number;
  snippet: string;
}

export interface SearchResult {
  project: string;
  query: string;
  matches: SearchMatch[];
  total: number;
  truncated: boolean;
}

const MAX_MATCHES = 20;
// profile/, snapshots/, questions/ added 2026-09-29 (owner explicit) — see
// security.ts's matching note; same global-allowlist tradeoff applies here.
const SEARCH_DIRS = ["context", "docs", "profile", "snapshots", "questions"];

export function searchProject(
  projectId: string,
  projectRoot: string,
  query: string,
): SearchResult {
  const matches: SearchMatch[] = [];
  const lq = query.toLowerCase();

  for (const dir of SEARCH_DIRS) {
    const dirPath = join(projectRoot, dir);
    if (!existsSync(dirPath)) continue;

    for (const filename of readdirSync(dirPath)) {
      const filePath = join(dirPath, filename);
      try {
        if (!statSync(filePath).isFile()) continue;
        const lines = readFileSync(filePath, "utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(lq)) {
            matches.push({
              file: `${dir}/${filename}`,
              line: i + 1,
              snippet: lines[i]!.trim().slice(0, 200),
            });
            if (matches.length >= MAX_MATCHES) break;
          }
        }
      } catch { /* skip unreadable files */ }
      if (matches.length >= MAX_MATCHES) break;
    }
    if (matches.length >= MAX_MATCHES) break;
  }

  return {
    project: projectId,
    query,
    matches,
    total: matches.length,
    truncated: matches.length >= MAX_MATCHES,
  };
}
