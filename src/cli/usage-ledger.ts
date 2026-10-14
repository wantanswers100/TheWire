// usage-ledger.ts — append model usage entries to ~/projects/logs/runs/usage/YYYY-MM-DD.md

import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface LedgerEntry {
  project: string;
  taskType: string;
  localModel: string;
  onlineModel: string;
  escalationReason: string;
  resultStatus: string;
}

function usagePath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(homedir(), "projects", "logs", "runs", "usage", `${today}.md`);
}

const HEADER = "| Timestamp | Project | Task Type | Local Model | Online Model | Escalation Reason | Status |\n|-----------|---------|-----------|-------------|--------------|-------------------|--------|\n";

export function appendLedgerEntry(entry: LedgerEntry): void {
  // Ledger writes are best-effort — never crash the calling command
  try {
    const path = usagePath();
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const row = `| ${ts} | ${entry.project} | ${entry.taskType} | ${entry.localModel} | ${entry.onlineModel} | ${entry.escalationReason} | ${entry.resultStatus} |\n`;

    if (!existsSync(path)) {
      appendFileSync(path, `# Usage Ledger — ${ts.slice(0, 10)}\n\n${HEADER}${row}`, "utf8");
    } else {
      appendFileSync(path, row, "utf8");
    }
  } catch (e) {
    if (process.env["WIRE_DEBUG"]) {
      console.debug(`[wire] Ledger write failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
