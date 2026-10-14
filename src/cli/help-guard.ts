// Central --help/-h interception (QA T2, 2026-09-30; re-proven 2026-10-13
// when `wire keygen --help` wrote .keys/--help.*). Runs before any command.
//
// - Help flag as the first argument: usage, for any command that doesn't
//   print its own detailed help (those are left alone so their help shows).
// - Commands that write state (keys, config, files, schedules): the flag
//   anywhere means help, so a stray --help can never become an argument.
// - Everything else takes free text after the first argument
//   ("wire - what does ls -h do", "wire shell ls -h"), so a later -h is text.

const HELP_FLAGS = new Set(["--help", "-h"]);
const OWN_HELP = new Set(["task", "models", "policy", "fetch", "shell", "weather", "ask", "-"]);
const WRITES_STATE = new Set(["keygen", "setup", "sync", "send", "recv", "verify", "cron", "update", "ingest", "inspect"]);

export function isHelpRequest(subcommand: string | undefined, rest: string[]): boolean {
  if (!subcommand || subcommand === "help" || HELP_FLAGS.has(subcommand)) return false;
  if (OWN_HELP.has(subcommand)) return false;
  if (HELP_FLAGS.has(rest[0] ?? "")) return true;
  return WRITES_STATE.has(subcommand) && rest.some((a) => HELP_FLAGS.has(a));
}
