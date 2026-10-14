// codexResult.ts — writes a codex_claude_{YYYYMMDD}_{HHMM}_{topic}_{id}.md result
// handoff to ~/projects/inbox/ ONLY. Never writes to a target project — this
// module has no parameter that accepts a project path for writing, by design,
// so there is no way to misuse it into writing outside inbox/.

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// ISS-031: sourced from config/paths.ts.
import { INBOX_DIR } from "../config/paths.js";

export interface CodexResultInput {
  project: string;
  sourceFile: string;   // basename shown under "Source handoff" — human readability only
  taskType: string;
  workType?: string;
  dispatchId: string;   // full 64-char hex — the reliable lookup key, never truncated here
  status: "done" | "failed" | "policy_violation";
  output?: string;         // present when status: "done"
  error?: string;          // present when status: "failed"
  violationDetail?: string; // present when status: "policy_violation" — from codexPostRunVerify
  changedPaths?: string[];  // present when status: "policy_violation" — what git status actually showed
  scratchMode?: boolean;    // true when dispatched via --test-scratch — never inferred, only set explicitly by the caller
}

export function defaultInboxDir(): string {
  return INBOX_DIR;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function topicSlug(project: string): string {
  return project.replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase();
}

/**
 * Write the result handoff and return its full path. Synchronous, single
 * write — no partial-write handling needed since content is fully built in
 * memory before the write call.
 */
export function writeCodexResult(input: CodexResultInput, inboxDir: string = defaultInboxDir()): string {
  mkdirSync(inboxDir, { recursive: true });

  const now = new Date();
  const filename = `codex_claude_${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}_${topicSlug(input.project)}_${input.dispatchId.slice(0, 12)}.md`;
  const filePath = join(inboxDir, filename);

  const headerLines = [
    "---",
    "from: codex",
    "to: claude",
    "target: claude",
    `date: ${now.toISOString()}`,
    `project: ${input.project}`,
    "status: actioned",
    ...(input.workType ? [`work_type: ${input.workType}`] : []),
    `task_type: ${input.taskType}`,
    "trust_level: Execution",
    "requires_validation: Yes",
    `source_handoff: ${input.sourceFile}`,
    `dispatch_id: ${input.dispatchId}`,
    `dispatch_status: ${input.status}`,
    ...(input.scratchMode ? ["scratch_mode: true"] : []),
    "---",
  ];

  const outcomeSection = input.status === "done"
    ? ["## Output", input.output ?? "(no output captured)"]
    : input.status === "policy_violation"
      ? [
          "## Policy Violation",
          input.violationDetail ?? "(no detail captured)",
          "",
          "## Changed paths (from git status)",
          input.changedPaths && input.changedPaths.length > 0 ? input.changedPaths.join("\n") : "(none listed)",
          "",
          "No automatic rollback was performed. Review the working tree directly",
          "(git diff / git status) and revert manually if the change is not wanted.",
        ]
      : ["## Error", input.error ?? "(no error message captured)"];

  const content = [
    ...headerLines,
    "",
    `# Result — ${input.project} — ${input.taskType}`,
    "",
    "## Source handoff",
    input.sourceFile,
    "",
    ...outcomeSection,
    "",
    "VALIDATED_BY:            (blank — the owner fills on review)",
    "",
  ].join("\n");

  writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  return filePath;
}
