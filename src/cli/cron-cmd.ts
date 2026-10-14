import { CronRegistry } from "../cron/CronRegistry.js";
import { CronDaemon } from "../cron/CronDaemon.js";
import { parseCronExpression, nextRunAfter } from "../cron/CronParser.js";
import type { CronEntry } from "../cron/types.js";
// ISS-031: sourced from config/paths.ts, not redefined locally.
import { STATE_DIR, INBOX_DIR } from "../config/paths.js";
import { promptYesNo } from "./prompt.js";

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("en-CA", { hour12: false });
}

function printEntry(e: CronEntry): void {
  const status = e.enabled ? "enabled" : "disabled";
  console.log(`  [${e.id}] ${e.name}`);
  console.log(`       schedule : ${e.schedule}`);
  console.log(`       skill    : ${e.skill}`);
  console.log(`       subject  : ${e.subject}`);
  console.log(`       status   : ${status}  |  runs: ${e.run_count}  fails: ${e.fail_count}`);
  console.log(`       next_run : ${formatDate(e.next_run)}`);
  console.log(`       last_run : ${formatDate(e.last_run)}`);
}

export async function runCron(args: string[]): Promise<void> {
  const registry = new CronRegistry(STATE_DIR);
  const subcmd = args[0];

  switch (subcmd) {
    case "add": {
      // wire cron add "<schedule>" <skill> "<subject>" [--name <name>]
      // e.g. wire cron add "0 8 * * 1" summarize "weekly status" --name weekly
      const scheduleArg = args[1];
      const skillArg    = args[2];
      const subjectArg  = args[3];

      if (!scheduleArg || !skillArg || !subjectArg) {
        console.error('Usage: wire cron add "<schedule>" <skill> "<subject>" [--name <name>]');
        console.error('Example: wire cron add "0 8 * * 1" summarize "weekly status" --name weekly');
        process.exit(1);
      }

      const nameIdx = args.indexOf("--name");
      const name = nameIdx !== -1 && args[nameIdx + 1]
        ? args[nameIdx + 1]!
        : `cron-${Date.now()}`;

      const domainIdx = args.indexOf("--domain");
      const domain = domainIdx !== -1 && args[domainIdx + 1]
        ? args[domainIdx + 1]!.split(",")
        : ["general"];

      // Validate cron expression before passing to registry
      try {
        parseCronExpression(scheduleArg);
      } catch (e) {
        console.error(`Invalid cron expression: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      try {
        const entry = registry.add({
          name,
          schedule: scheduleArg,
          skill: skillArg as import("../types.js").SkillType,
          subject: subjectArg,
          domain,
          enabled: true,
        });
        console.log(`Created cron job [${entry.id}] "${entry.name}"`);
        console.log(`  next run: ${formatDate(entry.next_run)}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }

    case "list": {
      const jobs = registry.list();
      if (jobs.length === 0) {
        console.log("No cron jobs scheduled. Add one: wire cron add \"<schedule>\" <skill> \"<subject>\"");
        break;
      }
      console.log(`\nCron jobs (${jobs.length}):\n`);
      for (const job of jobs) {
        printEntry(job);
        console.log("");
      }
      break;
    }

    case "del":
    case "delete":
    case "rm": {
      const idOrName = args[1];
      if (!idOrName) {
        console.error("Usage: wire cron del <id|name>");
        process.exit(1);
      }
      const id = parseInt(idOrName, 10);
      const entry = isNaN(id)
        ? registry.getByName(idOrName)
        : registry.get(id);

      if (!entry) {
        console.error(`Cron job not found: ${idOrName}`);
        process.exit(1);
      }

      // Confirm before deleting
      if (!(await promptYesNo(`Delete cron job [${entry.id}] "${entry.name}"?`))) {
        console.log("Cancelled.");
        break;
      }

      registry.remove(entry.id);
      console.log(`Deleted cron job [${entry.id}] "${entry.name}"`);
      break;
    }

    case "run": {
      // Manually trigger a cron job immediately
      const idOrName = args[1];
      if (!idOrName) {
        console.error("Usage: wire cron run <id|name>");
        process.exit(1);
      }
      const id = parseInt(idOrName, 10);
      const entry = isNaN(id)
        ? registry.getByName(idOrName)
        : registry.get(id);

      if (!entry) {
        console.error(`Cron job not found: ${idOrName}`);
        process.exit(1);
      }

      // Force next_run to now so daemon picks it up immediately
      console.log(`Running cron job [${entry.id}] "${entry.name}" immediately…`);
      registry.setNextRunNow(entry.id);
      const daemon = new CronDaemon({ stateDir: STATE_DIR, inboxDir: INBOX_DIR });
      await daemon.runNow();
      break;
    }

    case "next": {
      // Preview next run time for a cron expression
      const expr = args[1];
      if (!expr) {
        console.error('Usage: wire cron next "<schedule>"');
        process.exit(1);
      }
      try {
        const next = nextRunAfter(expr);
        console.log(`Next run: ${formatDate(next)}`);
      } catch (e) {
        console.error(`Invalid expression: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.log("Usage: wire cron <add|list|del|run|next>");
      console.log("  add \"<schedule>\" <skill> \"<subject>\" [--name <name>] [--domain d1,d2]");
      console.log("  list");
      console.log("  del <id|name>");
      console.log("  run <id|name>         — trigger immediately");
      console.log('  next "<schedule>"     — preview next run time');
      break;
  }
}
