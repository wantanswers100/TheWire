import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildMessage, serializeMessage, wireFilename } from "../envelope/encode.js";
import type { SkillType } from "../types.js";
import { CronRegistry } from "./CronRegistry.js";
import type { CronEntry } from "./types.js";

export interface CronDaemonConfig {
  stateDir: string;
  inboxDir: string;
  pollIntervalMs?: number;
}

export class CronDaemon {
  private registry: CronRegistry;
  private inboxDir: string;
  private pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(config: CronDaemonConfig) {
    this.registry = new CronRegistry(config.stateDir);
    this.inboxDir = config.inboxDir;
    this.pollIntervalMs = config.pollIntervalMs ?? 60_000;
  }

  get registry_(): CronRegistry {
    return this.registry;
  }

  isRunning(): boolean {
    return this._running;
  }

  start(): void {
    // No-op in test environment — prevents hanging timers in bun test runner
    if (process.env["WIRE_TEST"] === "1") return;
    if (this._running) return;

    this._running = true;
    // Run immediately on start to catch any overdue jobs
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._running = false;
  }

  // runNow() — trigger a tick immediately (e.g. from cron-cmd 'run')
  async runNow(): Promise<void> {
    return this.tick();
  }

  private async tick(): Promise<void> {
    let due: CronEntry[];
    try {
      due = this.registry.listDue(Date.now());
    } catch (err) {
      console.error(`[cron] listDue failed: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const job of due) {
      await this.dispatch(job);
    }
  }

  private async dispatch(job: CronEntry): Promise<void> {
    const runId = this.registry.recordRunStart(job.id);

    try {
      mkdirSync(this.inboxDir, { recursive: true });

      const msg = await buildMessage({
        from: "system",
        to: "claude",
        type: "task",
        skill: job.skill as SkillType,
        payload: {
          format: "task",
          verb: "execute",
          domain: job.domain,
          subject: job.subject,
          constraints: { source: "cron", cron_name: job.name, cron_id: String(job.id) },
          output: { format: "prose" },
        },
      });

      const filename = wireFilename(msg);
      const filepath = join(this.inboxDir, filename);

      // Advance before writing — prevents re-fire if writeFileSync throws
      this.registry.advanceNextRun(job.id, job.schedule);
      writeFileSync(filepath, serializeMessage(msg), "utf8");
      this.registry.recordRunComplete(runId, msg.id);

      console.log(`[cron] dispatched '${job.name}' → ${filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cron] failed to dispatch '${job.name}': ${message}`);
      this.registry.incrementFailCount(job.id);
      this.registry.recordRunComplete(runId, null, message);
    }
  }
}
