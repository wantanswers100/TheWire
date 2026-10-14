import { readFileSync } from "node:fs";

// ─── Legacy Markdown handoff detection + parsing ──────────────────────────────
// Parses the existing bare key:value header format used in ~/projects/inbox/.md files.
// This is read-only — we detect and log legacy files but do not modify them.

export interface LegacyHandoff {
  from?: string;
  to?: string;
  target?: string;
  date?: string;
  project?: string;
  status?: string;
  workType?: string;
  body: string;
}

const HEADER_RE = /^([a-zA-Z_-]+):\s*(.*)$/;

export function parseLegacyHandoff(content: string): LegacyHandoff {
  const lines = content.split("\n");
  const headers: Record<string, string> = {};
  let bodyStart = 0;
  let inYaml = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i === 0 && line.trim() === "---") { inYaml = true; continue; }
    if (inYaml && line.trim() === "---") { bodyStart = i + 1; break; }
    if (inYaml) {
      const m = HEADER_RE.exec(line);
      if (m) headers[m[1]!.toLowerCase()] = (m[2] ?? "").trim();
      continue;
    }
    const m = HEADER_RE.exec(line);
    if (m) {
      headers[m[1]!.toLowerCase().replace("-", "_")] = (m[2] ?? "").trim();
    } else if (line.trim() === "" && Object.keys(headers).length > 0) {
      bodyStart = i + 1;
      break;
    } else if (Object.keys(headers).length > 0) {
      bodyStart = i;
      break;
    }
  }

  const body = lines.slice(bodyStart).join("\n").trim();

  return {
    from: headers["from"],
    to: headers["to"],
    target: headers["target"],
    date: headers["date"],
    project: headers["project"],
    status: headers["status"],
    workType: headers["work_type"],
    body,
  };
}

export function isLegacyFile(filename: string): boolean {
  return filename.endsWith(".md");
}

export function isWireFile(filename: string): boolean {
  return filename.endsWith(".wire.json");
}
