// wire workspace — manage connected folders
//
// Usage:
//   wire workspace                          list connected workspaces
//   wire workspace add <path>              connect a folder (default mode: rw)
//   wire workspace add <path> --name <n>   connect with a custom name
//   wire workspace add <path> --mode r     connect read-only
//   wire workspace remove <name|path>      disconnect a folder
//   wire workspace clear                   disconnect all folders

import { listWorkspaces, addWorkspace, removeWorkspace, clearWorkspaces } from "../startup/workspaces.js";

const ok   = (s: string) => `\x1b[32m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim  = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function printList(): void {
  const workspaces = listWorkspaces();

  if (workspaces.length === 0) {
    console.log(dim("\n  No workspaces connected."));
    console.log(dim("  Add one: wire workspace add <path>\n"));
    return;
  }

  console.log(bold(`\nWorkspaces (${workspaces.length})`));
  for (const ws of workspaces) {
    const modeLabel = ws.mode === "rw" ? "read+write" : ws.mode === "r" ? "read-only" : "write-only";
    console.log(
      `  ${ok("●")}  ${cyan(ws.name.padEnd(24))}` +
      `  ${ws.path}` +
      `  ${dim(`[${modeLabel}]`)}`,
    );
  }
  console.log();
}

export function runWorkspace(args: string[]): void {
  const sub = args[0];

  if (!sub || sub === "list") {
    printList();
    return;
  }

  if (sub === "add") {
    // Collect positional (non-flag) args after "add"
    const positionals = args.slice(1).filter((a, i, arr) =>
      !a.startsWith("--") && arr[i - 1] !== "--name" && arr[i - 1] !== "--mode"
    );
    const rawPath = positionals[0];

    if (!rawPath) {
      console.error("Usage: wire workspace add <path> [--name <name>] [--mode r|w|rw]");
      process.exit(1);
    }

    const nameIdx = args.indexOf("--name");
    const name    = nameIdx >= 0 ? args[nameIdx + 1] : undefined;

    const modeIdx = args.indexOf("--mode");
    const modeRaw = modeIdx >= 0 ? args[modeIdx + 1] : "rw";
    const mode    = (["r", "w", "rw"].includes(modeRaw ?? "") ? modeRaw : "rw") as "r" | "w" | "rw";

    try {
      const ws = addWorkspace(rawPath, name, mode);
      console.log(`${ok("✓")} Connected  ${cyan(ws.name)}  ${ws.path}  ${dim(`[${mode}]`)}`);
    } catch (e) {
      console.error(`${warn("✗")} ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "remove" || sub === "rm" || sub === "disconnect") {
    const target = args[1];
    if (!target) {
      console.error("Usage: wire workspace remove <name|path>");
      process.exit(1);
    }

    if (removeWorkspace(target)) {
      console.log(`${ok("✓")} Disconnected  ${target}`);
    } else {
      console.error(`${warn("✗")} Not found: ${target}`);
      process.exit(1);
    }
    return;
  }

  if (sub === "clear") {
    clearWorkspaces();
    console.log(ok("✓ All workspaces cleared."));
    return;
  }

  console.error(`Unknown workspace subcommand: ${sub}`);
  console.error("  wire workspace add|list|remove|clear");
  process.exit(1);
}
