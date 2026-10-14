// SkillCapture — builds OutcomeRecord from dispatch results, injects into SkillRegistry
//
// This is the bridge between dispatch/loop.ts (via onOutcome callback) and SkillRegistry.
// It must not be imported from loop.ts directly — injected via LoopConfig.onOutcome.

import { SkillRegistry } from "./SkillRegistry.js";
import { SkillCompressor } from "./SkillCompressor.js";
import type { OutcomeRecord } from "../types.js";

const COMPRESSION_BATCH = 50;

export class SkillCapture {
  private registry: SkillRegistry;
  private compressor: SkillCompressor;

  constructor(stateDir: string) {
    this.registry = new SkillRegistry(stateDir);
    this.compressor = new SkillCompressor(this.registry);
  }

  // Returns a bound function suitable for LoopConfig.onOutcome injection
  asHook(): (record: OutcomeRecord) => Promise<void> {
    return (record: OutcomeRecord) => this.capture(record);
  }

  async capture(record: OutcomeRecord): Promise<void> {
    this.registry.record(record);

    // Fire compression detached — never await inline (15s timeout inside compressor)
    const pending = this.registry.pendingCompression(record.skill, COMPRESSION_BATCH);
    if (pending.length >= COMPRESSION_BATCH) {
      void this.compressor.compress(record.skill, pending);
    }
  }

  stats(skill: string) {
    return this.registry.stats(skill);
  }
}
